import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireMember, requireOwnerRecord } from "./lib/auth";
import { ResendEmailAdapter } from "../lib/integrations/resend";
import type {
  EmailResult,
  IntegrationCapability,
} from "../lib/integrations/types";

export const status = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<IntegrationCapability[]> => {
    await requireMember(ctx, args.workspaceId);
    const resend = Boolean(
      process.env.RESEND_API_KEY && process.env.RESEND_FROM,
    );
    return [
      {
        id: "resend",
        name: "Resend email",
        state: resend ? "configured" : "implemented",
        actions: ["approved-email", "signed-delivery-events"],
        externalWrites: process.env.ENABLE_EXTERNAL_WRITES === "true",
        detail:
          "Server adapter and signature verification are implemented. Configured does not mean live tested; delivery requires a provider event.",
      },
      {
        id: "mail-calendar",
        name: "Email and calendar sources",
        state: "not_implemented",
        actions: [],
        externalWrites: false,
        detail:
          "Direct read-adapter interfaces are defined. Google and Microsoft OAuth ingestion are not connected in this release.",
      },
      {
        id: "pipedream",
        name: "Pipedream Connect",
        state: "not_implemented",
        actions: [],
        externalWrites: false,
        detail:
          "Evaluated for user-scoped OAuth. No account authorization or data retrieval is implemented.",
      },
      {
        id: "e2b",
        name: "E2B coding sandbox",
        state: "not_implemented",
        actions: [],
        externalWrites: false,
        detail:
          "Evaluated for isolated code execution. No sandbox execution is wired.",
      },
      {
        id: "mcp",
        name: "MCP integrations",
        state: "not_implemented",
        actions: [],
        externalWrites: false,
        detail:
          "Authorization and tool approval requirements are documented. No remote MCP tools are connected.",
      },
    ];
  },
});
interface EmailClaim {
  workspaceId: Id<"workspaces">;
  ownerId: Id<"users">;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}
export const sendIntent = internalAction({
  args: { intentId: v.id("externalActionIntents") },
  handler: async (ctx, args): Promise<EmailResult> => {
    // Check deployment gates before consuming a dispatch authorization.
    if (
      process.env.ENABLE_EXTERNAL_WRITES !== "true" ||
      !process.env.RESEND_API_KEY ||
      !process.env.RESEND_FROM
    )
      return {
        status: "failed",
        detail: "Outbound email is disabled or not configured.",
      };
    const claim: EmailClaim | null = await ctx.runMutation(
      internal.execution.claimExternalDispatch,
      args,
    );
    if (!claim)
      return {
        status: "uncertain",
        detail:
          "This email dispatch is already claimed or is no longer authorized. No second submission was made.",
      };
    const result = await new ResendEmailAdapter({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM,
      externalWritesEnabled: true,
    }).send(claim);
    return result.status === "failed"
      ? {
          status: "uncertain",
          detail:
            "The claimed email could not be submitted. Review its execution record before any new attempt.",
        }
      : result;
  },
});
export const recordEmailEvent = internalMutation({
  args: {
    eventId: v.string(),
    providerMessageId: v.string(),
    eventType: v.string(),
    occurredAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !/^[a-zA-Z0-9_-]{1,160}$/.test(args.eventId) ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(args.providerMessageId) ||
      !/^email\.(sent|delivered|delivery_delayed|bounced|complained|failed|received)$/.test(
        args.eventType,
      ) ||
      !Number.isFinite(args.occurredAt)
    )
      throw new Error("Invalid provider receipt");
    const existing = await ctx.db
      .query("emailDeliveryEvents")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) return { duplicate: true };
    await ctx.db.insert("emailDeliveryEvents", {
      ...args,
      receivedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
    });
    return { duplicate: false };
  },
});
export const deliveryEvents = query({
  args: { intentId: v.id("externalActionIntents") },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    await requireOwnerRecord(ctx, intent);
    if (!intent?.providerId) return [];
    return (
      await ctx.db
        .query("emailDeliveryEvents")
        .withIndex("by_message", (q) =>
          q.eq("providerMessageId", intent.providerId!),
        )
        .order("desc")
        .take(50)
    ).filter((event) => event.expiresAt > Date.now());
  },
});

/** Metadata-only retention. Content and workflow journal retention are separate release gates. */
export const purgeExpired = internalMutation({
  args: {
    kind: v.union(v.literal("provider"), v.literal("email")),
    cursor: v.optional(v.string()),
    cutoff: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: number; held: number; complete: boolean }> => {
    const cutoff = args.cutoff ?? Date.now();
    if (!Number.isFinite(cutoff) || cutoff > Date.now())
      throw new Error("Invalid retention cutoff");
    let deleted = 0,
      held = 0;
    if (args.kind === "provider") {
      const batch = await ctx.db
        .query("providerCallReceipts")
        .withIndex("by_expiry", (q) => q.lte("expiresAt", cutoff))
        .paginate({ numItems: 100, cursor: args.cursor ?? null });
      for (const receipt of batch.page) {
        const workspace = await ctx.db.get(receipt.workspaceId);
        if (workspace?.preservationHold) {
          held++;
          continue;
        }
        await ctx.db.delete(receipt._id);
        deleted++;
      }
      if (!batch.isDone)
        await ctx.scheduler.runAfter(0, internal.integrations.purgeExpired, {
          kind: args.kind,
          cursor: batch.continueCursor,
          cutoff,
        });
      return { deleted, held, complete: batch.isDone };
    }
    const batch = await ctx.db
      .query("emailDeliveryEvents")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", cutoff))
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
    for (const event of batch.page) {
      const intents = await ctx.db
        .query("externalActionIntents")
        .withIndex("by_provider", (q) =>
          q.eq("provider", "resend").eq("providerId", event.providerMessageId),
        )
        .take(10);
      // Multiple matches are not expected; fail closed if the bounded association lookup fills.
      let onHold = intents.length === 10;
      for (const intent of intents)
        if ((await ctx.db.get(intent.workspaceId))?.preservationHold)
          onHold = true;
      if (onHold) {
        held++;
        continue;
      }
      await ctx.db.delete(event._id);
      deleted++;
    }
    if (!batch.isDone)
      await ctx.scheduler.runAfter(0, internal.integrations.purgeExpired, {
        kind: args.kind,
        cursor: batch.continueCursor,
        cutoff,
      });
    return { deleted, held, complete: batch.isDone };
  },
});
