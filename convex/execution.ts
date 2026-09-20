import { v } from "convex/values";
import {
  vWorkflowId,
  vResultValidator,
  type WorkflowId,
} from "@convex-dev/workflow";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  bounded,
  fail,
  requireAdmin,
  requireInternalMember,
  requireMember,
  requireOwnerRecord,
} from "./lib/auth";
import { delivery, contextRef } from "./executionSchema";
import {
  reserveCostMicros,
  configuredModels,
  getModel,
} from "../lib/ai/routing";
import { runContextVisible } from "./lib/knowledgeAccess";
import {
  createTaskConversation,
  appendTaskResponse,
  redactTaskConversation,
} from "./lib/conversations";
import {
  workflow,
  DEFAULT_POLICY,
  MAX_OUTPUT_TOKENS,
  MAX_TASK_MICROS,
  TASK_TIMEOUT_MS,
  APPROVAL_TIMEOUT_MS,
  billingPeriod,
  canReserve,
  safeMicros,
  validRecipient,
  type ModelDispatch,
  type ModelResult,
  type ExternalDispatch,
  type ExternalResult,
} from "./lib/workflow";

type ReadCtx = QueryCtx | MutationCtx;
type Task = Doc<"taskRuns">;
const modelResult = v.union(
  v.object({
    status: v.literal("succeeded"),
    text: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costMicros: v.number(),
    providerRequestId: v.optional(v.string()),
    contextRefs: v.optional(v.array(contextRef)),
    contextInvalidated: v.optional(v.boolean()),
  }),
  v.object({
    status: v.union(v.literal("failed"), v.literal("uncertain")),
    detail: v.string(),
    errorCode: v.optional(v.string()),
  }),
);
const externalResult = v.object({
  status: v.union(
    v.literal("submitted"),
    v.literal("uncertain"),
    v.literal("failed"),
  ),
  providerId: v.optional(v.string()),
  detail: v.optional(v.string()),
});
async function getPolicy(ctx: ReadCtx, workspaceId: Id<"workspaces">) {
  return (
    (await ctx.db
      .query("executionPolicies")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique()) ?? {
      ...DEFAULT_POLICY,
      allowedModelIds: configuredModels(process.env.ANTHROPIC_MODELS_JSON).map(
        (model) => model.id,
      ),
    }
  );
}
async function budget(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  scope: string,
  period: string,
) {
  return ctx.db
    .query("executionBudgets")
    .withIndex("by_scope", (q) =>
      q.eq("workspaceId", workspaceId).eq("scope", scope).eq("period", period),
    )
    .unique();
}
async function event(
  ctx: MutationCtx,
  task: Task,
  type: string,
  detail?: string,
  actorId?: Id<"users">,
) {
  await ctx.db.insert("executionEvents", {
    workspaceId: task.workspaceId,
    ownerId: task.ownerId,
    taskId: task._id,
    type,
    createdAt: Date.now(),
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
    ...(actorId ? { actorId } : {}),
  });
}
async function settle(ctx: MutationCtx, task: Task, actual: number | null) {
  if (!task.reservationId) return;
  const reservation = await ctx.db.get(task.reservationId);
  if (!reservation || !["reserved", "uncertain"].includes(reservation.state))
    return;
  if (actual !== null && !safeMicros(actual)) fail("Invalid usage settlement.");
  for (const scope of ["workspace", `user:${task.ownerId}`]) {
    const bucket = await budget(
      ctx,
      task.workspaceId,
      scope,
      reservation.period,
    );
    if (!bucket || bucket.reservedMicros < reservation.reservedMicros)
      fail("Budget ledger requires reconciliation.");
    await ctx.db.patch(bucket._id, {
      reservedMicros: bucket.reservedMicros - reservation.reservedMicros,
      spentMicros: bucket.spentMicros + (actual ?? 0),
    });
  }
  await ctx.db.patch(reservation._id, {
    state: actual === null ? "released" : "settled",
    ...(actual !== null ? { settledMicros: actual } : {}),
    settledAt: Date.now(),
  });
}
async function uncertain(ctx: MutationCtx, task: Task, detail: string) {
  if (task.reservationId) {
    const reservation = await ctx.db.get(task.reservationId);
    if (reservation?.state === "reserved")
      await ctx.db.patch(reservation._id, { state: "uncertain" });
  }
  await ctx.db.patch(task._id, {
    state: "needs_reconciliation",
    active: false,
    detail,
    updatedAt: Date.now(),
  });
  await event(ctx, task, "reconciliation_required", detail);
}
async function enqueue(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    ownerId: Id<"users">;
    prompt: string;
    model: string;
    delivery?: { to: string; subject: string };
    routineId?: Id<"executionRoutines">;
    recoveryCount?: number;
  },
): Promise<Id<"taskRuns">> {
  const { workspace } = await requireInternalMember(
    ctx,
    args.workspaceId,
    args.ownerId,
  );
  const prompt = bounded(args.prompt, 16_000, "Task");
  const policy = await getPolicy(ctx, args.workspaceId);
  if (!policy.allowedModelIds.includes(args.model))
    fail("This model is not allowed in the workspace.");
  const amount = reserveCostMicros(
    getModel(args.model, configuredModels(process.env.ANTHROPIC_MODELS_JSON)),
    prompt,
    MAX_OUTPUT_TOKENS,
    16_384,
  );
  if (!safeMicros(amount) || amount <= 0 || amount > MAX_TASK_MICROS)
    fail("This task exceeds the per-task spending ceiling.");
  const target = args.delivery
    ? {
        to: args.delivery.to.trim(),
        subject: bounded(args.delivery.subject, 200, "Subject"),
      }
    : undefined;
  if (
    target &&
    (!policy.allowEmail ||
      !validRecipient(target.to) ||
      /[\r\n]/.test(target.subject))
  )
    fail("Email delivery is unavailable or its recipient is invalid.");
  const ownerActive = await ctx.db
    .query("taskRuns")
    .withIndex("by_owner_active", (q) =>
      q
        .eq("workspaceId", args.workspaceId)
        .eq("ownerId", args.ownerId)
        .eq("active", true),
    )
    .take(3);
  const workspaceActive = await ctx.db
    .query("taskRuns")
    .withIndex("by_workspace_active", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("active", true),
    )
    .take(20);
  if (ownerActive.length >= 3 || workspaceActive.length >= 20)
    fail("Concurrent task limit reached. Finish or cancel an existing task.");
  const now = Date.now(),
    period = billingPeriod(now);
  const buckets = [];
  for (const [scope, limit] of [
    ["workspace", policy.monthlyWorkspaceMicros],
    [`user:${args.ownerId}`, policy.monthlyUserMicros],
  ] as const) {
    const existing = await budget(ctx, args.workspaceId, scope, period);
    if (
      !canReserve(
        existing?.spentMicros ?? 0,
        existing?.reservedMicros ?? 0,
        amount,
        limit,
      )
    )
      fail("The monthly spending limit has been reached.");
    buckets.push({ scope, existing });
  }
  const taskId = await ctx.db.insert("taskRuns", {
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    prompt,
    model: args.model,
    state: "queued",
    active: true,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + TASK_TIMEOUT_MS,
    modelDispatch: "not_started",
    recoveryCount: args.recoveryCount ?? 0,
    ...(target ? { delivery: target } : {}),
    ...(args.routineId ? { routineId: args.routineId } : {}),
  });
  await createTaskConversation(ctx, {
    taskId,
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    prompt,
  });
  const reservationId = await ctx.db.insert("executionReservations", {
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    taskId,
    period,
    reservedMicros: amount,
    state: "reserved",
    createdAt: now,
  });
  for (const { scope, existing } of buckets) {
    if (existing)
      await ctx.db.patch(existing._id, {
        reservedMicros: existing.reservedMicros + amount,
      });
    else
      await ctx.db.insert("executionBudgets", {
        workspaceId: args.workspaceId,
        scope,
        period,
        reservedMicros: amount,
        spentMicros: 0,
      });
  }
  await ctx.db.patch(taskId, { reservationId });
  const workflowId = await workflow.start(
    ctx,
    internal.execution.taskWorkflow,
    { taskId },
    {
      startAsync: true,
      onComplete: internal.execution.onComplete,
      context: { taskId },
    },
  );
  await ctx.db.patch(taskId, { workflowId });
  await ctx.scheduler.runAt(
    now + TASK_TIMEOUT_MS,
    internal.execution.expireTask,
    { taskId },
  );
  await ctx.scheduler.runAt(
    now + workspace.retentionDays * 86400000,
    internal.execution.expireContent,
    { taskId },
  );
  await event(ctx, (await ctx.db.get(taskId))!, "queued");
  return taskId;
}

