import { defineTable } from "convex/server";
import { v } from "convex/values";
export const integrationTables = {
  providerCallReceipts: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    taskId: v.id("taskRuns"),
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
    errorCode: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    routingReasons: v.array(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_workspace_owner", ["workspaceId", "ownerId", "createdAt"])
    .index("by_expiry", ["expiresAt"]),
  emailDeliveryEvents: defineTable({
    eventId: v.string(),
    providerMessageId: v.string(),
    eventType: v.string(),
    occurredAt: v.number(),
    receivedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_message", ["providerMessageId", "receivedAt"])
    .index("by_expiry", ["expiresAt"]),
};
