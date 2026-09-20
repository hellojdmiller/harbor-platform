import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin, fail } from "./lib/auth";
export const overview = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireAdmin(ctx, workspaceId);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId))
      .take(500);
    const members = await Promise.all(
      memberships.map(async (m) => ({
        id: m._id,
        userId: m.userId,
        name:
          (await ctx.db.get(m.userId))?.displayName ?? "Account unavailable",
        role: m.role,
        status: m.status,
      })),
    );
    const audit = await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(100);
    return { members, audit };
  },
});
export const setMembership = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    membershipId: v.id("memberships"),
    role: v.union(v.literal("admin"), v.literal("member")),
    status: v.union(v.literal("active"), v.literal("suspended")),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireAdmin(ctx, args.workspaceId);
    const target = await ctx.db.get(args.membershipId);
    if (!target || target.workspaceId !== args.workspaceId) fail();
    if (target.role === "owner" || target.userId === user._id)
      fail("Owner and self changes require a separate recovery process.");
    if (
      membership.role !== "owner" &&
      (target.role === "admin" || args.role === "admin")
    )
      fail("Only an owner can change administrator access.");
    await ctx.db.patch(target._id, { role: args.role, status: args.status });
    await ctx.db.insert("auditEvents", {
      workspaceId: args.workspaceId,
      actorId: user._id,
      action: "membership.updated",
      targetId: target._id,
      createdAt: Date.now(),
    });
  },
});