export const start = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    prompt: v.string(),
    model: v.string(),
    delivery: v.optional(delivery),
  },
  handler: async (ctx, args): Promise<Id<"taskRuns">> => {
    const { user } = await requireMember(ctx, args.workspaceId);
    return enqueue(ctx, { ...args, ownerId: user._id });
  },
});
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId);
    const tasks = await ctx.db
      .query("taskRuns")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .order("desc")
      .take(100);
    const visible = [];
    for (const { prompt, result, ...task } of tasks)
      if (
        !task.contentClearedAt &&
        task.createdAt + workspace.retentionDays * 86400000 > Date.now()
      )
        visible.push({
          ...task,
          title: prompt.slice(0, 160),
          hasResult:
            Boolean(result) &&
            (await runContextVisible(
              ctx,
              task.workspaceId,
              task.ownerId,
              task.contextRefs ?? [],
            )),
        });
    return visible;
  },
});
export const get = query({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    const { workspace } = await requireOwnerRecord(ctx, task);
    if (
      !task ||
      task.contentClearedAt ||
      task.createdAt + workspace.retentionDays * 86400000 <= Date.now()
    )
      fail("This task content has expired.");
    const contextAvailable = await runContextVisible(
      ctx,
      task!.workspaceId,
      task!.ownerId,
      task!.contextRefs ?? [],
    );
    return {
      ...task!,
      result: contextAvailable ? task!.result : undefined,
      contextAvailable,
      approval: await ctx.db
        .query("executionApprovals")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .unique(),
      intent:
        contextAvailable && task!.intentId
          ? await ctx.db.get(task!.intentId)
          : null,
      events: await ctx.db
        .query("executionEvents")
        .withIndex("by_task", (q) => q.eq("taskId", taskId))
        .order("desc")
        .take(50),
    };
  },
});
export const policy = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireMember(ctx, workspaceId),
      current = await getPolicy(ctx, workspaceId),
      period = billingPeriod(Date.now());
    const pick = (value: Awaited<ReturnType<typeof budget>>) => ({
      spentMicros: value?.spentMicros ?? 0,
      reservedMicros: value?.reservedMicros ?? 0,
    });
    return {
      allowedModels: current.allowedModelIds,
      defaultModel: current.allowedModelIds[0] ?? "",
      monthlyWorkspaceMicros: current.monthlyWorkspaceMicros,
      monthlyUserMicros: current.monthlyUserMicros,
      allowEmail: current.allowEmail,
      period,
      usage: {
        workspace: pick(await budget(ctx, workspaceId, "workspace", period)),
        user: pick(await budget(ctx, workspaceId, `user:${user._id}`, period)),
      },
    };
  },
});
export const updatePolicy = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    allowedModels: v.array(v.string()),
    monthlyWorkspaceMicros: v.number(),
    monthlyUserMicros: v.number(),
    allowEmail: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.workspaceId);
    const serverModels = configuredModels(
      process.env.ANTHROPIC_MODELS_JSON,
    ).map((model) => model.id);
    if (
      args.allowedModels.length > serverModels.length ||
      new Set(args.allowedModels).size !== args.allowedModels.length ||
      args.allowedModels.some((model) => !serverModels.includes(model))
    )
      fail("Choose supported model IDs.");
    if (
      !safeMicros(args.monthlyWorkspaceMicros) ||
      !safeMicros(args.monthlyUserMicros)
    )
      fail("Spending limits must be nonnegative integer microdollars.");
    const existing = await ctx.db
      .query("executionPolicies")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const data = {
      workspaceId: args.workspaceId,
      allowedModelIds: args.allowedModels,
      monthlyWorkspaceMicros: args.monthlyWorkspaceMicros,
      monthlyUserMicros: args.monthlyUserMicros,
      allowEmail: args.allowEmail,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert("executionPolicies", data);
  },
});

