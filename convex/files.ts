import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { scheduleRecordExpiry } from "./lib/knowledgeRetention";
import type { Id } from "./_generated/dataModel";
import {
  bounded,
  fail,
  requireMember,
  requireOwnerRecord,
  retentionExpiry,
} from "./lib/auth";

const permitted = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "image/png",
  "image/jpeg",
]);
const MAX_BYTES = 262144;

export const reserve = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"fileRecords">> => {
    const { user, workspace } = await requireMember(ctx, args.workspaceId);
    if (
      !permitted.has(args.contentType) ||
      !Number.isSafeInteger(args.size) ||
      args.size <= 0 ||
      args.size > MAX_BYTES
    )
      fail("Use a supported file no larger than 256 KB.");
    const existing = await ctx.db
      .query("fileRecords")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
      )
      .take(101);
    if (existing.length >= 100) fail("File limit reached.");
    const recordId = await ctx.db.insert("fileRecords", {
      ...args,
      name: bounded(args.name, 160, "Filename"),
      ownerId: user._id,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: retentionExpiry(workspace),
    });
    await scheduleRecordExpiry(ctx, recordId);
    return recordId;
  },
});
export const complete = internalMutation({
  args: { fileId: v.id("fileRecords"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.fileId);
    await requireOwnerRecord(ctx, row);
    if (
      !row ||
      row.status !== "pending" ||
      row.createdAt + 300000 <= Date.now()
    )
      fail("Upload expired.");
    const metadata = await ctx.db.system.get(args.storageId);
    // MIME metadata is optional in Convex's storage schema. This internal path
    // only binds blobs created by upload(), which supplies the reserved type.
    if (
      !metadata ||
      metadata.size !== row.size ||
      (metadata.contentType !== undefined &&
        metadata.contentType !== row.contentType)
    )
      fail("File metadata did not match the upload.");
    await ctx.db.patch(row._id, { storageId: args.storageId, status: "ready" });
    return row._id;
  },
});
export const upload = action({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    contentType: v.string(),
    base64: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"fileRecords">> => {
    // The server binds the stored blob to a reservation. No public mutation accepts
    // an arbitrary storage ID that could point at another owner's file.
    if (
      args.base64.length > 350000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(args.base64)
    )
      fail("File encoding is invalid or too large.");
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(args.base64), (char) => char.charCodeAt(0));
    } catch {
      fail("File encoding is invalid.");
    }
    const fileId: Id<"fileRecords"> = await ctx.runMutation(
      internal.files.reserve,
      {
        workspaceId: args.workspaceId,
        name: args.name,
        contentType: args.contentType,
        size: bytes.byteLength,
      },
    );
    const storageId = await ctx.storage.store(
      new Blob([bytes.buffer as ArrayBuffer], { type: args.contentType }),
    );
    try {
      return await ctx.runMutation(internal.files.complete, {
        fileId,
        storageId,
      });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
  },
});
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId);
    const rows = await ctx.db
      .query("fileRecords")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .order("desc")
      .take(100);
    return rows
      .filter(
        (row) =>
          row.status === "ready" &&
          row.expiresAt > Date.now() &&
          row.createdAt + workspace.retentionDays * 86400000 > Date.now(),
      )
      .map(({ storageId: _storageId, ...row }) => row);
  },
});
export const readable = internalQuery({
  args: { fileId: v.id("fileRecords") },
  handler: async (ctx, { fileId }) => {
    const row = await ctx.db.get(fileId);
    const { workspace } = await requireOwnerRecord(ctx, row);
    if (
      !row ||
      row.status !== "ready" ||
      !row.storageId ||
      row.expiresAt <= Date.now() ||
      row.createdAt + workspace.retentionDays * 86400000 <= Date.now()
    )
      fail();
    return {
      name: row.name,
      contentType: row.contentType,
      storageId: row.storageId,
    };
  },
});
export const download = action({
  args: { fileId: v.id("fileRecords") },
  handler: async (
    ctx,
    args,
  ): Promise<{ name: string; contentType: string; base64: string }> => {
    const before = await ctx.runQuery(internal.files.readable, args);
    const blob = await ctx.storage.get(before.storageId);
    if (!blob || blob.size > MAX_BYTES) fail();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const after = await ctx.runQuery(internal.files.readable, args);
    if (after.storageId !== before.storageId) fail();
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // Deliver through the authenticated action rather than issuing a public blob URL.
    return {
      name: after.name,
      contentType: after.contentType,
      base64: btoa(binary),
    };
  },
});
export const remove = mutation({
  args: { fileId: v.id("fileRecords") },
  handler: async (ctx, { fileId }) => {
    const row = await ctx.db.get(fileId);
    const { workspace } = await requireOwnerRecord(ctx, row);
    if (!row) fail();
    if (workspace.preservationHold)
      fail("A preservation hold prevents file deletion.");
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.patch(row._id, { status: "deleted", storageId: undefined });
  },
});
