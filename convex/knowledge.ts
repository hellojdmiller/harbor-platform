import { v } from "convex/values";
import { internal } from "./_generated/api";
import { scheduleRecordExpiry } from "./lib/knowledgeRetention";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { entityKind, relationshipKind, sourceRef } from "./knowledgeSchema";
import {
  referencesVisible,
  entityVisible,
  runContextVisible,
} from "./lib/knowledgeAccess";
import {
  bounded,
  fail,
  requireMember,
  requireOwnerRecord,
  requireRevision,
  requireInternalMember,
  retentionExpiry,
} from "./lib/auth";

type ReadCtx = QueryCtx | MutationCtx;
type Reference = { sourceId: Id<"sources">; revision: number };
const scopeArgs = { workspaceId: v.id("workspaces") };
function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("A valid revision is required.");
}
function aliases(values: string[]) {
  if (values.length > 8) fail("Use at most eight aliases.");
  return [...new Set(values.map((x) => bounded(x, 100, "Alias")))];
}

async function requireReferences(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  ownerId: Id<"users">,
  refs: Reference[],
) {
  if (!(await referencesVisible(ctx, workspaceId, ownerId, refs)))
    fail("A source changed, expired, or is no longer authorized.");
}

export const validateContext = internalQuery({
  args: {
    ...scopeArgs,
    ownerId: v.id("users"),
    refs: v.array(
      v.object({ entityId: v.id("entities"), revision: v.number() }),
    ),
  },
  handler: async (ctx, args) =>
    runContextVisible(ctx, args.workspaceId, args.ownerId, args.refs),
});
async function ownEntity(ctx: ReadCtx, id: Id<"entities">) {
  const entity = await ctx.db.get(id);
  await requireOwnerRecord(ctx, entity);
  if (!entity || !(await entityVisible(ctx, entity))) fail();
  return entity;
}
async function entityExpiry(ctx: ReadCtx, refs: Reference[], maximum: number) {
  let expiresAt = maximum;
  for (const ref of refs)
    expiresAt = Math.min(
      expiresAt,
      (await ctx.db.get(ref.sourceId))!.expiresAt,
    );
  return expiresAt;
}

export const createSource = mutation({
  args: { ...scopeArgs, title: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<Id<"sources">> => {
    const { user, workspace } = await requireMember(ctx, args.workspaceId);
    const current = await ctx.db
      .query("sources")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
      )
      .take(101);
    if (current.length >= 100) fail("Source limit reached.");
    const recordId = await ctx.db.insert("sources", {
      workspaceId: args.workspaceId,
      ownerId: user._id,
      kind: "manual",
      title: bounded(args.title, 200, "Title"),
      text: bounded(args.text, 12000, "Source"),
      revision: 1,
      status: "active",
      createdAt: Date.now(),
      expiresAt: retentionExpiry(workspace),
    });
    await scheduleRecordExpiry(ctx, recordId);
    return recordId;
  },
});
export const listSources = query({
  args: scopeArgs,
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireMember(ctx, workspaceId);
    const rows = await ctx.db
      .query("sources")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .order("desc")
      .take(100);
    const visible = [];
    for (const row of rows)
      if (
        await referencesVisible(ctx, workspaceId, user._id, [
          { sourceId: row._id, revision: row.revision },
        ])
      )
        visible.push({
          _id: row._id,
          title: row.title,
          kind: row.kind,
          revision: row.revision,
          expiresAt: row.expiresAt,
        });
    return visible;
  },
});
export const getSource = query({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const source = await ctx.db.get(sourceId);
    await requireOwnerRecord(ctx, source);
    if (!source) fail();
    await requireReferences(ctx, source.workspaceId, source.ownerId, [
      { sourceId, revision: source.revision },
    ]);
    return source;
  },
});
export const retireSource = mutation({
  args: { sourceId: v.id("sources"), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    await requireOwnerRecord(ctx, source);
    if (!source) fail();
    requireRevision(source.revision, args.expectedRevision);
    await ctx.db.patch(source._id, {
      status: "retired",
      revision: source.revision + 1,
    });
  },
});

