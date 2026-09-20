import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
export async function createTaskConversation(
  ctx: MutationCtx,
  args: {
    taskId: Id<"taskRuns">;
    workspaceId: Id<"workspaces">;
    ownerId: Id<"users">;
    prompt: string;
  },
) {
  const existing = await ctx.db
    .query("conversations")
    .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
    .unique();
  if (existing) return;
  const { prompt, ...scope } = args;
  const now = Date.now();
  const workspace = await ctx.db.get(args.workspaceId);
  const expiresAt = now + (workspace?.retentionDays ?? 90) * 86400000;
  const conversationId = await ctx.db.insert("conversations", {
    ...scope,
    title: prompt.slice(0, 160),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAt(
    expiresAt,
    internal.conversations.expireConversation,
    { conversationId, expiresAt },
  );
  await ctx.db.insert("messages", {
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    conversationId,
    role: "user",
    content: prompt,
    createdAt: now,
  });
}
export async function appendTaskResponse(
  ctx: MutationCtx,
  taskId: Id<"taskRuns">,
  content: string,
  contextRefs: Array<{ entityId: Id<"entities">; revision: number }> = [],
) {
  const c = await ctx.db
    .query("conversations")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .unique();
  if (!c) return;
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
    .take(3);
  if (messages.some((m) => m.role === "assistant")) return;
  await ctx.db.insert("messages", {
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    conversationId: c._id,
    role: "assistant",
    content,
    createdAt: Date.now(),
  });
  await ctx.db.patch(c._id, { updatedAt: Date.now(), contextRefs });
}
export async function redactTaskConversation(
  ctx: MutationCtx,
  taskId: Id<"taskRuns">,
) {
  const c = await ctx.db
    .query("conversations")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .unique();
  if (!c) return;
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
    .take(100);
  for (const message of messages) await ctx.db.delete(message._id);
  await ctx.db.patch(c._id, {
    title: "Expired conversation",
    contextRefs: [],
    updatedAt: Date.now(),
  });
}
