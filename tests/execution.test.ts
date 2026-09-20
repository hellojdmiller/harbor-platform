/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import workflowTest from "@convex-dev/workflow/test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { DEFAULT_MODEL_ID, reserveCostMicros } from "../lib/ai/routing";

const modules = import.meta.glob("../convex/**/*.ts");
function setup() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  return t;
}
type Test = ReturnType<typeof setup>;
async function owner(t: Test, subject = "alice") {
  const client = t.withIdentity({
    issuer: "https://test.invalid",
    subject,
    tokenIdentifier: `https://test.invalid|${subject}`,
    name: subject,
  });
  return { client, ...(await client.mutation(api.workspaces.bootstrap, {})) };
}
const model = DEFAULT_MODEL_ID;
const prompt = "Draft a short preparation note for today's meeting.";
const goodModel = () =>
  Response.json(
    {
      model,
      content: [{ type: "text", text: "Here is your preparation note." }],
      usage: { input_tokens: 30, output_tokens: 15 },
      stop_reason: "end_turn",
    },
    { headers: { "request-id": "req_fixture" } },
  );
async function until(
  t: Test,
  taskId: Id<"taskRuns">,
  predicate: (state: string) => boolean,
) {
  for (let i = 0; i < 100; i++) {
    await vi.advanceTimersByTimeAsync(100);
    await t.finishInProgressScheduledFunctions();
    const task = await t.run((ctx) => ctx.db.get(taskId));
    if (task && predicate(task.state)) return task;
  }
  throw new Error(
    `Task did not reach expected state: ${JSON.stringify(await t.run((ctx) => ctx.db.get(taskId)))}`,
  );
}
beforeEach(() => {
  vi.stubEnv("HARBOR_ALLOW_SELF_SERVICE_WORKSPACES", "true");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key-never-live");
  vi.stubEnv("ANTHROPIC_MODELS_JSON", "");
  vi.stubEnv("ENABLE_EXTERNAL_WRITES", "false");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("RESEND_FROM", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => goodModel()),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("durable execution authorization and budgets", () => {
  it("requires an active owner scope and keeps personal tasks private from other workspace members", async () => {
    const t = setup(),
      a = await owner(t),
      b = await owner(t, "bob");
    await expect(
      t.mutation(api.execution.start, {
        workspaceId: a.workspaceId,
        prompt,
        model,
      }),
    ).rejects.toThrow();
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        workspaceId: a.workspaceId,
        userId: b.userId,
        role: "admin",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await expect(
      b.client.query(api.execution.get, { taskId: id }),
    ).rejects.toThrow();
    await expect(
      b.client.mutation(api.execution.cancel, { taskId: id }),
    ).rejects.toThrow();
    expect(
      await b.client.query(api.execution.list, { workspaceId: a.workspaceId }),
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reserves owner and workspace budgets atomically before dispatch", async () => {
    const t = setup(),
      a = await owner(t),
      amount = reserveCostMicros(model, prompt, 4096, 16_384);
    await a.client.mutation(api.execution.updatePolicy, {
      workspaceId: a.workspaceId,
      allowedModels: [model],
      monthlyWorkspaceMicros: amount * 2,
      monthlyUserMicros: amount * 2,
      allowEmail: false,
    });
    await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await expect(
      a.client.mutation(api.execution.start, {
        workspaceId: a.workspaceId,
        prompt,
        model,
      }),
    ).rejects.toThrow(/spending/);
    const policy = await a.client.query(api.execution.policy, {
      workspaceId: a.workspaceId,
    });
    expect(policy.usage.workspace).toEqual({
      spentMicros: 0,
      reservedMicros: amount * 2,
    });
    expect(policy.usage.user).toEqual(policy.usage.workspace);
  });
  it("enforces shared workspace caps across users and excludes member policy edits", async () => {
    const t = setup(),
      a = await owner(t),
      b = await owner(t, "bob"),
      amount = reserveCostMicros(model, prompt, 4096, 16_384);
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        workspaceId: a.workspaceId,
        userId: b.userId,
        role: "member",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    const policy = {
      workspaceId: a.workspaceId,
      allowedModels: [model],
      monthlyWorkspaceMicros: amount,
      monthlyUserMicros: amount * 2,
      allowEmail: false,
    };
    await a.client.mutation(api.execution.updatePolicy, policy);
    await expect(
      b.client.mutation(api.execution.updatePolicy, policy),
    ).rejects.toThrow();
    await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await expect(
      b.client.mutation(api.execution.start, {
        workspaceId: a.workspaceId,
        prompt,
        model,
      }),
    ).rejects.toThrow(/spending/);
  });
  it("rechecks membership and a reduced policy before model dispatch", async () => {
    const t = setup(),
      a = await owner(t);
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await a.client.mutation(api.execution.updatePolicy, {
      workspaceId: a.workspaceId,
      allowedModels: [],
      monthlyWorkspaceMicros: 100000000,
      monthlyUserMicros: 20000000,
      allowEmail: false,
    });
    await expect(
      t.mutation(internal.execution.claimModelDispatch, { taskId: id }),
    ).rejects.toThrow(/revoked/);
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", a.workspaceId).eq("userId", a.userId),
        )
        .unique();
      await ctx.db.patch(membership!._id, { status: "suspended" });
    });
    await expect(
      t.mutation(internal.execution.claimModelDispatch, { taskId: id }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("dispatch revalidation", () => {
  it("rejects a previously claimed model call when policy changes during context collection", async () => {
    const t = setup(),
      a = await owner(t);
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    expect(
      await t.mutation(internal.execution.claimModelDispatch, { taskId: id }),
    ).not.toBeNull();
    expect(
      await t.query(internal.execution.validateModelDispatch, { taskId: id }),
    ).toBe(true);
    await a.client.mutation(api.execution.updatePolicy, {
      workspaceId: a.workspaceId,
      allowedModels: [],
      monthlyWorkspaceMicros: 100000000,
      monthlyUserMicros: 20000000,
      allowEmail: false,
    });
    expect(
      await t.query(internal.execution.validateModelDispatch, { taskId: id }),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("real Workflow component with provider fixtures", () => {
  it("runs a persisted assistant task, settles real usage metadata and stores the conversation", async () => {
    const t = setup(),
      a = await owner(t);
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    const task = await until(t, id, (state) => state === "succeeded");
    expect(task.result).toBe("Here is your preparation note.");
    expect(task.modelDispatch).toBe("settled");
    expect(task.costMicros).toBe(210);
    expect(fetch).toHaveBeenCalledTimes(1);
    const policy = await a.client.query(api.execution.policy, {
      workspaceId: a.workspaceId,
    });
    expect(policy.usage.workspace).toEqual({
      spentMicros: 210,
      reservedMicros: 0,
    });
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe(task.result);
    expect(
      await t.mutation(internal.execution.claimModelDispatch, { taskId: id }),
    ).toBeNull();
  });
  it("reports missing configuration as failure and releases unused reservations", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = setup(),
      a = await owner(t);
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    const task = await until(t, id, (state) => state === "failed");
    expect(task.modelDispatch).toBe("not_started");
    expect(task.result).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await a.client.query(api.execution.policy, {
          workspaceId: a.workspaceId,
        })
      ).usage.user,
    ).toEqual({ reservedMicros: 0, spentMicros: 0 });
    const retry = await a.client.mutation(api.execution.recover, {
      taskId: id,
    });
    expect(retry).not.toBe(id);
    await expect(
      a.client.mutation(api.execution.recover, { taskId: id }),
    ).rejects.toThrow();
  });
  it("holds spending for an ambiguous model outcome and does not retry the paid request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket closed after submission");
      }),
    );
    const t = setup(),
      a = await owner(t);
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    const task = await until(
      t,
      id,
      (state) => state === "needs_reconciliation",
    );
    expect(task.costMicros).toBeUndefined();
    expect(task.result).toBeUndefined();
    const policy = await a.client.query(api.execution.policy, {
      workspaceId: a.workspaceId,
    });
    expect(policy.usage.user.reservedMicros).toBeGreaterThan(0);
    expect(policy.usage.user.spentMicros).toBe(0);
    await expect(
      a.client.mutation(api.execution.recover, { taskId: id }),
    ).rejects.toThrow();
    expect(
      await t.mutation(internal.execution.claimModelDispatch, { taskId: id }),
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("cancel before dispatch refunds; cancel after claim requires reconciliation", async () => {
    const t = setup(),
      a = await owner(t);
    const first = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await a.client.mutation(api.execution.cancel, { taskId: first });
    expect(
      (await a.client.query(api.execution.get, { taskId: first })).state,
    ).toBe("canceled");
    expect(
      (
        await a.client.query(api.execution.policy, {
          workspaceId: a.workspaceId,
        })
      ).usage.user.reservedMicros,
    ).toBe(0);
    const second = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    expect(
      await t.mutation(internal.execution.claimModelDispatch, {
        taskId: second,
      }),
    ).not.toBeNull();
    await a.client.mutation(api.execution.cancel, { taskId: second });
    expect(
      (await a.client.query(api.execution.get, { taskId: second })).state,
    ).toBe("needs_reconciliation");
    expect(
      (
        await a.client.query(api.execution.policy, {
          workspaceId: a.workspaceId,
        })
      ).usage.user.reservedMicros,
    ).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function deliveryTask(t: Test) {
  const a = await owner(t);
  await a.client.mutation(api.execution.updatePolicy, {
    workspaceId: a.workspaceId,
    allowedModels: [model],
    monthlyWorkspaceMicros: 100000000,
    monthlyUserMicros: 20000000,
    allowEmail: true,
  });
  const id = await a.client.mutation(api.execution.start, {
    workspaceId: a.workspaceId,
    prompt,
    model,
    delivery: { to: "recipient@example.test", subject: "Preparation note" },
  });
  await until(t, id, (state) => state === "awaiting_approval");
  return { ...a, id };
}
describe("approval, uncertain writes, and event routines", () => {
  it("pauses on an exact persisted email draft, then resumes once with a provider receipt", async () => {
    vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
    vi.stubEnv("RESEND_API_KEY", "fixture-email-key");
    vi.stubEnv("RESEND_FROM", "Harbor <harbor@example.test>");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return url.includes("anthropic")
          ? goodModel()
          : Response.json({ id: "email_fixture_1" });
      }),
    );
    const t = setup(),
      a = await deliveryTask(t);
    expect(calls).toHaveLength(1);
    const detail = await a.client.query(api.execution.get, { taskId: a.id });
    expect(detail.intent?.text).toBe("Here is your preparation note.");
    expect(detail.intent?.status).toBe("prepared");
    await a.client.mutation(api.execution.approve, {
      taskId: a.id,
      approve: true,
    });
    await until(t, a.id, (state) => state === "succeeded");
    const result = await a.client.query(api.execution.get, { taskId: a.id });
    expect(result.intent?.status).toBe("submitted");
    expect(result.intent?.providerId).toBe("email_fixture_1");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({
      text: detail.intent?.text,
      subject: "Preparation note",
      to: ["recipient@example.test"],
    });
    await expect(
      a.client.mutation(api.execution.approve, { taskId: a.id, approve: true }),
    ).rejects.toThrow();
    expect(
      await t.mutation(internal.execution.claimExternalDispatch, {
        intentId: detail.intent!._id,
      }),
    ).toBeNull();
  });
  it("declining or expiring an approval never dispatches its email", async () => {
    const t = setup(),
      a = await deliveryTask(t);
    await a.client.mutation(api.execution.approve, {
      taskId: a.id,
      approve: false,
    });
    expect(
      (await a.client.query(api.execution.get, { taskId: a.id })).intent
        ?.status,
    ).toBe("canceled");
    const second = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
      delivery: { to: "recipient@example.test", subject: "Other note" },
    });
    await until(t, second, (state) => state === "awaiting_approval");
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await t.mutation(internal.execution.expireApproval, { taskId: second });
    expect(
      (await a.client.query(api.execution.get, { taskId: second })).state,
    ).toBe("timed_out");
    await expect(
      a.client.mutation(api.execution.approve, {
        taskId: second,
        approve: true,
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps a potentially submitted email uncertain and prevents resending", async () => {
    vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
    vi.stubEnv("RESEND_API_KEY", "fixture-email-key");
    vi.stubEnv("RESEND_FROM", "Harbor <harbor@example.test>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("anthropic")) return goodModel();
        throw new Error("no receipt");
      }),
    );
    const t = setup(),
      a = await deliveryTask(t);
    await a.client.mutation(api.execution.approve, {
      taskId: a.id,
      approve: true,
    });
    await until(t, a.id, (state) => state === "needs_reconciliation");
    const task = await a.client.query(api.execution.get, { taskId: a.id });
    expect(task.intent?.status).toBe("uncertain");
    expect(task.intent?.providerId).toBeUndefined();
    await expect(
      a.client.mutation(api.execution.recover, { taskId: a.id }),
    ).rejects.toThrow();
    expect(
      await t.mutation(internal.execution.claimExternalDispatch, {
        intentId: task.intent!._id,
      }),
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      (
        await a.client.query(api.execution.policy, {
          workspaceId: a.workspaceId,
        })
      ).usage.user,
    ).toEqual({ spentMicros: 210, reservedMicros: 0 });
  });
  it("deduplicates scoped event triggers and honors paused routine revisions", async () => {
    const t = setup(),
      a = await owner(t);
    const routineId = await a.client.mutation(api.execution.createRoutine, {
      workspaceId: a.workspaceId,
      name: "Meeting event",
      prompt,
      model,
      eventKey: "meeting.completed",
    });
    const first = await a.client.mutation(api.execution.triggerEvent, {
      routineId,
      eventId: "meeting-123",
    });
    expect(
      await a.client.mutation(api.execution.triggerEvent, {
        routineId,
        eventId: "meeting-123",
      }),
    ).toBe(first);
    const b = await owner(t, "bob");
    await expect(
      b.client.mutation(api.execution.triggerEvent, {
        routineId,
        eventId: "meeting-123",
      }),
    ).rejects.toThrow();
    await a.client.mutation(api.execution.setRoutineEnabled, {
      routineId,
      enabled: false,
    });
    await expect(
      a.client.mutation(api.execution.triggerEvent, {
        routineId,
        eventId: "meeting-124",
      }),
    ).rejects.toThrow();
    const scheduled = await a.client.mutation(api.execution.createRoutine, {
      workspaceId: a.workspaceId,
      name: "Hourly",
      prompt,
      model,
      intervalMinutes: 60,
    });
    const routine = await t.run((ctx) => ctx.db.get(scheduled));
    await a.client.mutation(api.execution.setRoutineEnabled, {
      routineId: scheduled,
      enabled: false,
    });
    expect(
      await t.mutation(internal.execution.runScheduledRoutine, {
        routineId: scheduled,
        revision: routine!.revision,
        dueAt: routine!.nextRunAt!,
      }),
    ).toBeNull();
  });
});

describe("provenance and recovery boundaries", () => {
  it("carries reviewed context through the model and hides derived task/email content after source retirement", async () => {
    const t = setup(),
      a = await owner(t);
    const sourceId = await a.client.mutation(api.knowledge.createSource, {
      workspaceId: a.workspaceId,
      title: "Fictional Atlas notes",
      text: "Atlas prefers Friday updates.",
    });
    const entityId = await a.client.mutation(api.knowledge.createEntity, {
      workspaceId: a.workspaceId,
      kind: "project",
      title: "Atlas",
      summary: "Friday updates",
      aliases: [],
      sourceRefs: [{ sourceId, revision: 1 }],
      evidence: "Friday updates",
    });
    await a.client.mutation(api.knowledge.decideEntity, {
      entityId,
      expectedRevision: 1,
      decision: "approve",
    });
    await a.client.mutation(api.execution.updatePolicy, {
      workspaceId: a.workspaceId,
      allowedModels: [model],
      monthlyWorkspaceMicros: 100000000,
      monthlyUserMicros: 20000000,
      allowEmail: true,
    });
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
      delivery: { to: "recipient@example.test", subject: "Atlas note" },
    });
    await until(t, id, (state) => state === "awaiting_approval");
    const before = await a.client.query(api.execution.get, { taskId: id });
    expect(before.contextRefs).toEqual([{ entityId, revision: 2 }]);
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(request.messages[0].content).toContain("Friday updates");
    await a.client.mutation(api.knowledge.retireSource, {
      sourceId,
      expectedRevision: 1,
    });
    const after = await a.client.query(api.execution.get, { taskId: id });
    expect(after.contextAvailable).toBe(false);
    expect(after.result).toBeUndefined();
    expect(after.intent).toBeNull();
    expect(
      (
        await a.client.query(api.execution.list, { workspaceId: a.workspaceId })
      )[0].hasResult,
    ).toBe(false);
    await expect(
      a.client.mutation(api.execution.approve, { taskId: id, approve: true }),
    ).rejects.toThrow(/context/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("records usage without publishing content when its context changes during the provider call", async () => {
    const t = setup(),
      a = await owner(t);
    const entityId = await a.client.mutation(api.knowledge.createEntity, {
      workspaceId: a.workspaceId,
      kind: "preference",
      title: "Writing style",
      summary: "Short notes",
      aliases: [],
      sourceRefs: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await a.client.mutation(api.knowledge.correctEntity, {
          entityId,
          expectedRevision: 1,
          title: "Writing style",
          summary: "Detailed notes",
          reason: "New preference",
        });
        return goodModel();
      }),
    );
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    const task = await until(t, id, (state) => state === "canceled");
    expect(task.result).toBeUndefined();
    expect(task.costMicros).toBe(210);
    expect(
      (await t.run((ctx) => ctx.db.query("messages").collect())).map(
        (row) => row.role,
      ),
    ).toEqual(["user"]);
  });
  it("scheduled routines execute once per tick and remain scheduled after a budget block", async () => {
    const t = setup(),
      a = await owner(t);
    const routineId = await a.client.mutation(api.execution.createRoutine, {
      workspaceId: a.workspaceId,
      name: "Hourly preparation",
      prompt,
      model,
      intervalMinutes: 60,
    });
    const routine = await t.run((ctx) => ctx.db.get(routineId));
    vi.setSystemTime(routine!.nextRunAt!);
    await t.mutation(internal.execution.tickRoutine, {
      routineId,
      revision: 1,
      dueAt: routine!.nextRunAt!,
    });
    const first = await t.run((ctx) => ctx.db.get(routineId));
    expect(first!.lastTaskId).toBeDefined();
    await until(t, first!.lastTaskId!, (state) => state === "succeeded");
    await t.mutation(internal.execution.tickRoutine, {
      routineId,
      revision: 1,
      dueAt: routine!.nextRunAt!,
    });
    expect(
      await t.run((ctx) => ctx.db.query("taskRuns").collect()),
    ).toHaveLength(1);
    await a.client.mutation(api.execution.updatePolicy, {
      workspaceId: a.workspaceId,
      allowedModels: [model],
      monthlyWorkspaceMicros: 0,
      monthlyUserMicros: 0,
      allowEmail: false,
    });
    vi.setSystemTime(first!.nextRunAt!);
    await t.mutation(internal.execution.tickRoutine, {
      routineId,
      revision: 1,
      dueAt: first!.nextRunAt!,
    });
    const blocked = await t.run((ctx) => ctx.db.get(routineId));
    expect(blocked!.lastStatus).toBe("blocked");
    expect(blocked!.nextRunAt).toBeGreaterThan(first!.nextRunAt!);
    expect(
      await t.run((ctx) => ctx.db.query("taskRuns").collect()),
    ).toHaveLength(1);
  });
  it("requires an operator evidence record and a settled dispatch window before releasing uncertain usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unknown");
      }),
    );
    const t = setup(),
      a = await owner(t);
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await until(t, id, (state) => state === "needs_reconciliation");
    await expect(
      a.client.mutation(api.execution.reconcile, {
        taskId: id,
        outcome: "confirmed_failure",
        costMicros: 210,
        note: "Provider receipt req_fixture",
      }),
    ).rejects.toThrow(/finish/);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await a.client.mutation(api.execution.reconcile, {
      taskId: id,
      outcome: "confirmed_failure",
      costMicros: 210,
      note: "Provider receipt req_fixture",
    });
    expect(
      (
        await a.client.query(api.execution.policy, {
          workspaceId: a.workspaceId,
        })
      ).usage.user,
    ).toEqual({ spentMicros: 210, reservedMicros: 0 });
    const task = await a.client.query(api.execution.get, { taskId: id });
    expect(task.state).toBe("failed");
    expect(task.result).toBeUndefined();
    expect(
      task.events.some((event) => event.type === "operator_reconciled"),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("task retention and workflow journals", () => {
  it("cleans completed journals and redacts expired payloads while retaining usage and intent receipts", async () => {
    const t = setup(),
      a = await owner(t);
    await t.run((ctx) => ctx.db.patch(a.workspaceId, { retentionDays: 1 }));
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await until(t, id, (state) => state === "succeeded");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await t.finishInProgressScheduledFunctions();
    }
    expect(
      (await t.run((ctx) => ctx.db.get(id)))!.journalCleanedAt,
    ).toBeDefined();
    vi.setSystemTime(Date.now() + 86400001);
    await t.mutation(internal.execution.expireContent, { taskId: id });
    await expect(
      a.client.query(api.execution.get, { taskId: id }),
    ).rejects.toThrow(/expired/);
    expect(
      await a.client.query(api.execution.list, { workspaceId: a.workspaceId }),
    ).toEqual([]);
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored!.prompt).toBe("");
    expect(stored!.result).toBeUndefined();
    expect(stored!.costMicros).toBe(210);
    expect(stored!.providerRequestId).toBe("req_fixture");
    expect(
      await t.run((ctx) => ctx.db.query("messages").collect()),
    ).toHaveLength(0);
  });
  it("holds preserve expired bytes but do not make them readable; release permits the sweep", async () => {
    const t = setup(),
      a = await owner(t);
    await t.run((ctx) =>
      ctx.db.patch(a.workspaceId, { retentionDays: 1, preservationHold: true }),
    );
    const id = await a.client.mutation(api.execution.start, {
      workspaceId: a.workspaceId,
      prompt,
      model,
    });
    await until(t, id, (state) => state === "succeeded");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await t.finishInProgressScheduledFunctions();
    }
    expect(
      (await t.run((ctx) => ctx.db.get(id)))!.journalCleanedAt,
    ).toBeUndefined();
    vi.setSystemTime(Date.now() + 86400001);
    await t.mutation(internal.execution.expireContent, { taskId: id });
    await expect(
      a.client.query(api.execution.get, { taskId: id }),
    ).rejects.toThrow(/expired/);
    expect((await t.run((ctx) => ctx.db.get(id)))!.result).toBe(
      "Here is your preparation note.",
    );
    await t.run((ctx) =>
      ctx.db.patch(a.workspaceId, { preservationHold: false }),
    );
    await t.mutation(internal.execution.retentionSweep, {});
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored!.result).toBeUndefined();
    expect(stored!.journalCleanedAt).toBeDefined();
    expect(stored!.contentClearedAt).toBeDefined();
  });
});
