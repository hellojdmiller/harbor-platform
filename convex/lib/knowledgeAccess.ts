import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireInternalMember } from "./auth";

type ReadCtx = QueryCtx | MutationCtx;
type Reference = { sourceId: Id<"sources">; revision: number };

export async function referencesVisible(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  ownerId: Id<"users">,
  refs: Reference[],
) {
  if (refs.length > 8) return false;
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace || workspace.status !== "active") return false;
  const now = Date.now();
  for (const ref of refs) {
    const source = await ctx.db.get(ref.sourceId);
    if (
      !source ||
      source.workspaceId !== workspaceId ||
      source.ownerId !== ownerId ||
      source.status !== "active" ||
      source.revision !== ref.revision ||
      source.expiresAt <= now ||
      source.createdAt + workspace.retentionDays * 86400000 <= now
    )
      return false;
    if (source.kind === "connector") {
      if (!source.grantId || source.grantRevision === undefined) return false;
      const grant = await ctx.db.get(source.grantId);
      if (
        !grant ||
        grant.workspaceId !== workspaceId ||
        grant.ownerId !== ownerId ||
        grant.status !== "active" ||
        grant.revision !== source.grantRevision ||
        grant.verifiedUntil <= now
      )
        return false;
    }
  }
  return true;
}
export async function entityVisible(ctx: ReadCtx, entity: Doc<"entities">) {
  const workspace = await ctx.db.get(entity.workspaceId);
  return (
    entity.status !== "archived" &&
    entity.expiresAt > Date.now() &&
    !!workspace &&
    entity.createdAt + workspace.retentionDays * 86400000 > Date.now() &&
    (await referencesVisible(
      ctx,
      entity.workspaceId,
      entity.ownerId,
      entity.sourceRefs,
    ))
  );
}
export async function runContextVisible(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  ownerId: Id<"users">,
  refs: Array<{ entityId: Id<"entities">; revision: number }>,
) {
  await requireInternalMember(ctx, workspaceId, ownerId);
  if (refs.length > 12) return false;
  for (const ref of refs) {
    const entity = await ctx.db.get(ref.entityId);
    if (
      !entity ||
      entity.workspaceId !== workspaceId ||
      entity.ownerId !== ownerId ||
      entity.status !== "active" ||
      entity.revision !== ref.revision ||
      !(await entityVisible(ctx, entity))
    )
      return false;
  }
  return true;
}