export const claimModelDispatch = internalMutation({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }): Promise<ModelDispatch | null> => {
    const task = await ctx.db.get(taskId);
    if (
      !task ||
      !task.active ||
      task.modelDispatch !== "not_started" ||
      task.stopReason
    )
      return null;
    await requireInternalMember(ctx, task.workspaceId, task.ownerId);
    const policy = await getPolicy(ctx, task.workspaceId);
    if (
      Date.now() >= task.deadlineAt ||
      !policy.allowedModelIds.includes(task.model)
    )
      fail("Task expired or model access was revoked.");
    const reservation = task.reservationId
      ? await ctx.db.get(task.reservationId)
      : null;
    if (!reservation || reservation.state !== "reserved")
      fail("A valid spending reservation is required.");
    // Lowered policies apply to queued work too. Existing reservations remain accounted for.
    for (const [scope, limit] of [
      ["workspace", policy.monthlyWorkspaceMicros],
      [`user:${task.ownerId}`, policy.monthlyUserMicros],
    ] as const) {
      const current = await budget(
        ctx,
        task.workspaceId,
        scope,
        reservation.period,
      );
      if (!current || current.spentMicros + current.reservedMicros > limit)
        fail("Spending access changed before dispatch.");
    }
    await ctx.db.patch(taskId, {
      state: "running",
      modelDispatch: "started",
      modelDispatchedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await event(ctx, task, "model_dispatch_claimed");
    return {
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      prompt: task.prompt,
      model: task.model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxCostMicros: reservation.reservedMicros,
      idempotencyKey: `harbor-model-${taskId}`,
      allowedModelIds: policy.allowedModelIds,
      allowedProviders: ["anthropic"],
    };
  },
});

