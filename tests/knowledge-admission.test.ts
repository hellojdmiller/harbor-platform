/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { DEFAULT_MODEL_ID } from "../lib/ai/routing";

const modules = import.meta.glob("../convex/**/*.ts");
const issuer = "https://admission.example.test";
beforeEach(() => {
  vi.stubEnv("OIDC_ISSUER", issuer);
  vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", '["operator"]');
  vi.stubEnv("HARBOR_ALLOW_SELF_SERVICE_WORKSPACES", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
function setup() {
  const t = convexTest(schema, modules);
  const identity = (subject: string, from = issuer) =>
    t.withIdentity({
      issuer: from,
      subject,
      tokenIdentifier: `${from}|${subject}`,
      name: `${subject} Fiction`,
    });
  return { t, identity };
}

async function provisioned(role: "admin" | "member" = "member") {
  const f = setup();
  const operator = f.identity("operator");
  const workspace = await operator.mutation(api.workspaces.bootstrap, {});
  const admissionId = await operator.mutation(api.provisioning.assign, {
    workspaceId: workspace.workspaceId,
    issuer,
    subject: "employee",
    role,
  });
  const employee = f.identity("employee");
  return { ...f, operator, employee, workspace, admissionId };
}

describe("production workspace admission", () => {
  test("denies anonymous and nonadmitted accounts before they can reserve provider quota", async () => {
    const f = setup();
    vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", "[]");
    await expect(f.t.mutation(api.workspaces.bootstrap, {})).rejects.toThrow(
      "Sign in",
    );
    await expect(
      f.identity("random").mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("provision");
    expect(await f.t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.query("workspaces").collect()),
    ).toEqual([]);
    vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", '["operator"]');
    const workspace = await f
      .identity("operator")
      .mutation(api.workspaces.bootstrap, {});
    await expect(
      f.identity("random").mutation(api.execution.start, {
        workspaceId: workspace.workspaceId,
        prompt: "Spend shared provider quota",
        model: DEFAULT_MODEL_ID,
      }),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("executionReservations").collect()),
    ).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("taskRuns").collect())).toEqual(
      [],
    );
  });

  test("requires an explicit bootstrap subject and rejects malformed allowlists", async () => {
    const f = setup();
    const operator = f.identity("operator");
    vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", "not-json");
    await expect(
      operator.mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("provision");
    vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", '["operator"]');
    const workspace = await operator.mutation(api.workspaces.bootstrap, {});
    const current = await operator.query(api.workspaces.current, {
      workspaceId: workspace.workspaceId,
    });
    expect(current.membership.role).toBe("owner");
    expect(
      await f.t.run((ctx) => ctx.db.query("agents").collect()),
    ).toHaveLength(1);
    vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", "[]");
    expect(await operator.mutation(api.workspaces.bootstrap, {})).toEqual(
      workspace,
    );
    await expect(
      operator.mutation(api.workspaces.create, { name: "Another workspace" }),
    ).rejects.toThrow("operator");
  });

  test("matches issuer plus subject, not subject alone", async () => {
    const f = await provisioned();
    await expect(
      f
        .identity("operator", "https://foreign.example.test")
        .mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("provision");
    await expect(
      f
        .identity("employee", "https://foreign.example.test")
        .mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("provision");
    expect((await f.t.run((ctx) => ctx.db.get(f.admissionId)))?.status).toBe(
      "pending",
    );
    const member = await f.employee.mutation(api.workspaces.bootstrap, {});
    expect(member.workspaceId).toBe(f.workspace.workspaceId);
  });

  test("consumes an admission atomically and idempotently with a personal agent", async () => {
    const f = await provisioned();
    const again = await f.operator.mutation(api.provisioning.assign, {
      workspaceId: f.workspace.workspaceId,
      issuer,
      subject: "employee",
      role: "member",
    });
    expect(again).toBe(f.admissionId);
    const member = await f.employee.mutation(api.workspaces.bootstrap, {});
    expect(await f.employee.mutation(api.workspaces.bootstrap, {})).toEqual(
      member,
    );
    const state = await f.t.run(async (ctx) => ({
      admission: await ctx.db.get(f.admissionId),
      memberships: await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", member.workspaceId).eq("userId", member.userId),
        )
        .collect(),
      agents: await ctx.db
        .query("agents")
        .withIndex("by_owner", (q) =>
          q.eq("workspaceId", member.workspaceId).eq("ownerId", member.userId),
        )
        .collect(),
    }));
    expect(state.admission?.status).toBe("consumed");
    expect(state.memberships).toHaveLength(1);
    expect(state.memberships[0].role).toBe("member");
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].name).toBe("Piper");
    const audit = await f.operator.query(api.admin.overview, {
      workspaceId: member.workspaceId,
    });
    expect(
      audit.audit.filter((row) => row.action === "admission.consumed"),
    ).toHaveLength(1);
    await expect(
      f.employee.mutation(api.workspaces.create, { name: "Quota escape" }),
    ).rejects.toThrow("operator");
  });

  test("only workspace owners provision and admissions cannot change existing roles", async () => {
    const f = await provisioned("admin");
    const member = await f.employee.mutation(api.workspaces.bootstrap, {});
    await expect(
      f.employee.mutation(api.provisioning.assign, {
        workspaceId: member.workspaceId,
        issuer,
        subject: "new-member",
        role: "member",
      }),
    ).rejects.toThrow("owner");
    await expect(
      f.operator.mutation(api.provisioning.assign, {
        workspaceId: member.workspaceId,
        issuer,
        subject: "employee",
        role: "member",
      }),
    ).rejects.toThrow("roles");
    await expect(
      f.operator.mutation(api.provisioning.revoke, {
        admissionId: f.admissionId,
        expectedRevision: 2,
      }),
    ).rejects.toThrow("unused");
  });

  test("revokes unused admissions and cannot reactivate suspended membership", async () => {
    const f = await provisioned();
    await f.operator.mutation(api.provisioning.revoke, {
      admissionId: f.admissionId,
      expectedRevision: 1,
    });
    await expect(
      f.employee.mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("provision");
    await f.operator.mutation(api.provisioning.assign, {
      workspaceId: f.workspace.workspaceId,
      issuer,
      subject: "employee",
      role: "member",
    });
    const employee = await f.employee.mutation(api.workspaces.bootstrap, {});
    const membership = await f.t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q
            .eq("workspaceId", employee.workspaceId)
            .eq("userId", employee.userId),
        )
        .unique(),
    );
    await f.operator.mutation(api.admin.setMembership, {
      workspaceId: employee.workspaceId,
      membershipId: membership!._id,
      role: "member",
      status: "suspended",
    });
    expect(
      await f.operator.mutation(api.provisioning.assign, {
        workspaceId: employee.workspaceId,
        issuer,
        subject: "employee",
        role: "member",
      }),
    ).toBe(f.admissionId);
    await expect(
      f.employee.mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("No active");
  });

  test("self service requires the exact explicit development flag and cannot mint additional workspaces", async () => {
    const f = setup();
    vi.stubEnv("HARBOR_BOOTSTRAP_SUBJECTS", "[]");
    vi.stubEnv("HARBOR_ALLOW_SELF_SERVICE_WORKSPACES", "1");
    await expect(
      f.identity("developer").mutation(api.workspaces.bootstrap, {}),
    ).rejects.toThrow("provision");
    vi.stubEnv("HARBOR_ALLOW_SELF_SERVICE_WORKSPACES", "true");
    const dev = f.identity("developer");
    await dev.mutation(api.workspaces.bootstrap, {});
    await expect(
      dev.mutation(api.workspaces.create, { name: "Additional spending pool" }),
    ).rejects.toThrow("operator");
  });
});
