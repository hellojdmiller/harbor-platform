/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("HARBOR_ALLOW_SELF_SERVICE_WORKSPACES", "true");
  vi.stubEnv("OIDC_ISSUER", "https://identity.example.test");
  vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", JSON.stringify(["alex", "blair"]));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup() {
  const t = convexTest(schema, modules);
  const alex = t.withIdentity({
    issuer: "https://identity.example.test",
    subject: "alex",
    tokenIdentifier: "https://identity.example.test|alex",
    name: "Alex Example",
  });
  const blair = t.withIdentity({
    issuer: "https://identity.example.test",
    subject: "blair",
    tokenIdentifier: "https://identity.example.test|blair",
    name: "Blair Example",
  });
  const a = await alex.mutation(api.workspaces.bootstrap, {});
  const b = await blair.mutation(api.workspaces.bootstrap, {});
  // Keep test timers below the host timer limit; production defaults remain 90 days.
  await t.run(async (ctx) => {
    await ctx.db.patch(a.workspaceId, { retentionDays: 1 });
    await ctx.db.patch(b.workspaceId, { retentionDays: 1 });
  });
  return { t, alex, blair, a, b };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function manual(f: Fixture, title = "Atlas project") {
  return f.alex.mutation(api.knowledge.createEntity, {
    workspaceId: f.a.workspaceId,
    title,
    kind: "project",
    summary: "Fictional Atlas diligence project",
    aliases: [],
    sourceRefs: [],
  });
}
async function connected(f: Fixture) {
  const verifiedUntil = Date.now() + 60000;
  const grantId = await f.t.mutation(internal.knowledge.syncGrant, {
    workspaceId: f.a.workspaceId,
    ownerId: f.a.userId,
    provider: "fixture",
    externalAccountId: "fictional-account",
    revision: 1,
    status: "active",
    verifiedUntil,
  });
  const sourceId = await f.t.mutation(internal.knowledge.importSource, {
    workspaceId: f.a.workspaceId,
    ownerId: f.a.userId,
    provider: "fixture",
    externalAccountId: "fictional-account",
    sourceKey: "fictional-message",
    sourceVersion: "v1",
    title: "Atlas weekly update",
    text: "The fictional Atlas project uses Friday updates.",
    grantRevision: 1,
    verifiedUntil,
    expiresAt: Date.now() + 86400000,
  });
  const entityId = await f.alex.mutation(api.knowledge.createEntity, {
    workspaceId: f.a.workspaceId,
    kind: "project",
    title: "Atlas project",
    summary: "Friday updates",
    aliases: [],
    sourceRefs: [{ sourceId, revision: 1 }],
    evidence: "Friday updates",
  });
  await f.alex.mutation(api.knowledge.decideEntity, {
    entityId,
    expectedRevision: 1,
    decision: "approve",
  });
  return { grantId, sourceId, entityId, verifiedUntil };
}

describe("verified identity and tenant ownership", () => {
  test("denies anonymous queries and cannot trust a client owner field", async () => {
    const f = await setup();
    await expect(f.t.query(api.workspaces.list, {})).rejects.toThrow("Sign in");
    await expect(f.t.mutation(api.workspaces.bootstrap, {})).rejects.toThrow(
      "Sign in",
    );
    await expect(
      f.alex.mutation(api.knowledge.createSource, {
        workspaceId: f.a.workspaceId,
        title: "No",
        text: "No",
        // @ts-expect-error Exercise runtime rejection of a spoofed owner.
        ownerId: f.b.userId,
      }),
    ).rejects.toThrow();
  });
  test("same subject at a different issuer cannot inherit ownership", async () => {
    const f = await setup();
    await manual(f);
    const impostor = f.t.withIdentity({
      issuer: "https://other.example.test",
      subject: "alex",
      tokenIdentifier: "https://other.example.test|alex",
    });
    await impostor.mutation(api.workspaces.bootstrap, {});
    await expect(
      impostor.query(api.knowledge.list, { workspaceId: f.a.workspaceId }),
    ).rejects.toThrow();
  });
  test("workspace admins cannot read another member's personal knowledge", async () => {
    const f = await setup();
    const entityId = await manual(f);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        workspaceId: f.a.workspaceId,
        userId: f.b.userId,
        role: "admin",
        status: "active",
        createdAt: Date.now(),
      });
    });
    expect(
      await f.blair.query(api.knowledge.list, { workspaceId: f.a.workspaceId }),
    ).toEqual([]);
    await expect(
      f.blair.mutation(api.knowledge.correctEntity, {
        entityId,
        expectedRevision: 1,
        title: "Stolen",
        summary: "No",
        reason: "No",
      }),
    ).rejects.toThrow();
  });
  test("suspension immediately denies reads and internal provider paths", async () => {
    const f = await setup();
    await manual(f);
    await f.t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", f.a.workspaceId).eq("userId", f.a.userId),
        )
        .unique();
      await ctx.db.patch(m!._id, { status: "suspended" });
    });
    await expect(
      f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }),
    ).rejects.toThrow();
    await expect(
      f.t.query(internal.knowledge.contextForRun, {
        workspaceId: f.a.workspaceId,
        ownerId: f.a.userId,
      }),
    ).rejects.toThrow();
  });
});

