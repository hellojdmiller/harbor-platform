import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireMember } from "./lib/auth";
import { AnthropicProvider } from "../lib/ai/anthropic";
import { configuredModels, routeModel } from "../lib/ai/routing";
import {
  composeRunPrompt,
  type AgentProfile,
  type ContextFact,
} from "../lib/ai/context";
import type { GenerateResult } from "../lib/ai/types";

type ConvexGenerateResult =
  | (Extract<GenerateResult, { status: "succeeded" }> & {
      contextRefs: { entityId: Id<"entities">; revision: number }[];
      contextInvalidated?: boolean;
    })
  | Exclude<GenerateResult, { status: "succeeded" }>;
interface ModelClaim {
  workspaceId: Id<"workspaces">;
  ownerId: Id<"users">;
  prompt: string;
  model: string;
  maxOutputTokens: number;
  maxCostMicros: number;
  allowedModelIds: string[];
  allowedProviders: string[];
}
export const catalog = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId);
    return {
      models: configuredModels(process.env.ANTHROPIC_MODELS_JSON),
      state: process.env.ANTHROPIC_API_KEY ? "configured" : "implemented",
      detail:
        "Text generation adapter. Configuration does not establish a live verified connection.",
    };
  },
});
export const generateTask = internalAction({
  args: { taskId: v.id("taskRuns") },
  handler: async (ctx, args): Promise<ConvexGenerateResult> => {
    if (!process.env.ANTHROPIC_API_KEY)
      return {
        status: "failed",
        errorCode: "not_configured",
        detail: "The Anthropic API key is not configured.",
      };
    const claim: ModelClaim | null = await ctx.runMutation(
      internal.execution.claimModelDispatch,
      args,
    );
    if (!claim)
      return {
        status: "uncertain",
        errorCode: "already_claimed",
        detail:
          "This dispatch is already claimed or no longer authorized. It will not run again.",
      };
    const started = Date.now();
    let result: ConvexGenerateResult;
    let reasons: string[] = [];
    try {
      const scope = { workspaceId: claim.workspaceId, ownerId: claim.ownerId };
      const profile: AgentProfile = await ctx.runQuery(
        internal.agents.forRun,
        scope,
      );
      const facts: ContextFact[] = await ctx.runQuery(
        internal.knowledge.contextForRun,
        scope,
      );
      const composed = composeRunPrompt(claim.prompt, profile, facts);
      const route = routeModel(
        claim.model,
        composed.prompt,
        claim.maxOutputTokens,
        {
          allowedProviders: claim.allowedProviders,
          allowedModelIds: claim.allowedModelIds,
          requiredCapabilities: ["text"],
          maxCostMicros: claim.maxCostMicros,
        },
        configuredModels(process.env.ANTHROPIC_MODELS_JSON),
      );
      reasons = route.reasons;
      const refs = composed.contextRefs.map((ref) => ({
        ...ref,
        entityId: ref.entityId as Id<"entities">,
      }));
      const [contextAllowed, dispatchAllowed] = await Promise.all([
        ctx.runQuery(internal.knowledge.validateContext, { ...scope, refs }),
        ctx.runQuery(internal.execution.validateModelDispatch, args),
      ]);
      if (!contextAllowed || !dispatchAllowed)
        throw new Error("Authorization changed before dispatch");
      const generated = await new AnthropicProvider(
        process.env.ANTHROPIC_API_KEY,
      ).generate({
        prompt: composed.prompt,
        model: route.model,
        maxOutputTokens: claim.maxOutputTokens,
        maxCostMicros: claim.maxCostMicros,
      });
      if (generated.status === "succeeded") {
        // Preserve measured usage even if permission changes while the provider is running.
        // Withhold stale text before the durable workflow journals this action result.
        let stillVisible = false;
        try {
          stillVisible = await ctx.runQuery(
            internal.knowledge.validateContext,
            { ...scope, refs },
          );
        } catch {
          /* Membership may have been revoked. */
        }
        result = {
          ...generated,
          text: stillVisible ? generated.text : "",
          contextRefs: refs,
          ...(!stillVisible ? { contextInvalidated: true } : {}),
        };
      } else result = generated;
      if (result.status === "failed")
        result = { ...result, status: "uncertain" };
    } catch {
      result = {
        status: "uncertain",
        errorCode: "routing_or_dispatch",
        detail:
          "The claimed request could not complete. Its reservation remains held for review.",
      };
    }
    await ctx.runMutation(internal.ai.recordReceipt, {
      taskId: args.taskId,
      workspaceId: claim.workspaceId,
      ownerId: claim.ownerId,
      provider: "anthropic",
      model: claim.model,
      status: result.status,
      ...(result.status === "succeeded"
        ? {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costMicros: result.costMicros,
          }
        : {}),
      latencyMs: Math.min(Date.now() - started, 120_000),
      routingReasons: reasons,
      ...(result.status === "succeeded" && result.providerRequestId
        ? { providerRequestId: result.providerRequestId }
        : {}),
      ...(result.status !== "succeeded"
        ? { errorCode: result.errorCode }
        : result.contextInvalidated
          ? { errorCode: "context_invalidated" }
          : {}),
    });
    return result;
  },
});
export const recordReceipt = internalMutation({
  args: {
    taskId: v.id("taskRuns"),
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    provider: v.string(),
    model: v.string(),
    status: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("uncertain"),
    ),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costMicros: v.optional(v.number()),
    latencyMs: v.number(),
    routingReasons: v.array(v.string()),
    errorCode: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (
      !task ||
      task.workspaceId !== args.workspaceId ||
      task.ownerId !== args.ownerId
    )
      throw new Error("Receipt scope mismatch");
    if (
      args.model.length > 100 ||
      args.provider !== "anthropic" ||
      args.routingReasons.length > 8 ||
      args.routingReasons.some((value) => value.length > 50) ||
      (args.errorCode?.length || 0) > 80 ||
      (args.providerRequestId?.length || 0) > 160
    )
      throw new Error("Receipt bounds exceeded");
    for (const value of [
      args.inputTokens,
      args.outputTokens,
      args.costMicros,
      args.latencyMs,
    ])
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000)
      )
        throw new Error("Invalid usage metadata");
    const workspace = await ctx.db.get(args.workspaceId);
    const retentionDays = Math.min(workspace?.retentionDays || 30, 90);
    return ctx.db.insert("providerCallReceipts", {
      ...args,
      createdAt: Date.now(),
      expiresAt: Date.now() + retentionDays * 86_400_000,
    });
  },
});
export const receipts = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.workspaceId);
    return (
      await ctx.db
        .query("providerCallReceipts")
        .withIndex("by_workspace_owner", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
        )
        .order("desc")
        .take(50)
    ).filter((row) => row.expiresAt > Date.now());
  },
});