export const createEntity = mutation({
  args: {
    ...scopeArgs,
    kind: entityKind,
    title: v.string(),
    summary: v.string(),
    aliases: v.array(v.string()),
    sourceRefs: v.array(sourceRef),
    evidence: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"entities">> => {
    const { user, workspace } = await requireMember(ctx, args.workspaceId);
    await requireReferences(ctx, args.workspaceId, user._id, args.sourceRefs);
    if (args.sourceRefs.length) {
      const quote = bounded(args.evidence ?? "", 2000, "Evidence");
      const source = await ctx.db.get(args.sourceRefs[0].sourceId);
      if (!source?.text.includes(quote))
        fail("Evidence must quote the selected source exactly.");
    }
    const rows = await ctx.db
      .query("entities")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
      )
      .take(501);
    if (rows.length >= 500) fail("Knowledge limit reached.");
    const title = bounded(args.title, 160, "Title"),
      summary = bounded(args.summary, 4000, "Summary"),
      names = aliases(args.aliases);
    const recordId = await ctx.db.insert("entities", {
      workspaceId: args.workspaceId,
      ownerId: user._id,
      kind: args.kind,
      title,
      summary,
      aliases: names,
      searchText: `${title}\n${summary}\n${names.join(" ")}`,
      sourceRefs: args.sourceRefs,
      ...(args.sourceRefs.length ? { evidence: args.evidence!.trim() } : {}),
      status: args.sourceRefs.length ? "draft" : "active",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: await entityExpiry(
        ctx,
        args.sourceRefs,
        retentionExpiry(workspace),
      ),
    });
    await scheduleRecordExpiry(ctx, recordId);
    return recordId;
  },
});
export const decideEntity = mutation({
  args: {
    entityId: v.id("entities"),
    expectedRevision: v.number(),
    decision: v.union(v.literal("approve"), v.literal("dismiss")),
  },
  handler: async (ctx, args) => {
    const entity = await ownEntity(ctx, args.entityId);
    requireRevision(entity.revision, args.expectedRevision);
    if (entity.status !== "draft")
      fail("This knowledge has already been reviewed.");
    await ctx.db.patch(entity._id, {
      status: args.decision === "approve" ? "active" : "archived",
      revision: entity.revision + 1,
      updatedAt: Date.now(),
    });
  },
});
export const correctEntity = mutation({
  args: {
    entityId: v.id("entities"),
    expectedRevision: v.number(),
    title: v.string(),
    summary: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const entity = await ownEntity(ctx, args.entityId);
    const { workspace } = await requireOwnerRecord(ctx, entity);
    if (workspace.preservationHold)
      fail("A preservation hold prevents replacing saved content.");
    requireRevision(entity.revision, args.expectedRevision);
    const title = bounded(args.title, 160, "Title"),
      summary = bounded(args.summary, 4000, "Summary");
    await ctx.db.patch(entity._id, {
      title,
      summary,
      searchText: `${title}\n${summary}\n${entity.aliases.join(" ")}`,
      revision: entity.revision + 1,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("corrections", {
      workspaceId: entity.workspaceId,
      ownerId: entity.ownerId,
      entityId: entity._id,
      previousRevision: entity.revision,
      revision: entity.revision + 1,
      reason: bounded(args.reason, 500, "Reason"),
      createdAt: Date.now(),
    });
    return entity.revision + 1;
  },
});
export const list = query({
  args: { ...scopeArgs, search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.workspaceId);
    const search = args.search?.trim();
    if (search && (search.length > 200 || search.split(/\s+/).length > 16))
      fail("Use a shorter search.");
    const rows = search
      ? await ctx.db
          .query("entities")
          .withSearchIndex("search_entities", (q) =>
            q
              .search("searchText", search)
              .eq("workspaceId", args.workspaceId)
              .eq("ownerId", user._id)
              .eq("status", "active"),
          )
          .take(50)
      : await ctx.db
          .query("entities")
          .withIndex("by_owner", (q) =>
            q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
          )
          .order("desc")
          .take(100);
    const visible = [];
    for (const entity of rows)
      if (await entityVisible(ctx, entity)) visible.push(entity);
    return visible;
  },
});

export const createRelationship = mutation({
  args: {
    fromId: v.id("entities"),
    toId: v.id("entities"),
    kind: relationshipKind,
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const from = await ownEntity(ctx, args.fromId),
      to = await ownEntity(ctx, args.toId);
    if (
      from._id === to._id ||
      from.workspaceId !== to.workspaceId ||
      from.ownerId !== to.ownerId ||
      from.status !== "active" ||
      to.status !== "active"
    )
      fail();
    if (args.kind === "same_as")
      fail("Resolve possible identities through Identity review.");
    const refs = [
      ...new Map(
        [...from.sourceRefs, ...to.sourceRefs].map((ref) => [
          ref.sourceId,
          ref,
        ]),
      ).values(),
    ];
    await requireReferences(ctx, from.workspaceId, from.ownerId, refs);
    return ctx.db.insert("relationships", {
      workspaceId: from.workspaceId,
      ownerId: from.ownerId,
      fromId: from._id,
      toId: to._id,
      kind: args.kind,
      description: bounded(args.description, 500, "Description"),
      sourceRefs: refs,
      status: "proposed",
      revision: 1,
      createdAt: Date.now(),
    });
  },
});
export const decideRelationship = mutation({
  args: {
    relationshipId: v.id("relationships"),
    expectedRevision: v.number(),
    decision: v.union(v.literal("accept"), v.literal("dismiss")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.relationshipId);
    await requireOwnerRecord(ctx, row);
    if (!row) fail();
    await ownEntity(ctx, row.fromId);
    await ownEntity(ctx, row.toId);
    await requireReferences(ctx, row.workspaceId, row.ownerId, row.sourceRefs);
    requireRevision(row.revision, args.expectedRevision);
    if (row.status !== "proposed")
      fail("This relationship was already reviewed.");
    await ctx.db.patch(row._id, {
      status: args.decision === "accept" ? "accepted" : "dismissed",
      revision: row.revision + 1,
    });
  },
});
export const proposeIdentity = mutation({
  args: {
    leftId: v.id("entities"),
    rightId: v.id("entities"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const left = await ownEntity(ctx, args.leftId),
      right = await ownEntity(ctx, args.rightId);
    if (
      left._id === right._id ||
      left.workspaceId !== right.workspaceId ||
      left.ownerId !== right.ownerId ||
      left.kind !== right.kind ||
      !["person", "company"].includes(left.kind)
    )
      fail();
    return ctx.db.insert("identityReviews", {
      workspaceId: left.workspaceId,
      ownerId: left.ownerId,
      leftId: left._id,
      rightId: right._id,
      leftRevision: left.revision,
      rightRevision: right.revision,
      reason: bounded(args.reason, 500, "Reason"),
      status: "pending",
      revision: 1,
      createdAt: Date.now(),
    });
  },
});
export const decideIdentity = mutation({
  args: {
    reviewId: v.id("identityReviews"),
    expectedRevision: v.number(),
    decision: v.union(v.literal("same"), v.literal("different")),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    await requireOwnerRecord(ctx, review);
    if (!review) fail();
    requireRevision(review.revision, args.expectedRevision);
    const left = await ownEntity(ctx, review.leftId),
      right = await ownEntity(ctx, review.rightId);
    requireRevision(left.revision, review.leftRevision);
    requireRevision(right.revision, review.rightRevision);
    if (review.status !== "pending")
      fail("This identity was already reviewed.");
    await ctx.db.patch(review._id, {
      status: args.decision,
      revision: review.revision + 1,
      decidedAt: Date.now(),
    });
    // Keep both records: a reviewed identity link is reversible; no automatic merge.
    if (args.decision === "same") {
      const refs = [
        ...new Map(
          [...left.sourceRefs, ...right.sourceRefs].map((ref) => [
            ref.sourceId,
            ref,
          ]),
        ).values(),
      ];
      await requireReferences(ctx, left.workspaceId, left.ownerId, refs);
      await ctx.db.insert("relationships", {
        workspaceId: left.workspaceId,
        ownerId: left.ownerId,
        fromId: left._id,
        toId: right._id,
        kind: "same_as",
        description: "Identity confirmed by the owner",
        sourceRefs: refs,
        status: "accepted",
        revision: 1,
        createdAt: Date.now(),
      });
    }
  },
});
export const wiki = query({
  args: scopeArgs,
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireMember(ctx, workspaceId);
    const rows = await ctx.db
      .query("entities")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .take(500);
    const entities = [];
    for (const row of rows)
      if (row.status === "active" && (await entityVisible(ctx, row)))
        entities.push(row);
    const ids = new Set(entities.map((row) => row._id));
    const links = await ctx.db
      .query("relationships")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .take(200);
    const relationships = [];
    for (const link of links)
      if (
        link.status === "accepted" &&
        ids.has(link.fromId) &&
        ids.has(link.toId) &&
        (await referencesVisible(ctx, workspaceId, user._id, link.sourceRefs))
      )
        relationships.push(link);
    const reviews = await ctx.db
      .query("identityReviews")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .take(100);
    return {
      entities,
      relationships,
      identityReviews: reviews.filter(
        (review) => ids.has(review.leftId) && ids.has(review.rightId),
      ),
      generatedAt: Date.now(),
    };
  },
});

async function pageVisible(ctx: ReadCtx, page: Doc<"wikiPages">) {
  const workspace = await ctx.db.get(page.workspaceId);
  if (
    !workspace ||
    page.expiresAt <= Date.now() ||
    page.createdAt + workspace.retentionDays * 86400000 <= Date.now() ||
    !(await referencesVisible(
      ctx,
      page.workspaceId,
      page.ownerId,
      page.sourceRefs,
    ))
  )
    return false;
  if (page.entityIds.length !== page.entityRevisions.length) return false;
  for (let index = 0; index < page.entityIds.length; index++) {
    const entity = await ctx.db.get(page.entityIds[index]);
    if (
      !entity ||
      entity.workspaceId !== page.workspaceId ||
      entity.ownerId !== page.ownerId ||
      entity.status !== "active" ||
      entity.revision !== page.entityRevisions[index] ||
      !(await entityVisible(ctx, entity))
    )
      return false;
  }
  return true;
}

export const pages = query({
  args: scopeArgs,
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireMember(ctx, workspaceId);
    const rows = await ctx.db
      .query("wikiPages")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", user._id),
      )
      .order("desc")
      .take(50);
    const visible = [];
    for (const row of rows) if (await pageVisible(ctx, row)) visible.push(row);
    return visible;
  },
});