describe("provenance and owner review", () => {
  test("requires exact evidence and approval before sourced knowledge enters the wiki", async () => {
    const f = await setup();
    const sourceId = await f.alex.mutation(api.knowledge.createSource, {
      workspaceId: f.a.workspaceId,
      title: "Fictional notes",
      text: "Atlas prefers Friday updates.",
    });
    const args = {
      workspaceId: f.a.workspaceId,
      kind: "project" as const,
      title: "Atlas",
      summary: "Friday updates",
      aliases: [],
      sourceRefs: [{ sourceId, revision: 1 }],
    };
    await expect(
      f.alex.mutation(api.knowledge.createEntity, {
        ...args,
        evidence: "invented",
      }),
    ).rejects.toThrow("exactly");
    const id = await f.alex.mutation(api.knowledge.createEntity, {
      ...args,
      evidence: "Friday updates",
    });
    expect(
      (await f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }))
        .entities,
    ).toHaveLength(0);
    await f.alex.mutation(api.knowledge.decideEntity, {
      entityId: id,
      expectedRevision: 1,
      decision: "approve",
    });
    const wiki = await f.alex.query(api.knowledge.wiki, {
      workspaceId: f.a.workspaceId,
    });
    expect(wiki.entities[0].evidence).toBe("Friday updates");
  });
  test("does not let one workspace reference another workspace's source", async () => {
    const f = await setup();
    const sourceId = await f.blair.mutation(api.knowledge.createSource, {
      workspaceId: f.b.workspaceId,
      title: "Private",
      text: "Private source",
    });
    await expect(
      f.alex.mutation(api.knowledge.createEntity, {
        workspaceId: f.a.workspaceId,
        kind: "note",
        title: "Leak",
        summary: "Leak",
        aliases: [],
        sourceRefs: [{ sourceId, revision: 1 }],
        evidence: "Private",
      }),
    ).rejects.toThrow();
    await expect(
      f.alex.query(api.knowledge.getSource, { sourceId }),
    ).rejects.toThrow();
  });
  test("paused, expired and revoked grants hide matching search results and agent context", async () => {
    const f = await setup();
    const { grantId } = await connected(f);
    expect(
      await f.alex.query(api.knowledge.list, {
        workspaceId: f.a.workspaceId,
        search: "Atlas",
      }),
    ).toHaveLength(1);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(grantId, { status: "paused" });
    });
    expect(
      await f.alex.query(api.knowledge.list, {
        workspaceId: f.a.workspaceId,
        search: "Atlas",
      }),
    ).toEqual([]);
    expect(
      await f.t.query(internal.knowledge.contextForRun, {
        workspaceId: f.a.workspaceId,
        ownerId: f.a.userId,
      }),
    ).toEqual([]);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(grantId, {
        status: "active",
        verifiedUntil: Date.now() - 1,
      });
    });
    expect(
      (await f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }))
        .entities,
    ).toEqual([]);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(grantId, {
        status: "revoked",
        verifiedUntil: Date.now() + 60000,
      });
    });
    expect(
      await f.alex.query(api.knowledge.listSources, {
        workspaceId: f.a.workspaceId,
      }),
    ).toEqual([]);
  });
  test("a fresh grant revision does not revive previously imported knowledge", async () => {
    const f = await setup();
    await connected(f);
    await f.t.mutation(internal.knowledge.syncGrant, {
      workspaceId: f.a.workspaceId,
      ownerId: f.a.userId,
      provider: "fixture",
      externalAccountId: "fictional-account",
      revision: 2,
      status: "active",
      verifiedUntil: Date.now() + 60000,
    });
    expect(
      (await f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }))
        .entities,
    ).toEqual([]);
  });
  test("source retirement invalidates knowledge while retaining held bytes", async () => {
    const f = await setup();
    const { sourceId, entityId } = await connected(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.a.workspaceId, { preservationHold: true });
    });
    await f.alex.mutation(api.knowledge.retireSource, {
      sourceId,
      expectedRevision: 1,
    });
    expect(
      (await f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }))
        .entities,
    ).toEqual([]);
    expect(
      await f.t.run(async (ctx) => (await ctx.db.get(sourceId))?.text),
    ).toContain("Friday");
    await expect(
      f.alex.mutation(api.knowledge.correctEntity, {
        entityId,
        expectedRevision: 2,
        title: "No",
        summary: "No",
        reason: "No",
      }),
    ).rejects.toThrow();
  });
  test("corrections are revision-bound and preservation holds block replacements", async () => {
    const f = await setup();
    const entityId = await manual(f);
    expect(
      await f.alex.mutation(api.knowledge.correctEntity, {
        entityId,
        expectedRevision: 1,
        title: "Atlas",
        summary: "Monday updates",
        reason: "Owner correction",
      }),
    ).toBe(2);
    await expect(
      f.alex.mutation(api.knowledge.correctEntity, {
        entityId,
        expectedRevision: 1,
        title: "Stale",
        summary: "Stale",
        reason: "Stale",
      }),
    ).rejects.toThrow("changed");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.a.workspaceId, { preservationHold: true });
    });
    await expect(
      f.alex.mutation(api.knowledge.correctEntity, {
        entityId,
        expectedRevision: 2,
        title: "Held",
        summary: "Held",
        reason: "Held",
      }),
    ).rejects.toThrow("hold");
    expect(
      await f.t.run(
        async (ctx) => (await ctx.db.query("corrections").collect()).length,
      ),
    ).toBe(1);
  });
  test("identity review links two records only after owner confirmation", async () => {
    const f = await setup();
    const args = {
      workspaceId: f.a.workspaceId,
      kind: "person" as const,
      summary: "Fictional professional contact",
      aliases: [],
      sourceRefs: [],
    };
    const leftId = await f.alex.mutation(api.knowledge.createEntity, {
      ...args,
      title: "Morgan Example",
    });
    const rightId = await f.alex.mutation(api.knowledge.createEntity, {
      ...args,
      title: "M. Example",
    });
    const reviewId = await f.alex.mutation(api.knowledge.proposeIdentity, {
      leftId,
      rightId,
      reason: "Owner will verify these refer to the same fictional person",
    });
    expect(
      (await f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }))
        .relationships,
    ).toEqual([]);
    await f.alex.mutation(api.knowledge.decideIdentity, {
      reviewId,
      expectedRevision: 1,
      decision: "same",
    });
    const wiki = await f.alex.query(api.knowledge.wiki, {
      workspaceId: f.a.workspaceId,
    });
    expect(wiki.entities).toHaveLength(2);
    expect(wiki.relationships[0].kind).toBe("same_as");
    await expect(
      f.blair.mutation(api.knowledge.decideIdentity, {
        reviewId,
        expectedRevision: 2,
        decision: "different",
      }),
    ).rejects.toThrow();
  });
  test("relationship approval rejects expired provenance", async () => {
    const f = await setup();
    const { entityId, sourceId } = await connected(f);
    const other = await manual(f, "Boreal project");
    const relationshipId = await f.alex.mutation(
      api.knowledge.createRelationship,
      {
        fromId: entityId,
        toId: other,
        kind: "related_to",
        description: "Owner-proposed relationship",
      },
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(sourceId, { expiresAt: Date.now() - 1 });
    });
    await expect(
      f.alex.mutation(api.knowledge.decideRelationship, {
        relationshipId,
        expectedRevision: 1,
        decision: "accept",
      }),
    ).rejects.toThrow();
  });
});

