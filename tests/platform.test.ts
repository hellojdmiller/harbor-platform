import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { redactSpan } from "../lib/telemetry";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("HARBOR_ALLOW_SELF_SERVICE_WORKSPACES", "true");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const modules = import.meta.glob("../convex/**/*.ts");
it("isolates personal preferences and administration across workspaces", async () => {
  const t = convexTest(schema, modules);
  const a = t.withIdentity({
    name: "Sample One",
    subject: "one",
    issuer: "https://identity.example.invalid",
  });
  const b = t.withIdentity({
    name: "Sample Two",
    subject: "two",
    issuer: "https://identity.example.invalid",
  });
  const wa = await a.mutation(api.workspaces.bootstrap, {});
  await b.mutation(api.workspaces.bootstrap, {});
  await a.mutation(api.agents.save, {
    workspaceId: wa.workspaceId,
    name: "Cove",
    tone: "concise",
    detail: "brief",
    instructions: "Use bullets when useful.",
  });
  expect(
    (await a.query(api.agents.get, { workspaceId: wa.workspaceId })).name,
  ).toBe("Cove");
  await expect(
    b.query(api.agents.get, { workspaceId: wa.workspaceId }),
  ).rejects.toThrow();
  await expect(
    b.query(api.admin.overview, { workspaceId: wa.workspaceId }),
  ).rejects.toThrow();
  await expect(
    t.query(api.agents.get, { workspaceId: wa.workspaceId }),
  ).rejects.toThrow();
  const overview = await a.query(api.admin.overview, {
    workspaceId: wa.workspaceId,
  });
  expect(overview.members).toHaveLength(1);
  expect(overview.audit[0].action).toBe("agent.updated");
});
it("does not grant administrators access to another person's private conversations", async () => {
  const t = convexTest(schema, modules);
  const a = t.withIdentity({
      subject: "one",
      issuer: "https://identity.example.invalid",
    }),
    b = t.withIdentity({
      subject: "two",
      issuer: "https://identity.example.invalid",
    });
  const wa = await a.mutation(api.workspaces.bootstrap, {}),
    wb = await b.mutation(api.workspaces.bootstrap, {});
  const id = await t.run(async (ctx) => {
    await ctx.db.insert("memberships", {
      workspaceId: wa.workspaceId,
      userId: wb.userId,
      role: "admin",
      status: "active",
      createdAt: Date.now(),
    });
    return ctx.db.insert("conversations", {
      workspaceId: wa.workspaceId,
      ownerId: wa.userId,
      title: "Private sample",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  expect(
    await b.query(api.conversations.list, { workspaceId: wa.workspaceId }),
  ).toEqual([]);
  await expect(
    b.query(api.conversations.messages, { conversationId: id }),
  ).rejects.toThrow();
});
it("redacts telemetry content, URLs, identities, error text and inherited resource metadata", () => {
  const input = {
    name: "GET /private/person@example.invalid",
    attributes: {
      "http.method": "GET",
      "http.status_code": 200,
      "url.full": "https://example.invalid?token=secret",
      "user.id": "private",
      prompt: "private",
      "harbor.operation": "model.request",
    },
    events: [{ name: "exception", attributes: { message: "secret" } }],
    links: [{}],
    status: { code: 2, message: "private error" },
    resource: {
      attributes: { "service.name": "wrong", "user.email": "secret" },
    },
    instrumentationScope: { name: "vendor" },
  } as unknown as ReadableSpan;
  const result = redactSpan(input);
  expect(result.name).toBe("harbor.request");
  expect(result.attributes).toEqual({
    "http.method": "GET",
    "http.status_code": 200,
    "harbor.operation": "model.request",
  });
  expect(result.events).toEqual([]);
  expect(result.links).toEqual([]);
  expect(result.status).toEqual({ code: 2 });
  expect(result.resource.attributes).toEqual({ "service.name": "harbor-web" });
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("saves personal context transactionally and keeps prose-only pages out of model facts", async () => {
  const t = convexTest(schema, modules);
  const a = t.withIdentity({
    subject: "context",
    issuer: "https://identity.example.invalid",
  });
  const scope = await a.mutation(api.workspaces.bootstrap, {});
  await a.mutation(api.personalContext.add, {
    workspaceId: scope.workspaceId,
    title: "Private preference",
    body: "Lead with decisions.",
    useForAgent: true,
  });
  await a.mutation(api.personalContext.add, {
    workspaceId: scope.workspaceId,
    title: "Draft page",
    body: "Unreviewed prose.",
    useForAgent: false,
  });
  const facts = await t.query(internal.knowledge.contextForRun, {
    workspaceId: scope.workspaceId,
    ownerId: scope.userId,
  });
  expect(facts).toHaveLength(1);
  expect(facts[0].summary).toBe("Lead with decisions.");
  expect(
    await a.query(api.knowledge.pages, { workspaceId: scope.workspaceId }),
  ).toHaveLength(2);
});
it("withholds held expired conversation titles and messages without erasing the hold", async () => {
  const t = convexTest(schema, modules);
  const a = t.withIdentity({
    subject: "hold",
    issuer: "https://identity.example.invalid",
  });
  const scope = await a.mutation(api.workspaces.bootstrap, {});
  const id = await t.run(async (ctx) => {
    await ctx.db.patch(scope.workspaceId, {
      preservationHold: true,
      retentionDays: 1,
    });
    const conversationId = await ctx.db.insert("conversations", {
      workspaceId: scope.workspaceId,
      ownerId: scope.userId,
      title: "Expired private title",
      createdAt: Date.now() - 172800000,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("messages", {
      workspaceId: scope.workspaceId,
      ownerId: scope.userId,
      conversationId,
      role: "assistant",
      content: "Held private message",
      createdAt: Date.now() - 172800000,
    });
    return conversationId;
  });
  expect(
    await a.query(api.conversations.list, { workspaceId: scope.workspaceId }),
  ).toEqual([]);
  expect(
    await a.query(api.conversations.messages, { conversationId: id }),
  ).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(
    1,
  );
});