export const createPage = mutation({
  args: {
    ...scopeArgs,
    title: v.string(),
    entityIds: v.array(v.id("entities")),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"wikiPages">> => {
    const { user, workspace } = await requireMember(ctx, args.workspaceId);
    if (
      args.entityIds.length > 12 ||
      new Set(args.entityIds).size !== args.entityIds.length
    )
      fail("Select up to twelve distinct knowledge entries.");
    const retained = await ctx.db
      .query("wikiPages")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", user._id),
      )
      .take(51);
    if (retained.length >= 50) fail("Wiki page limit reached.");
    const entities = [];
    for (const id of args.entityIds) {
      const entity = await ownEntity(ctx, id);
      if (entity.workspaceId !== args.workspaceId || entity.status !== "active")
        fail("Only approved knowledge can support a wiki page.");
      entities.push(entity);
    }
    const refs = [
      ...new Map(
        entities
          .flatMap((entity) => entity.sourceRefs)
          .map((ref) => [ref.sourceId, ref]),
      ).values(),
    ];
    await requireReferences(ctx, args.workspaceId, user._id, refs);
    const body =
      args.body ??
      entities
        .map((entity) => `## ${entity.title}\n\n${entity.summary}`)
        .join("\n\n");
    if (body.length > 16000)
      fail("Wiki pages support up to 16,000 characters.");
    // Pages are an editable presentation. Their prose is never promoted to facts
    // or placed in model context; the separate entity review controls that path.
    const recordId = await ctx.db.insert("wikiPages", {
      workspaceId: args.workspaceId,
      ownerId: user._id,
      title: bounded(args.title, 160, "Title"),
      body,
      entityIds: args.entityIds,
      entityRevisions: entities.map((entity) => entity.revision),
      sourceRefs: refs,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Math.min(
        retentionExpiry(workspace),
        ...entities.map((entity) => entity.expiresAt),
      ),
    });
    await scheduleRecordExpiry(ctx, recordId);
    return recordId;
  },
});