describe("private file ownership", () => {
  test("stores and reads only through authenticated owner actions", async () => {
    const f = await setup();
    const fileId = await f.alex.action(api.files.upload, {
      workspaceId: f.a.workspaceId,
      name: "fictional.txt",
      contentType: "text/plain",
      base64: btoa("Fictional source content"),
    });
    const contents = await f.alex.action(api.files.download, { fileId });
    expect(atob(contents.base64)).toBe("Fictional source content");
    expect(contents).not.toHaveProperty("url");
    await expect(
      f.blair.action(api.files.download, { fileId }),
    ).rejects.toThrow();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.a.workspaceId, { preservationHold: true });
    });
    await expect(f.alex.mutation(api.files.remove, { fileId })).rejects.toThrow(
      "hold",
    );
  });
  test("rejects unsupported types and oversized content before storage", async () => {
    const f = await setup();
    await expect(
      f.alex.action(api.files.upload, {
        workspaceId: f.a.workspaceId,
        name: "script.html",
        contentType: "text/html",
        base64: btoa("<script>no</script>"),
      }),
    ).rejects.toThrow("supported");
    await expect(
      f.alex.action(api.files.upload, {
        workspaceId: f.a.workspaceId,
        name: "large.txt",
        contentType: "text/plain",
        base64: "a".repeat(350001),
      }),
    ).rejects.toThrow("too large");
  });
});