// A claim is one-use; this read only revalidates it after context/profile awaits.
export const validateModelDispatch = internalQuery({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }): Promise<boolean> => {
    const task = await ctx.db.get(taskId);
    if (
      !task ||
      !task.active ||
      task.modelDispatch !== "started" ||
      task.stopReason ||
      Date.now() >= task.deadlineAt
    )
      return false;
    try {
      await requireInternalMember(ctx, task.workspaceId, task.ownerId);
    } catch {
      return false;
    }
    const policy = await getPolicy(ctx, task.workspaceId);
    if (!policy.allowedModelIds.includes(task.model)) return false;
    const reservation = task.reservationId
      ? await ctx.db.get(task.reservationId)
      : null;
    if (!reservation || reservation.state !== "reserved") return false;
    for (const [scope, limit] of [
      ["workspace", policy.monthlyWorkspaceMicros],
      [`user:${task.ownerId}`, policy.monthlyUserMicros],
    ] as const) {
      const current = await budget(
        ctx,
        task.workspaceId,
        scope,
        reservation.period,
      );
      if (!current || current.spentMicros + current.reservedMicros > limit)
        return false;
    }
    return true;
  },
});

export const finishModel = internalMutation({
  args: { taskId: v.id("taskRuns"), result: modelResult },
  handler: async (
    ctx,
    { taskId, result },
  ): Promise<Id<"externalActionIntents"> | null> => {
    const task = await ctx.db.get(taskId);
    if (!task || task.modelDispatch === "settled")
      return task?.intentId ?? null;
    if (result.status !== "succeeded") {
      if (task.modelDispatch === "started")
        await uncertain(
          ctx,
          task,
          "Model dispatch has no confirmed usage receipt. Review the provider record before retrying.",
        );
      else {
        await settle(ctx, task, null);
        await ctx.db.patch(taskId, {
          state: task.stopReason ?? "failed",
          active: false,
          detail: result.detail.slice(0, 300),
          updatedAt: Date.now(),
        });
      }
      return null;
    }
    if (
      task.modelDispatch !== "started" ||
      result.provider !== "anthropic" ||
      result.model !== task.model ||
      !safeMicros(result.costMicros) ||
      !Number.isSafeInteger(result.inputTokens) ||
      result.inputTokens < 0 ||
      !Number.isSafeInteger(result.outputTokens) ||
      result.outputTokens < 0 ||
      result.text.length > 100_000
    )
      fail("Invalid model receipt.");
    await settle(ctx, task, result.costMicros);
    await ctx.db.patch(taskId, {
      modelDispatch: "settled",
      costMicros: result.costMicros,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ...(result.providerRequestId
        ? { providerRequestId: result.providerRequestId.slice(0, 200) }
        : {}),
      updatedAt: Date.now(),
    });
    let permitted = result.contextInvalidated !== true;
    try {
      await requireInternalMember(ctx, task.workspaceId, task.ownerId);
    } catch {
      permitted = false;
    }
    const currentPolicy = await getPolicy(ctx, task.workspaceId);
    const refs = result.contextRefs ?? [];
    if (
      permitted &&
      !(await runContextVisible(ctx, task.workspaceId, task.ownerId, refs))
    )
      permitted = false;
    if (
      !permitted ||
      task.stopReason ||
      Date.now() >= task.deadlineAt ||
      !currentPolicy.allowedModelIds.includes(task.model)
    ) {
      await ctx.db.patch(taskId, {
        state: task.stopReason ?? "canceled",
        active: false,
        detail: "Usage recorded; task stopped before publishing its result.",
      });
      return null;
    }
    await ctx.db.patch(taskId, { result: result.text, contextRefs: refs });
    await appendTaskResponse(ctx, taskId, result.text, refs);
    await event(ctx, task, "model_usage_settled");
    if (!task.delivery) {
      await ctx.db.patch(taskId, { state: "succeeded", active: false });
      return null;
    }
    if (!currentPolicy.allowEmail) {
      await ctx.db.patch(taskId, {
        state: "failed",
        active: false,
        detail: "Email delivery was disabled. The draft is available.",
      });
      return null;
    }
    const now = Date.now();
    const intentId = await ctx.db.insert("externalActionIntents", {
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      taskId,
      kind: "email",
      provider: "resend",
      ...task.delivery,
      text: result.text,
      contextRefs: refs,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("executionApprovals", {
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      taskId,
      intentId,
      status: "pending",
      createdAt: now,
      expiresAt: Math.min(task.deadlineAt, now + APPROVAL_TIMEOUT_MS),
    });
    await ctx.db.patch(taskId, { state: "awaiting_approval", intentId });
    await ctx.scheduler.runAt(
      Math.min(task.deadlineAt, now + APPROVAL_TIMEOUT_MS),
      internal.execution.expireApproval,
      { taskId },
    );
    return intentId;
  },
});

export const approve = mutation({
  args: { taskId: v.id("taskRuns"), approve: v.boolean() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    const { user } = await requireOwnerRecord(ctx, task);
    const approval = await ctx.db
      .query("executionApprovals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (
      !task?.workflowId ||
      task.state !== "awaiting_approval" ||
      !approval ||
      approval.status !== "pending" ||
      Date.now() >= approval.expiresAt ||
      Date.now() >= task.deadlineAt
    )
      fail("This approval is no longer available.");
    if (
      args.approve &&
      !(await runContextVisible(
        ctx,
        task.workspaceId,
        task.ownerId,
        task.contextRefs ?? [],
      ))
    )
      fail(
        "The draft context changed. Create a fresh task before approving delivery.",
      );
    if (args.approve && !(await getPolicy(ctx, task.workspaceId)).allowEmail)
      fail("Email delivery is disabled.");
    await ctx.db.patch(approval._id, {
      status: args.approve ? "approved" : "rejected",
      decidedAt: Date.now(),
    });
    await ctx.db.patch(approval.intentId, {
      status: args.approve ? "approved" : "canceled",
      updatedAt: Date.now(),
    });
    if (!args.approve)
      await ctx.db.patch(task._id, {
        state: "canceled",
        active: false,
        detail: "Delivery was declined; the draft remains available.",
        updatedAt: Date.now(),
      });
    await event(
      ctx,
      task,
      args.approve ? "delivery_approved" : "delivery_rejected",
      undefined,
      user._id,
    );
    await workflow.sendEvent(ctx, {
      workflowId: task.workflowId as WorkflowId,
      name: "delivery-approval-v1",
      value: { approved: args.approve },
    });
  },
});
export const claimExternalDispatch = internalMutation({
  args: { intentId: v.id("externalActionIntents") },
  handler: async (ctx, { intentId }): Promise<ExternalDispatch | null> => {
    const intent = await ctx.db.get(intentId);
    if (!intent || intent.status !== "approved") return null;
    const task = await ctx.db.get(intent.taskId);
    if (!task || !task.active || task.stopReason || task.intentId !== intentId)
      return null;
    await requireInternalMember(ctx, intent.workspaceId, intent.ownerId);
    if (
      !(await runContextVisible(
        ctx,
        intent.workspaceId,
        intent.ownerId,
        intent.contextRefs ?? [],
      ))
    )
      fail("The approved draft context is no longer available.");
    const approval = await ctx.db
      .query("executionApprovals")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .unique();
    if (
      !approval ||
      approval.intentId !== intentId ||
      approval.status !== "approved" ||
      Date.now() >= approval.expiresAt ||
      Date.now() >= task.deadlineAt ||
      !(await getPolicy(ctx, task.workspaceId)).allowEmail
    )
      fail("Delivery approval or workspace access expired.");
    await ctx.db.patch(intentId, {
      status: "dispatching",
      dispatchedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(task._id, { state: "running", updatedAt: Date.now() });
    await event(ctx, task, "external_dispatch_claimed");
    return {
      workspaceId: intent.workspaceId,
      ownerId: intent.ownerId,
      to: intent.to,
      subject: intent.subject,
      text: intent.text,
      idempotencyKey: `harbor-email-${intentId}`,
    };
  },
});
export const finishExternal = internalMutation({
  args: { intentId: v.id("externalActionIntents"), result: externalResult },
  handler: async (ctx, { intentId, result }) => {
    const intent = await ctx.db.get(intentId);
    if (!intent || ["submitted", "failed", "canceled"].includes(intent.status))
      return;
    const task = await ctx.db.get(intent.taskId);
    if (!task) return;
    if (
      result.status === "submitted" &&
      result.providerId &&
      ["dispatching", "uncertain"].includes(intent.status)
    ) {
      await ctx.db.patch(intentId, {
        status: "submitted",
        providerId: result.providerId.slice(0, 200),
        detail: "Provider accepted the email. Delivery is not yet verified.",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(task._id, {
        state: task.stopReason ?? "succeeded",
        active: false,
        detail: task.stopReason
          ? "Email was already submitted before the stop request completed."
          : "Email submitted to the provider; delivery is not verified.",
        updatedAt: Date.now(),
      });
      await event(ctx, task, "external_submitted");
    } else if (["dispatching", "uncertain"].includes(intent.status)) {
      await ctx.db.patch(intentId, {
        status: "uncertain",
        detail: "Submission outcome is unknown. Reconcile before retrying.",
        updatedAt: Date.now(),
      });
      await uncertain(
        ctx,
        task,
        "Email submission may have occurred. Do not send it again until reconciled.",
      );
    } else {
      await ctx.db.patch(intentId, {
        status: "failed",
        detail: result.detail?.slice(0, 300) ?? "Email was not dispatched.",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(task._id, {
        state: "failed",
        active: false,
        detail: "Email was not dispatched.",
        updatedAt: Date.now(),
      });
    }
  },
});

export const taskWorkflow = workflow
  .define({ args: { taskId: v.id("taskRuns") }, returns: v.null() })
  .handler(async (step, { taskId }): Promise<null> => {
    const generated: ModelResult = await step.runAction(
      internal.ai.generateTask,
      { taskId },
      { retry: false, name: "generate-task-v1" },
    );
    const intentId: Id<"externalActionIntents"> | null = await step.runMutation(
      internal.execution.finishModel,
      { taskId, result: generated },
      { name: "settle-model-v1" },
    );
    if (!intentId) return null;
    const approval = await step.awaitEvent({
      name: "delivery-approval-v1",
      validator: v.object({ approved: v.boolean() }),
    });
    if (!approval.approved) return null;
    const result: ExternalResult = await step.runAction(
      internal.integrations.sendIntent,
      { intentId },
      { retry: false, name: "submit-email-v1" },
    );
    await step.runMutation(
      internal.execution.finishExternal,
      { intentId, result },
      { name: "settle-email-v1" },
    );
    return null;
  });

async function stop(
  ctx: MutationCtx,
  task: Task,
  reason: "canceled" | "timed_out",
) {
  if (!task.active) return;
  const intent = task.intentId ? await ctx.db.get(task.intentId) : null;
  const approval = await ctx.db
    .query("executionApprovals")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .unique();
  await ctx.db.patch(task._id, { stopReason: reason, updatedAt: Date.now() });
  if (approval?.status === "pending")
    await ctx.db.patch(approval._id, {
      status: reason === "timed_out" ? "expired" : "canceled",
      decidedAt: Date.now(),
    });
  if (intent && ["prepared", "approved"].includes(intent.status))
    await ctx.db.patch(intent._id, {
      status: "canceled",
      updatedAt: Date.now(),
    });
  if (task.modelDispatch === "started" || intent?.status === "dispatching") {
    if (intent?.status === "dispatching")
      await ctx.db.patch(intent._id, {
        status: "uncertain",
        updatedAt: Date.now(),
      });
    await uncertain(
      ctx,
      task,
      "Stop requested after a provider dispatch. Its outcome must be reconciled.",
    );
  } else {
    await settle(ctx, task, null);
    await ctx.db.patch(task._id, { state: reason, active: false });
  }
  await event(ctx, task, reason);
  if (task.workflowId)
    await workflow.cancel(ctx, task.workflowId as WorkflowId);
}
export const cancel = mutation({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    await requireOwnerRecord(ctx, task);
    await stop(ctx, task!, "canceled");
  },
});
export const expireTask = internalMutation({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (task && Date.now() >= task.deadlineAt)
      await stop(ctx, task, "timed_out");
  },
});
export const expireApproval = internalMutation({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    const approval = await ctx.db
      .query("executionApprovals")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .unique();
    if (
      task &&
      approval?.status === "pending" &&
      Date.now() >= approval.expiresAt
    )
      await stop(ctx, task, "timed_out");
  },
});
export const onComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ taskId: v.id("taskRuns") }),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.context.taskId);
    if (!task || task.workflowId !== args.workflowId) return;
    const workspace = await ctx.db.get(task.workspaceId);
    if (
      workspace &&
      !workspace.preservationHold &&
      (await workflow.cleanup(ctx, args.workflowId))
    )
      await ctx.db.patch(task._id, { journalCleanedAt: Date.now() });
    if (!task.active) return;
    const intent = task.intentId ? await ctx.db.get(task.intentId) : null;
    if (task.modelDispatch === "started" || intent?.status === "dispatching") {
      if (intent?.status === "dispatching")
        await ctx.db.patch(intent._id, {
          status: "uncertain",
          updatedAt: Date.now(),
        });
      await uncertain(
        ctx,
        task,
        "Execution stopped without a provider receipt. Reconciliation is required.",
      );
    } else {
      await settle(ctx, task, null);
      await ctx.db.patch(task._id, {
        state: task.stopReason ?? "failed",
        active: false,
        detail:
          "Execution did not complete. No unconfirmed action will be retried automatically.",
        updatedAt: Date.now(),
      });
      if (intent && ["prepared", "approved"].includes(intent.status))
        await ctx.db.patch(intent._id, {
          status: "failed",
          updatedAt: Date.now(),
        });
    }
  },
});
export const recover = mutation({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }): Promise<Id<"taskRuns">> => {
    const task = await ctx.db.get(taskId);
    const { workspace } = await requireOwnerRecord(ctx, task);
    if (
      !task ||
      task.createdAt + workspace.retentionDays * 86400000 <= Date.now() ||
      task.active ||
      task.modelDispatch !== "not_started" ||
      task.contentClearedAt ||
      task.intentId ||
      task.recoveryCount >= 2 ||
      !["failed", "canceled", "timed_out"].includes(task.state)
    )
      fail("Only tasks that never dispatched can be recovered, at most twice.");
    const next = await enqueue(ctx, {
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      prompt: task.prompt,
      model: task.model,
      delivery: task.delivery,
      recoveryCount: task.recoveryCount + 1,
    });
    await ctx.db.patch(taskId, { recoveryCount: 2 });
    await event(ctx, task, "safe_recovery_started", String(next));
    return next;
  },
});
// Operators record independently verified receipts. This endpoint never sends or regenerates.
export const reconcile = mutation({
  args: {
    taskId: v.id("taskRuns"),
    outcome: v.union(
      v.literal("confirmed_failure"),
      v.literal("confirmed_submission"),
    ),
    costMicros: v.optional(v.number()),
    providerId: v.optional(v.string()),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) fail();
    const { user } = await requireAdmin(ctx, task.workspaceId);
    if (task.state !== "needs_reconciliation")
      fail("This task does not need reconciliation.");
    const note = bounded(args.note, 300, "Evidence reference");
    if (Date.now() < (task.modelDispatchedAt ?? task.createdAt) + 10 * 60_000)
      fail(
        "Allow the in-flight provider action to finish before reconciliation.",
      );
    const intent = task.intentId ? await ctx.db.get(task.intentId) : null;
    if (task.modelDispatch === "started") {
      if (
        !safeMicros(args.costMicros ?? -1) ||
        args.outcome !== "confirmed_failure"
      )
        fail(
          "Record verified model cost; lost model output cannot be reconstructed by a receipt.",
        );
      await settle(ctx, task, args.costMicros!);
      await ctx.db.patch(task._id, {
        modelDispatch: "settled",
        costMicros: args.costMicros,
      });
    } else if (intent?.status === "uncertain") {
      if (Date.now() < (intent.dispatchedAt ?? intent.createdAt) + 10 * 60_000)
        fail(
          "Allow the in-flight delivery action to finish before reconciliation.",
        );
      if (args.outcome === "confirmed_submission" && !args.providerId?.trim())
        fail("A provider receipt ID is required.");
      await ctx.db.patch(intent._id, {
        status:
          args.outcome === "confirmed_submission" ? "submitted" : "failed",
        ...(args.providerId
          ? { providerId: bounded(args.providerId, 200, "Provider receipt") }
          : {}),
        updatedAt: Date.now(),
      });
    } else fail("No uncertain dispatch is available.");
    await ctx.db.patch(task._id, {
      state: args.outcome === "confirmed_submission" ? "succeeded" : "failed",
      active: false,
      detail: "An administrator recorded a verified provider outcome.",
      updatedAt: Date.now(),
    });
    await event(ctx, task, "operator_reconciled", note, user._id);
  },
});

