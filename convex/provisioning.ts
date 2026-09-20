import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { bounded, fail, requireMember, requireRevision } from "./lib/auth";

export const assign = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    issuer: v.string(),
    subject: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireMember(ctx, args.workspaceId);
    if (membership.role !== "owner")
      fail("Workspace owner access is required to provision members.");
    const issuer = bounded(args.issuer, 512, "Issuer"),
      subject = bounded(args.subject, 256, "Subject");
    if (!process.env.OIDC_ISSUER || issuer !== process.env.OIDC_ISSUER)
      fail("Choose an identity from the configured OIDC issuer.");
    const existing = await ctx.db
      .query("workspaceAdmissions")
      .withIndex("by_target", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("issuer", issuer)
          .eq("subject", subject),
      )
      .unique();
    if (existing && existing.status !== "revoked") {
      if (existing.role !== args.role)
        fail(
          "An admission cannot change existing or pending membership roles.",
        );
      return existing._id;
    }
    const targetUser = await ctx.db
      .query("users")
      .withIndex("by_identity", (q) =>
        q.eq("issuer", issuer).eq("subject", subject),
      )
      .unique();
    if (targetUser) {
      const targetMember = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("userId", targetUser._id),
        )
        .unique();
      if (targetMember)
        fail(
          "Manage existing membership access through administrator controls.",
        );
    }
    const current = await ctx.db
      .query("workspaceAdmissions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(501);
    if (!existing && current.length >= 500)
      fail("Workspace admission limit reached.");
    let admissionId;
    if (existing) {
      await ctx.db.patch(existing._id, {
        role: args.role,
        status: "pending",
        revision: existing.revision + 1,
        assignedBy: user._id,
        assignedAt: Date.now(),
        revokedAt: undefined,
      });
      admissionId = existing._id;
    } else
      admissionId = await ctx.db.insert("workspaceAdmissions", {
        workspaceId: args.workspaceId,
        issuer,
        subject,
        role: args.role,
        status: "pending",
        revision: 1,
        assignedBy: user._id,
        assignedAt: Date.now(),
      });
    await ctx.db.insert("auditEvents", {
      workspaceId: args.workspaceId,
      actorId: user._id,
      action: "admission.assigned",
      targetId: admissionId,
      createdAt: Date.now(),
    });
    return admissionId;
  },
});

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { membership } = await requireMember(ctx, args.workspaceId);
    if (membership.role !== "owner")
      fail("Workspace owner access is required.");
    return ctx.db
      .query("workspaceAdmissions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(500);
  },
});

export const revoke = mutation({
  args: {
    admissionId: v.id("workspaceAdmissions"),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const admission = await ctx.db.get(args.admissionId);
    if (!admission) fail();
    const { user, membership } = await requireMember(
      ctx,
      admission.workspaceId,
    );
    if (membership.role !== "owner")
      fail("Workspace owner access is required.");
    requireRevision(admission.revision, args.expectedRevision);
    if (admission.status !== "pending")
      fail(
        "Only an unused admission can be revoked. Manage existing memberships separately.",
      );
    await ctx.db.patch(admission._id, {
      status: "revoked",
      revision: admission.revision + 1,
      revokedAt: Date.now(),
    });
    await ctx.db.insert("auditEvents", {
      workspaceId: admission.workspaceId,
      actorId: user._id,
      action: "admission.revoked",
      targetId: admission._id,
      createdAt: Date.now(),
    });
  },
});
