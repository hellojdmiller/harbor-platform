import { v } from "convex/values";
import { query, internalMutation } from "./_generated/server";
import { runContextVisible } from "./lib/knowledgeAccess";
import { requireMember, requireOwnerRecord } from "./lib/auth";
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId);
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .order("desc")
      .take(50);
    const visible = [];
    for (const row of rows)
      if (
        Math.min(
          row.expiresAt ?? Infinity,
          row.createdAt + workspace.retentionDays * 86400000,
        ) > Date.now() &&
        (await runContextVisible(
          ctx,
          workspaceId,
          user._id,
          row.contextRefs ?? [],
        ))
      )
        visible.push(row);
    return visible;
  },
});
export const messages = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const record = await ctx.db.get(conversationId);
    const { workspace } = await requireOwnerRecord(ctx, record);
    if (
      !record ||
      Math.min(
        record.expiresAt ?? Infinity,
        record.createdAt + workspace.retentionDays * 86400000,
      ) <= Date.now() ||
      !(await runContextVisible(
        ctx,
        record.workspaceId,
        record.ownerId,
        record.contextRefs ?? [],
      ))
    )
      return [];
    return ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(100);
  },
});
export const expireConversation = internalMutation({
  args: { conversationId: v.id("conversations"), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.conversationId);
    if (row && row.expiresAt === args.expiresAt && row.expiresAt <= Date.now())
      await ctx.db.patch(row._id, { expiresAt: 0 });
  },
});
