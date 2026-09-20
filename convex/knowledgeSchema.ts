import { defineTable } from "convex/server";
import { v } from "convex/values";

export const entityKind = v.union(
  v.literal("person"),
  v.literal("company"),
  v.literal("project"),
  v.literal("preference"),
  v.literal("goal"),
  v.literal("decision"),
  v.literal("note"),
  v.literal("account"),
  v.literal("identity"),
  v.literal("event"),
  v.literal("commitment"),
  v.literal("instruction"),
);
export const sourceRef = v.object({
  sourceId: v.id("sources"),
  revision: v.number(),
});
export const relationshipKind = v.union(
  v.literal("works_with"),
  v.literal("belongs_to"),
  v.literal("related_to"),
  v.literal("same_as"),
);
const owned = { workspaceId: v.id("workspaces"), ownerId: v.id("users") };

export const coreTables = {
  users: defineTable({
    tokenIdentifier: v.string(),
    issuer: v.string(),
    subject: v.string(),
    displayName: v.string(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    createdAt: v.number(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_identity", ["issuer", "subject"]),
  workspaceAdmissions: defineTable({
    workspaceId: v.id("workspaces"),
    issuer: v.string(),
    subject: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
    status: v.union(
      v.literal("pending"),
      v.literal("consumed"),
      v.literal("revoked"),
    ),
    revision: v.number(),
    assignedBy: v.id("users"),
    assignedAt: v.number(),
    consumedBy: v.optional(v.id("users")),
    consumedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_identity_status", ["issuer", "subject", "status"])
    .index("by_target", ["workspaceId", "issuer", "subject"])
    .index("by_workspace", ["workspaceId"]),
  workspaces: defineTable({
    name: v.string(),
    slug: v.string(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    retentionDays: v.number(),
    preservationHold: v.boolean(),
  }).index("by_creator", ["createdBy"]),
  memberships: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    status: v.union(v.literal("active"), v.literal("suspended")),
    createdAt: v.number(),
  })
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"]),
};

export const knowledgeTables = {
  sourceGrants: defineTable({
    ...owned,
    provider: v.string(),
    externalAccountId: v.string(),
    revision: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("revoked"),
      v.literal("paused"),
    ),
    verifiedUntil: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_account", [
    "workspaceId",
    "ownerId",
    "provider",
    "externalAccountId",
  ]),
  sources: defineTable({
    ...owned,
    kind: v.union(v.literal("manual"), v.literal("connector")),
    title: v.string(),
    text: v.string(),
    sourceKey: v.optional(v.string()),
    sourceVersion: v.optional(v.string()),
    revision: v.number(),
    grantId: v.optional(v.id("sourceGrants")),
    grantRevision: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("retired")),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_owner", ["workspaceId", "ownerId"])
    .index("by_origin", ["workspaceId", "ownerId", "grantId", "sourceKey"]),
  entities: defineTable({
    ...owned,
    kind: entityKind,
    title: v.string(),
    summary: v.string(),
    searchText: v.string(),
    aliases: v.array(v.string()),
    sourceRefs: v.array(sourceRef),
    evidence: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_owner", ["workspaceId", "ownerId"])
    .searchIndex("search_entities", {
      searchField: "searchText",
      filterFields: ["workspaceId", "ownerId", "status"],
    }),
  relationships: defineTable({
    ...owned,
    fromId: v.id("entities"),
    toId: v.id("entities"),
    kind: relationshipKind,
    description: v.string(),
    sourceRefs: v.array(sourceRef),
    status: v.union(
      v.literal("proposed"),
      v.literal("accepted"),
      v.literal("dismissed"),
    ),
    revision: v.number(),
    createdAt: v.number(),
  }).index("by_owner", ["workspaceId", "ownerId"]),
  identityReviews: defineTable({
    ...owned,
    leftId: v.id("entities"),
    rightId: v.id("entities"),
    leftRevision: v.number(),
    rightRevision: v.number(),
    reason: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("same"),
      v.literal("different"),
    ),
    revision: v.number(),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index("by_owner", ["workspaceId", "ownerId"]),
  wikiPages: defineTable({
    ...owned,
    title: v.string(),
    body: v.string(),
    entityIds: v.array(v.id("entities")),
    entityRevisions: v.array(v.number()),
    sourceRefs: v.array(sourceRef),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_owner", ["workspaceId", "ownerId"]),
  corrections: defineTable({
    ...owned,
    entityId: v.id("entities"),
    previousRevision: v.number(),
    revision: v.number(),
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_entity", ["entityId"]),
  fileRecords: defineTable({
    ...owned,
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
    storageId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("deleted"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_owner", ["workspaceId", "ownerId"]),
};
