import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
import {
  requireMember,
  requireInternalMember,
  bounded,
  fail,
} from "./lib/auth";
const defaults = {
  name: "Piper",
  tone: "warm" as const,
  detail: "balanced" as const,
  instructions:
    "Lead with the useful next step. Ask before taking an external action.",
};
export const get = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireMember(ctx, workspaceId);
    return (
      (await ctx.db
        .query("agents")
        .withIndex("by_owner", (q) =>
          q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
        )
        .unique()) ?? defaults
    );
  },
});
export const save = mutation({
  args: {
    workspaceId: v.id("workspaces"),
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
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.workspaceId);
    if (args.instructions.length > 3000)
      fail("Keep instructions under 3,000 characters.");
    const record = {
      ...args,
      name: bounded(args.name, 60, "Name"),
      ownerId: user._id,
      updatedAt: Date.now(),
    };
    const old = await ctx.db
      .query("agents")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
      )
      .unique();
    if (old) await ctx.db.patch(old._id, record);
    else await ctx.db.insert("agents", record);
    await ctx.db.insert("auditEvents", {
      workspaceId: args.workspaceId,
      actorId: user._id,
      action: "agent.updated",
      createdAt: Date.now(),
    });
  },
});
export const forRun = internalQuery({
  args: { workspaceId: v.id("workspaces"), ownerId: v.id("users") },
  handler: async (ctx, args) => {
    await requireInternalMember(ctx, args.workspaceId, args.ownerId);
    return (
      (await ctx.db
        .query("agents")
        .withIndex("by_owner", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("ownerId", args.ownerId),
        )
        .unique()) ?? defaults
    );
  },
});