describe("wiki presentation and durable provenance", () => {
  test("selects another active workspace when the first membership is suspended", async () => {
    const f = await setup();
    const second = await f.alex.mutation(api.workspaces.create, {
      name: "Second fictional workspace",
    });
    await f.t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", f.a.workspaceId).eq("userId", f.a.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "suspended" });
    });
    expect(
      (await f.alex.mutation(api.workspaces.bootstrap, {})).workspaceId,
    ).toBe(second);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(second, { status: "suspended" });
    });
    await expect(f.alex.mutation(api.workspaces.bootstrap, {})).rejects.toThrow(
      "No active",
    );
  });

  test("edits personal wiki prose without turning it into agent facts", async () => {
    const f = await setup();
    const entityId = await manual(f);
    const pageId = await f.alex.mutation(api.knowledge.createPage, {
      workspaceId: f.a.workspaceId,
      title: "Atlas overview",
      entityIds: [entityId],
    });
    const original = await f.alex.query(api.knowledge.pages, {
      workspaceId: f.a.workspaceId,
    });
    expect(original[0].body).toContain("Fictional Atlas");
    await f.alex.mutation(api.knowledge.savePage, {
      pageId,
      expectedRevision: 1,
      body: "Unverified presentation draft: Atlas will launch tomorrow.",
    });
    const context = await f.t.query(internal.knowledge.contextForRun, {
      workspaceId: f.a.workspaceId,
      ownerId: f.a.userId,
    });
    expect(JSON.stringify(context)).not.toContain("launch tomorrow");
    await expect(
      f.alex.mutation(api.knowledge.savePage, {
        pageId,
        expectedRevision: 1,
        body: "Stale edit",
      }),
    ).rejects.toThrow("changed");
    await expect(
      f.blair.mutation(api.knowledge.savePage, {
        pageId,
        expectedRevision: 2,
        body: "Foreign edit",
      }),
    ).rejects.toThrow();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.a.workspaceId, { preservationHold: true });
    });
    await expect(
      f.alex.mutation(api.knowledge.savePage, {
        pageId,
        expectedRevision: 2,
        body: "Held edit",
      }),
    ).rejects.toThrow("hold");
  });

  test("withdraws edited source-backed pages when the original grant is revoked", async () => {
    const f = await setup();
    const { entityId, grantId } = await connected(f);
    const pageId = await f.alex.mutation(api.knowledge.createPage, {
      workspaceId: f.a.workspaceId,
      title: "Atlas sourced overview",
      entityIds: [entityId],
    });
    await f.alex.mutation(api.knowledge.savePage, {
      pageId,
      expectedRevision: 1,
      body: "Owner revised this source-derived presentation.",
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(grantId, { status: "revoked" });
    });
    expect(
      await f.alex.query(api.knowledge.pages, { workspaceId: f.a.workspaceId }),
    ).toEqual([]);
    await expect(
      f.alex.mutation(api.knowledge.savePage, {
        pageId,
        expectedRevision: 2,
        body: "Cannot detach provenance",
      }),
    ).rejects.toThrow("unavailable");
  });

  test("invalidates page and identity review when a supporting fact is corrected", async () => {
    const f = await setup();
    const leftId = await f.alex.mutation(api.knowledge.createEntity, {
      workspaceId: f.a.workspaceId,
      kind: "person",
      title: "Taylor Fiction",
      summary: "Fictional colleague",
      aliases: [],
      sourceRefs: [],
    });
    const rightId = await f.alex.mutation(api.knowledge.createEntity, {
      workspaceId: f.a.workspaceId,
      kind: "person",
      title: "T. Fiction",
      summary: "Possibly the same fictional colleague",
      aliases: [],
      sourceRefs: [],
    });
    await f.alex.mutation(api.knowledge.createPage, {
      workspaceId: f.a.workspaceId,
      title: "Contacts",
      entityIds: [leftId],
    });
    const reviewId = await f.alex.mutation(api.knowledge.proposeIdentity, {
      leftId,
      rightId,
      reason: "Needs owner review",
    });
    await f.alex.mutation(api.knowledge.correctEntity, {
      entityId: leftId,
      expectedRevision: 1,
      title: "Taylor Fiction",
      summary: "A different fictional colleague",
      reason: "Correction",
    });
    expect(
      await f.alex.query(api.knowledge.pages, { workspaceId: f.a.workspaceId }),
    ).toEqual([]);
    await expect(
      f.alex.mutation(api.knowledge.decideIdentity, {
        reviewId,
        expectedRevision: 1,
        decision: "same",
      }),
    ).rejects.toThrow("changed");
  });

  test("does not extend retention for duplicate imports; changed content invalidates old facts", async () => {
    const f = await setup();
    const { sourceId, verifiedUntil } = await connected(f);
    const original = await f.t.run(
      async (ctx) => (await ctx.db.get(sourceId))!,
    );
    const args = {
      workspaceId: f.a.workspaceId,
      ownerId: f.a.userId,
      provider: "fixture",
      externalAccountId: "fictional-account",
      sourceKey: "fictional-message",
      sourceVersion: "v1",
      title: original.title,
      text: original.text,
      grantRevision: 1,
      verifiedUntil,
      expiresAt: original.expiresAt + 86400000,
    };
    expect(await f.t.mutation(internal.knowledge.importSource, args)).toBe(
      sourceId,
    );
    expect(
      (await f.t.run(async (ctx) => (await ctx.db.get(sourceId))!)).expiresAt,
    ).toBe(original.expiresAt);
    await f.t.mutation(internal.knowledge.importSource, {
      ...args,
      sourceVersion: "v2",
      text: "Atlas now uses Monday updates.",
    });
    expect(
      (await f.alex.query(api.knowledge.wiki, { workspaceId: f.a.workspaceId }))
        .entities,
    ).toEqual([]);
  });

  test("durable output eligibility follows exact fact revision and current source grant", async () => {
    const f = await setup();
    const { entityId, grantId } = await connected(f);
    const args = {
      workspaceId: f.a.workspaceId,
      ownerId: f.a.userId,
      refs: [{ entityId, revision: 2 }],
    };
    expect(await f.t.query(internal.knowledge.validateContext, args)).toBe(
      true,
    );
    expect(
      await f.t.query(internal.knowledge.validateContext, {
        ...args,
        refs: [{ entityId, revision: 1 }],
      }),
    ).toBe(false);
    expect(
      await f.t.query(internal.knowledge.validateContext, {
        workspaceId: f.b.workspaceId,
        ownerId: f.b.userId,
        refs: args.refs,
      }),
    ).toBe(false);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(grantId, { verifiedUntil: Date.now() - 1 });
    });
    expect(await f.t.query(internal.knowledge.validateContext, args)).toBe(
      false,
    );
  });
});

