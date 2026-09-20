import { defineTable } from "convex/server";
import { v } from "convex/values";
export const platformTables = {
  conversations: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    title: v.string(),
    contextRefs: v.optional(
      v.array(v.object({ entityId: v.id("entities"), revision: v.number() })),
    ),
    taskId: v.optional(v.id("taskRuns")),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["workspaceId", "ownerId"])
    .index("by_task", ["taskId"]),
  messages: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_conversation", ["conversationId", "createdAt"]),
  agents: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    name: v.string(),
    tone: v.union(
      v.literal("concise"),
      v.literal("warm"),
      v.literal("analytical"),
    ),
    detail: v.union(
      v.literal("brief"),
      v.literal("balanced"),
      v.literal("thorough"),
    ),
    instructions: v.string(),
    updatedAt: v.number(),
  }).index("by_owner", ["workspaceId", "ownerId"]),
  auditEvents: defineTable({
    workspaceId: v.id("workspaces"),
    actorId: v.id("users"),
    action: v.string(),
    targetId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId", "createdAt"]),
};
