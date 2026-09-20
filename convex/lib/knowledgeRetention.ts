import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

export type RetainedRecordId =
  Id<"sources"> | Id<"entities"> | Id<"wikiPages"> | Id<"fileRecords">;

export async function scheduleRecordExpiry(
  ctx: MutationCtx,
  recordId: RetainedRecordId,
): Promise<void> {
  const record = await ctx.db.get(recordId);
  if (!record || record.expiresAt === 0) return;
  const workspace = await ctx.db.get(record.workspaceId);
  if (!workspace) return;
  const at = Math.min(
    record.expiresAt,
    record.createdAt + workspace.retentionDays * 86400000,
  );
  await ctx.scheduler.runAt(
    Math.max(Date.now(), at),
    internal.knowledge.expireRecord,
    { recordId, expectedExpiresAt: record.expiresAt },
  );
}