describe("source grant lease scheduling", () => {
  test("expiry jobs preserve content and cannot invalidate a renewed lease", async () => {
    vi.useFakeTimers();
    try {
      const f = await setup();
      const { grantId, sourceId, verifiedUntil } = await connected(f);
      const renewedUntil = verifiedUntil + 60000;
      await f.t.mutation(internal.knowledge.syncGrant, {
        workspaceId: f.a.workspaceId,
        ownerId: f.a.userId,
        provider: "fixture",
        externalAccountId: "fictional-account",
        revision: 1,
        status: "active",
        verifiedUntil: renewedUntil,
      });
      await vi.advanceTimersByTimeAsync(60001);
      await f.t.finishInProgressScheduledFunctions();
      expect(
        (await f.t.run(async (ctx) => (await ctx.db.get(grantId))!))
          .verifiedUntil,
      ).toBe(renewedUntil);
      expect(
        (
          await f.alex.query(api.knowledge.wiki, {
            workspaceId: f.a.workspaceId,
          })
        ).entities,
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60000);
      await f.t.finishInProgressScheduledFunctions();
      expect(
        (await f.t.run(async (ctx) => (await ctx.db.get(grantId))!))
          .verifiedUntil,
      ).toBe(0);
      expect(
        (
          await f.alex.query(api.knowledge.wiki, {
            workspaceId: f.a.workspaceId,
          })
        ).entities,
      ).toEqual([]);
      expect(
        (await f.t.run(async (ctx) => (await ctx.db.get(sourceId))!)).text,
      ).toContain("Friday");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retention deadline invalidation", () => {
  test("scheduled invalidation hides sources, corrected facts, edited pages and files while preserving held bytes", async () => {
    const f = await setup();
    const sourceId = await f.alex.mutation(api.knowledge.createSource, {
      workspaceId: f.a.workspaceId,
      title: "Fictional source",
      text: "Atlas updates are due Friday.",
    });
    const entityId = await manual(f);
    const pageId = await f.alex.mutation(api.knowledge.createPage, {
      workspaceId: f.a.workspaceId,
      title: "Independent editable page",
      entityIds: [],
      body: "Original fictional prose.",
    });
    const fileId = await f.alex.action(api.files.upload, {
      workspaceId: f.a.workspaceId,
      name: "fictional.txt",
      contentType: "text/plain",
      base64: btoa("Retained fictional bytes"),
    });
    await f.alex.mutation(api.knowledge.correctEntity, {
      entityId,
      expectedRevision: 1,
      title: "Atlas",
      summary: "Corrected fictional fact",
      reason: "Owner correction",
    });
    await f.alex.mutation(api.knowledge.savePage, {
      pageId,
      expectedRevision: 1,
      body: "Updated fictional prose.",
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.a.workspaceId, { preservationHold: true });
    });
    await vi.advanceTimersByTimeAsync(86400001);
    await f.t.finishInProgressScheduledFunctions();
    // Test the actual scheduled metadata writes, not only Date.now filtering.
    const records = await f.t.run(async (ctx) => ({
      source: (await ctx.db.get(sourceId))!,
      entity: (await ctx.db.get(entityId))!,
      page: (await ctx.db.get(pageId))!,
      file: (await ctx.db.get(fileId))!,
    }));
    expect(
      [records.source, records.entity, records.page, records.file].map(
        (row) => row.expiresAt,
      ),
    ).toEqual([0, 0, 0, 0]);
    expect(records.source.text).toContain("Friday");
    expect(records.entity.summary).toBe("Corrected fictional fact");
    expect(records.page.body).toBe("Updated fictional prose.");
    expect(records.file.storageId).toBeTruthy();
    expect(
      await f.alex.query(api.knowledge.listSources, {
        workspaceId: f.a.workspaceId,
      }),
    ).toEqual([]);
    expect(
      await f.alex.query(api.knowledge.list, { workspaceId: f.a.workspaceId }),
    ).toEqual([]);
    expect(
      await f.alex.query(api.knowledge.pages, { workspaceId: f.a.workspaceId }),
    ).toEqual([]);
    expect(
      await f.alex.query(api.files.list, { workspaceId: f.a.workspaceId }),
    ).toEqual([]);
    await expect(
      f.alex.action(api.files.download, { fileId }),
    ).rejects.toThrow();
  });

  test("a mismatched deadline job cannot expire a different record version", async () => {
    const f = await setup();
    const entityId = await manual(f);
    const original = await f.t.run(
      async (ctx) => (await ctx.db.get(entityId))!,
    );
    await f.t.mutation(internal.knowledge.expireRecord, {
      recordId: entityId,
      expectedExpiresAt: original.expiresAt - 1,
    });
    expect(
      (await f.t.run(async (ctx) => (await ctx.db.get(entityId))!)).expiresAt,
    ).toBe(original.expiresAt);
  });
});