export const savePage = mutation({
  args: {
    pageId: v.id("wikiPages"),
    expectedRevision: v.number(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    const { workspace } = await requireOwnerRecord(ctx, page);
    if (!page || !(await pageVisible(ctx, page)))
      fail(
        "The wiki page or its supporting knowledge changed or is unavailable.",
      );
    requireRevision(page.revision, args.expectedRevision);
    if (workspace.preservationHold)
      fail("A preservation hold prevents replacing saved content.");
    if (args.body.length > 16000)
      fail("Wiki pages support up to 16,000 characters.");
    await ctx.db.patch(page._id, {
      body: args.body,
      revision: page.revision + 1,
      updatedAt: Date.now(),
    });
    return { pageId: page._id, revision: page.revision + 1 };
  },
});

const grantArgs = {
  ...scopeArgs,
  ownerId: v.id("users"),
  provider: v.string(),
  externalAccountId: v.string(),
  revision: v.number(),
  status: v.union(
    v.literal("active"),
    v.literal("revoked"),
    v.literal("paused"),
  ),
  verifiedUntil: v.number(),
};
export const syncGrant = internalMutation({
  args: grantArgs,
  handler: async (ctx, args): Promise<Id<"sourceGrants">> => {
    await requireInternalMember(ctx, args.workspaceId, args.ownerId);
    integer(args.revision);
    bounded(args.provider, 50, "Provider");
    bounded(args.externalAccountId, 256, "Account");
    if (
      !Number.isFinite(args.verifiedUntil) ||
      args.verifiedUntil > Date.now() + 300000
    )
      fail("Grant verification cannot exceed five minutes.");
    const existing = await ctx.db
      .query("sourceGrants")
      .withIndex("by_account", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("ownerId", args.ownerId)
          .eq("provider", args.provider)
          .eq("externalAccountId", args.externalAccountId),
      )
      .unique();
    if (existing) {
      if (
        args.revision < existing.revision ||
        (args.revision === existing.revision &&
          existing.status !== "active" &&
          args.status === "active")
      )
        fail("A fresh grant revision is required.");
      await ctx.db.patch(existing._id, { ...args, updatedAt: Date.now() });
      if (args.status === "active" && args.verifiedUntil > Date.now())
        await ctx.scheduler.runAt(
          args.verifiedUntil,
          internal.knowledge.expireGrantLease,
          {
            grantId: existing._id,
            revision: args.revision,
            verifiedUntil: args.verifiedUntil,
          },
        );
      return existing._id;
    }
    const grantId = await ctx.db.insert("sourceGrants", {
      ...args,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (args.status === "active" && args.verifiedUntil > Date.now())
      await ctx.scheduler.runAt(
        args.verifiedUntil,
        internal.knowledge.expireGrantLease,
        {
          grantId,
          revision: args.revision,
          verifiedUntil: args.verifiedUntil,
        },
      );
    return grantId;
  },
});
export const expireGrantLease = internalMutation({
  args: {
    grantId: v.id("sourceGrants"),
    revision: v.number(),
    verifiedUntil: v.number(),
  },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (
      !grant ||
      grant.status !== "active" ||
      grant.revision !== args.revision ||
      grant.verifiedUntil !== args.verifiedUntil ||
      grant.verifiedUntil > Date.now()
    )
      return;
    // Time alone does not rerun reactive queries. This metadata-only write
    // invalidates cached knowledge reads without deleting preserved content.
    await ctx.db.patch(grant._id, { verifiedUntil: 0, updatedAt: Date.now() });
  },
});
export const importSource = internalMutation({
  args: {
    ...scopeArgs,
    ownerId: v.id("users"),
    provider: v.string(),
    externalAccountId: v.string(),
    sourceKey: v.string(),
    sourceVersion: v.string(),
    title: v.string(),
    text: v.string(),
    grantRevision: v.number(),
    verifiedUntil: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"sources">> => {
    const { workspace } = await requireInternalMember(
      ctx,
      args.workspaceId,
      args.ownerId,
    );
    integer(args.grantRevision);
    const grant = await ctx.db
      .query("sourceGrants")
      .withIndex("by_account", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("ownerId", args.ownerId)
          .eq("provider", args.provider)
          .eq("externalAccountId", args.externalAccountId),
      )
      .unique();
    if (
      !grant ||
      grant.status !== "active" ||
      grant.revision !== args.grantRevision ||
      grant.verifiedUntil <= Date.now() ||
      args.verifiedUntil !== grant.verifiedUntil
    )
      fail("Verify the current owner grant before importing.");
    const sourceKey = bounded(args.sourceKey, 512, "Source key"),
      sourceVersion = bounded(args.sourceVersion, 256, "Source version"),
      title = bounded(args.title, 200, "Title"),
      text = bounded(args.text, 12000, "Source");
    if (!Number.isFinite(args.expiresAt) || args.expiresAt <= Date.now())
      fail("Source expiry is invalid.");
    const old = await ctx.db
      .query("sources")
      .withIndex("by_origin", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("ownerId", args.ownerId)
          .eq("grantId", grant._id)
          .eq("sourceKey", sourceKey),
      )
      .order("desc")
      .take(100);
    const same = old.find(
      (row) =>
        row.status === "active" &&
        row.sourceVersion === sourceVersion &&
        row.grantRevision === args.grantRevision &&
        row.text === text &&
        row.title === title &&
        row.expiresAt > Date.now(),
    );
    if (same) return same._id;
    const retained = await ctx.db
      .query("sources")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("ownerId", args.ownerId),
      )
      .take(101);
    if (retained.length >= 100) fail("Source limit reached.");
    for (const row of old)
      if (row.status === "active")
        await ctx.db.patch(row._id, {
          status: "retired",
          revision: row.revision + 1,
        });
    const recordId = await ctx.db.insert("sources", {
      workspaceId: args.workspaceId,
      ownerId: args.ownerId,
      kind: "connector",
      grantId: grant._id,
      grantRevision: grant.revision,
      sourceKey,
      sourceVersion,
      title,
      text,
      revision: 1,
      status: "active",
      createdAt: Date.now(),
      expiresAt: Math.min(args.expiresAt, retentionExpiry(workspace)),
    });
    await scheduleRecordExpiry(ctx, recordId);
    return recordId;
  },
});
export const contextForRun = internalQuery({
  args: { ...scopeArgs, ownerId: v.id("users") },
  handler: async (ctx, { workspaceId, ownerId }) => {
    await requireInternalMember(ctx, workspaceId, ownerId);
    const rows = await ctx.db
      .query("entities")
      .withIndex("by_owner", (q) =>
        q.eq("workspaceId", workspaceId).eq("ownerId", ownerId),
      )
      .order("desc")
      .take(100);
    const result = [];
    let remaining = 12000;
    for (const row of rows) {
      if (row.status !== "active" || !(await entityVisible(ctx, row))) continue;
      const size = row.title.length + row.summary.length;
      if (size > remaining) continue;
      result.push({
        entityId: row._id,
        revision: row.revision,
        title: row.title,
        summary: row.summary,
        sourceRefs: row.sourceRefs,
      });
      remaining -= size;
      if (result.length === 12) break;
    }
    return result;
  },
});

export const expireRecord = internalMutation({
  args: {
    recordId: v.union(
      v.id("sources"),
      v.id("entities"),
      v.id("wikiPages"),
      v.id("fileRecords"),
    ),
    expectedExpiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const record = await ctx.db.get(args.recordId);
    if (
      !record ||
      record.expiresAt === 0 ||
      record.expiresAt !== args.expectedExpiresAt
    )
      return;
    const workspace = await ctx.db.get(record.workspaceId);
    if (!workspace) return;
    const deadline = Math.min(
      record.expiresAt,
      record.createdAt + workspace.retentionDays * 86400000,
    );
    if (deadline > Date.now()) return;
    // Expiry is immutable across corrections. Retiring eligibility alone
    // invalidates subscriptions and preserves bytes, including under a hold.
    await ctx.db.patch(args.recordId, { expiresAt: 0 });
  },
});
