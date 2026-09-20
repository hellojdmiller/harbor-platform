import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { isBootstrapOperator, ensurePersonalAgent } from "./lib/provisioning";
import {
  bounded,
  fail,
  requireIdentity,
  requireUser,
  requireMember,
} from "./lib/auth";

export const bootstrap = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    let user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) {
      const id = await ctx.db.insert("users", {
        tokenIdentifier: identity.tokenIdentifier,
        issuer: identity.issuer,
        subject: identity.subject,
        displayName: String(identity.name ?? "Your workspace").slice(0, 100),
        status: "active",
        createdAt: Date.now(),
      });
      user = (await ctx.db.get(id))!;
    }
    if (
      user.status !== "active" ||
      user.issuer !== identity.issuer ||
      user.subject !== identity.subject
    )
      fail();
    const admissions = await ctx.db
      .query("workspaceAdmissions")
      .withIndex("by_identity_status", (q) =>
        q
          .eq("issuer", identity.issuer)
          .eq("subject", identity.subject)
          .eq("status", "pending"),
      )
      .take(20);
    for (const admission of admissions) {
      const workspace = await ctx.db.get(admission.workspaceId);
      if (workspace?.status !== "active") continue;
      const existing = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", workspace._id).eq("userId", user!._id),
        )
        .unique();
      // Admissions never change roles or reactivate suspended memberships.
      if (existing) continue;
      await ctx.db.insert("memberships", {
        workspaceId: workspace._id,
        userId: user._id,
        role: admission.role,
        status: "active",
        createdAt: Date.now(),
      });
      await ensurePersonalAgent(ctx, workspace._id, user._id);
      await ctx.db.patch(admission._id, {
        status: "consumed",
        revision: admission.revision + 1,
        consumedBy: user._id,
        consumedAt: Date.now(),
      });
      await ctx.db.insert("auditEvents", {
        workspaceId: workspace._id,
        actorId: user._id,
        action: "admission.consumed",
        targetId: admission._id,
        createdAt: Date.now(),
      });
    }
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user!._id))
      .take(100);
    for (const member of memberships) {
      const workspace = await ctx.db.get(member.workspaceId);
      if (member.status === "active" && workspace?.status === "active") {
        await requireMember(ctx, member.workspaceId);
        return { userId: user._id, workspaceId: member.workspaceId };
      }
    }
    if (memberships.length)
      fail("No active workspace membership is available.");
    if (
      !isBootstrapOperator(identity) &&
      process.env.HARBOR_ALLOW_SELF_SERVICE_WORKSPACES !== "true"
    )
      fail("Ask your workspace owner to provision access before signing in.");
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "My workspace",
      slug: `workspace-${user._id}`,
      status: "active",
      createdBy: user._id,
      createdAt: Date.now(),
      retentionDays: 90,
      preservationHold: false,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: user._id,
      role: "owner",
      status: "active",
      createdAt: Date.now(),
    });
    await ensurePersonalAgent(ctx, workspaceId, user._id);
    await ctx.db.insert("auditEvents", {
      workspaceId,
      actorId: user._id,
      action: "workspace.created",
      targetId: workspaceId,
      createdAt: Date.now(),
    });
    return { userId: user._id, workspaceId };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(100);
    const result = [];
    for (const member of members) {
      const workspace = await ctx.db.get(member.workspaceId);
      if (workspace?.status === "active" && member.status === "active")
        result.push({ ...workspace, role: member.role });
    }
    return result;
  },
});
export const current = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => requireMember(ctx, workspaceId),
});
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!isBootstrapOperator(await requireIdentity(ctx)))
      fail(
        "Only a configured bootstrap operator can create additional workspaces.",
      );
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_creator", (q) => q.eq("createdBy", user._id))
      .take(11);
    if (existing.length >= 10) fail("Workspace limit reached.");
    const workspaceId = await ctx.db.insert("workspaces", {
      name: bounded(args.name, 100, "Name"),
      slug: `workspace-${user._id}-${Date.now()}`,
      status: "active",
      createdBy: user._id,
      createdAt: Date.now(),
      retentionDays: 90,
      preservationHold: false,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: user._id,
      role: "owner",
      status: "active",
      createdAt: Date.now(),
    });
    await ensurePersonalAgent(ctx, workspaceId, user._id);
    await ctx.db.insert("auditEvents", {
      workspaceId,
      actorId: user._id,
      action: "workspace.created",
      targetId: workspaceId,
      createdAt: Date.now(),
    });
    return workspaceId;
  },
});
