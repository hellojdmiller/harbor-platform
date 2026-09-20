import type { UserIdentity } from "convex/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export function isBootstrapOperator(
  identity: Pick<UserIdentity, "issuer" | "subject">,
): boolean {
  if (!process.env.OIDC_ISSUER || identity.issuer !== process.env.OIDC_ISSUER)
    return false;
  try {
    const subjects: unknown = JSON.parse(
      process.env.HARBOR_BOOTSTRAP_SUBJECTS ?? "[]",
    );
    return (
      Array.isArray(subjects) &&
      subjects.length <= 100 &&
      subjects.every(
        (subject) =>
          typeof subject === "string" &&
          subject.length > 0 &&
          subject.length <= 256,
      ) &&
      subjects.includes(identity.subject)
    );
  } catch {
    return false;
  }
}

export async function ensurePersonalAgent(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  ownerId: Id<"users">,
): Promise<void> {
  const existing = await ctx.db
    .query("agents")
    .withIndex("by_owner", (q) =>
      q.eq("workspaceId", workspaceId).eq("ownerId", ownerId),
    )
    .unique();
  if (!existing)
    await ctx.db.insert("agents", {
      workspaceId,
      ownerId,
      name: "Piper",
      tone: "warm",
      detail: "balanced",
      instructions:
        "Lead with the useful next step. Ask before taking an external action.",
      updatedAt: Date.now(),
    });
}
