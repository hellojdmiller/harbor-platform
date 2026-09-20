import { ConvexError } from "convex/values";
import type { Auth } from "convex/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type ReadCtx = QueryCtx | MutationCtx;
export function fail(message = "This resource is unavailable."): never {
  throw new ConvexError(message);
}
export function bounded(value: string, max: number, label: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max)
    fail(`${label} must contain 1–${max} characters.`);
  return cleaned;
}
export async function requireIdentity(ctx: { auth: Auth }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.tokenIdentifier || !identity.issuer || !identity.subject)
    fail("Sign in to continue.");
  return identity;
}
export async function requireUser(ctx: ReadCtx) {
  const identity = await requireIdentity(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_token", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (
    !user ||
    user.status !== "active" ||
    user.issuer !== identity.issuer ||
    user.subject !== identity.subject
  )
    fail("An active account is required.");
  return user;
}
export async function requireInternalMember(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
) {
  const user = await ctx.db.get(userId);
  const workspace = await ctx.db.get(workspaceId);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", userId),
    )
    .unique();
  if (
    !user ||
    user.status !== "active" ||
    !workspace ||
    workspace.status !== "active" ||
    !membership ||
    membership.status !== "active"
  )
    fail();
  return { user, membership, workspace };
}
export async function requireMember(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
) {
  return requireInternalMember(ctx, workspaceId, (await requireUser(ctx))._id);
}
export const requireMembership = requireMember;
export async function requireAdmin(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
) {
  const scope = await requireMember(ctx, workspaceId);
  if (scope.membership.role === "member")
    fail("Workspace administrator access is required.");
  return scope;
}
export async function requireOwnerRecord(
  ctx: ReadCtx,
  record: { workspaceId: Id<"workspaces">; ownerId: Id<"users"> } | null,
) {
  if (!record) fail();
  const scope = await requireMember(ctx, record.workspaceId);
  if (record.ownerId !== scope.user._id) fail();
  return scope;
}
export function requireRevision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || actual !== expected)
    fail("This item changed. Refresh before saving.");
}
export function retentionExpiry(workspace: Doc<"workspaces">) {
  return Date.now() + workspace.retentionDays * 86400000;
}