export const listRoutines = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireMember(ctx, workspaceId);
    return ctx.db
      .query("executionRoutines")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .take(100);
  },
});
export const createRoutine = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    prompt: v.string(),
    model: v.string(),
    intervalMinutes: v.optional(v.number()),
    eventKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"executionRoutines">> => {
    const { user } = await requireMember(ctx, args.workspaceId);
    if ((args.intervalMinutes === undefined) === (args.eventKey === undefined))
      fail("Choose either an interval or an event trigger.");
    if (
      args.intervalMinutes !== undefined &&
      (!Number.isSafeInteger(args.intervalMinutes) ||
        args.intervalMinutes < 60 ||
        args.intervalMinutes > 10080)
    )
      fail("Routine intervals must be 60–10080 minutes.");
    const existing = await ctx.db
      .query("executionRoutines")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
      )
      .take(50);
    if (existing.length >= 50) fail("Routine limit reached.");
    if (
      !(await getPolicy(ctx, args.workspaceId)).allowedModelIds.includes(
        args.model,
      )
    )
      fail("This model is unavailable.");
    const now = Date.now(),
      nextRunAt = args.intervalMinutes
        ? now + args.intervalMinutes * 60000
        : undefined;
    const routineId = await ctx.db.insert("executionRoutines", {
      workspaceId: args.workspaceId,
      ownerId: user._id,
      name: bounded(args.name, 100, "Name"),
      prompt: bounded(args.prompt, 16000, "Task"),
      model: args.model,
      ...(args.intervalMinutes
        ? { intervalMinutes: args.intervalMinutes, nextRunAt }
        : {}),
      ...(args.eventKey !== undefined
        ? { eventKey: bounded(args.eventKey, 100, "Event key") }
        : {}),
      enabled: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    if (nextRunAt)
      await ctx.scheduler.runAt(nextRunAt, internal.execution.tickRoutine, {
        routineId,
        revision: 1,
        dueAt: nextRunAt,
      });
    return routineId;
  },
});
export const setRoutineEnabled = mutation({
  args: { routineId: v.id("executionRoutines"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const routine = await ctx.db.get(args.routineId);
    await requireOwnerRecord(ctx, routine);
    if (!routine) fail();
    const revision = routine.revision + 1,
      nextRunAt =
        args.enabled && routine.intervalMinutes
          ? Date.now() + routine.intervalMinutes * 60000
          : undefined;
    await ctx.db.patch(routine._id, {
      enabled: args.enabled,
      revision,
      nextRunAt,
      updatedAt: Date.now(),
    });
    if (nextRunAt)
      await ctx.scheduler.runAt(nextRunAt, internal.execution.tickRoutine, {
        routineId: routine._id,
        revision,
        dueAt: nextRunAt,
      });
  },
});
async function runRoutine(
  ctx: MutationCtx,
  routine: Doc<"executionRoutines">,
  key: string,
): Promise<Id<"taskRuns">> {
  await requireInternalMember(ctx, routine.workspaceId, routine.ownerId);
  if (!routine.enabled) fail("Routine is paused.");
  const existing = await ctx.db
    .query("executionTriggers")
    .withIndex("by_key", (q) => q.eq("routineId", routine._id).eq("key", key))
    .unique();
  if (existing) return existing.taskId;
  const taskId = await enqueue(ctx, {
    workspaceId: routine.workspaceId,
    ownerId: routine.ownerId,
    prompt: routine.prompt,
    model: routine.model,
    routineId: routine._id,
  });
  await ctx.db.insert("executionTriggers", {
    routineId: routine._id,
    key,
    taskId,
    createdAt: Date.now(),
  });
  await ctx.db.patch(routine._id, {
    lastTaskId: taskId,
    lastStatus: "queued",
    updatedAt: Date.now(),
  });
  return taskId;
}
export const triggerEvent = mutation({
  args: { routineId: v.id("executionRoutines"), eventId: v.string() },
  handler: async (ctx, args): Promise<Id<"taskRuns">> => {
    const routine = await ctx.db.get(args.routineId);
    await requireOwnerRecord(ctx, routine);
    if (!routine?.eventKey) fail("An event routine is required.");
    return runRoutine(
      ctx,
      routine,
      `event:${bounded(args.eventId, 100, "Event ID")}`,
    );
  },
});
export const runScheduledRoutine = internalMutation({
  args: {
    routineId: v.id("executionRoutines"),
    revision: v.number(),
    dueAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"taskRuns"> | null> => {
    const routine = await ctx.db.get(args.routineId);
    if (!routine || !routine.enabled || routine.revision !== args.revision)
      return null;
    return runRoutine(ctx, routine, `schedule:${args.revision}:${args.dueAt}`);
  },
});
export const tickRoutine = internalMutation({
  args: {
    routineId: v.id("executionRoutines"),
    revision: v.number(),
    dueAt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const routine = await ctx.db.get(args.routineId);
    if (
      !routine ||
      !routine.enabled ||
      routine.revision !== args.revision ||
      routine.nextRunAt !== args.dueAt ||
      !routine.intervalMinutes ||
      Date.now() < args.dueAt
    )
      return;
    const nextRunAt = Date.now() + routine.intervalMinutes * 60000;
    await ctx.db.patch(routine._id, { nextRunAt, updatedAt: Date.now() });
    await ctx.scheduler.runAt(nextRunAt, internal.execution.tickRoutine, {
      routineId: routine._id,
      revision: routine.revision,
      dueAt: nextRunAt,
    });
    try {
      await ctx.runMutation(internal.execution.runScheduledRoutine, args);
    } catch {
      await ctx.db.patch(routine._id, {
        lastStatus: "blocked",
        updatedAt: Date.now(),
      });
    }
  },
});

// Retain idempotency, budget, and provider outcome metadata while removing payloads.
async function applyContentRetention(ctx: MutationCtx, task: Task) {
  const workspace = await ctx.db.get(task.workspaceId);
  if (!workspace) return;
  if (
    !task.active &&
    task.workflowId &&
    !task.journalCleanedAt &&
    !workspace.preservationHold
  ) {
    if (await workflow.cleanup(ctx, task.workflowId as WorkflowId))
      await ctx.db.patch(task._id, { journalCleanedAt: Date.now() });
  }
  if (
    task.contentClearedAt ||
    task.createdAt + workspace.retentionDays * 86400000 > Date.now()
  )
    return;
  // This metadata write invalidates subscriptions even when a hold preserves bytes.
  await ctx.db.patch(task._id, { retentionCheckedAt: Date.now() });
  if (workspace.preservationHold || task.active) return;
  await ctx.db.patch(task._id, {
    prompt: "",
    result: undefined,
    delivery: undefined,
    contextRefs: [],
    detail: "Task content removed by retention policy.",
    contentClearedAt: Date.now(),
  });
  await redactTaskConversation(ctx, task._id);
  if (task.intentId) {
    const intent = await ctx.db.get(task.intentId);
    if (intent)
      await ctx.db.patch(intent._id, {
        to: "",
        subject: "",
        text: "",
        contextRefs: [],
        detail: "Draft content removed by retention policy.",
      });
  }
  const events = await ctx.db
    .query("executionEvents")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .take(100);
  for (const item of events)
    if (item.detail) await ctx.db.patch(item._id, { detail: undefined });
}
export const expireContent = internalMutation({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.contentClearedAt) return;
    const workspace = await ctx.db.get(task.workspaceId);
    if (!workspace) return;
    const dueAt = task.createdAt + workspace.retentionDays * 86400000;
    if (dueAt > Date.now()) {
      await ctx.scheduler.runAt(dueAt, internal.execution.expireContent, {
        taskId,
      });
      return;
    }
    await applyContentRetention(ctx, task);
  },
});
export const retentionSweep = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.db
      .query("taskRuns")
      .paginate({ cursor: args.cursor ?? null, numItems: 50 });
    for (const task of page.page) await applyContentRetention(ctx, task);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.execution.retentionSweep, {
        cursor: page.continueCursor,
      });
  },
});
