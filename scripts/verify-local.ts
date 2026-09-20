import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
// This tool is intentionally restricted to the project's anonymous LOCAL backend.
// It uses the local administrator credential to test verified-identity authorization
// without weakening the production auth configuration or shipping a bypass.
async function main() {
  const config = JSON.parse(
    await readFile(".convex/local/default/config.json", "utf8"),
  );
  assert.match(config.deploymentName, /^anonymous-/);
  assert.ok(Number.isInteger(config.ports.cloud));
  const url = `http://127.0.0.1:${config.ports.cloud}`;
  const client = new ConvexHttpClient(url);
  (
    client as ConvexHttpClient & {
      setAdminAuth: (key: string, identity: Record<string, string>) => void;
    }
  ).setAdminAuth(config.adminKey, {
    subject: "harbor-verification-user",
    issuer: "https://identity.example.invalid",
    name: "Verification User",
    tokenIdentifier:
      "https://identity.example.invalid|harbor-verification-user",
  });
  const [mode, expectedFile] = process.argv.slice(2);
  if (mode === "verify") {
    const expected = JSON.parse(await readFile(expectedFile, "utf8"));
    const scope = await client.query(api.workspaces.current, {
      workspaceId: expected.workspaceId,
    });
    assert.equal(scope.user.displayName, "Verification User");
    assert.equal(
      (
        await client.query(api.agents.get, {
          workspaceId: expected.workspaceId,
        })
      ).name,
      "Cove",
    );
    const pages = await client.query(api.knowledge.pages, {
      workspaceId: expected.workspaceId,
    });
    assert.ok(
      pages.some(
        (p) =>
          p._id === expected.pageId &&
          p.body === "Verified fictional restore content.",
      ),
    );
    const task = await client.query(api.execution.get, {
      taskId: expected.taskId,
    });
    assert.equal(task.state, "failed");
    assert.equal(task.modelDispatch, "not_started");
    const files = await client.query(api.files.list, {
      workspaceId: expected.workspaceId,
    });
    assert.ok(files.some((f) => f._id === expected.fileId));
    const file = await client.action(api.files.download, {
      fileId: expected.fileId,
    });
    assert.equal(
      file.base64,
      Buffer.from("Fictional restoration fixture.").toString("base64"),
    );
    console.log(
      JSON.stringify({
        restored: true,
        workspace: true,
        agent: true,
        wiki: true,
        task: true,
        fileBytes: true,
      }),
    );
    return;
  }
  const anon = new ConvexHttpClient(url);
  await assert.rejects(() => anon.query(api.workspaces.list, {}));
  const { workspaceId } = await client.mutation(api.workspaces.bootstrap, {});
  const catalog = await client.query(api.ai.catalog, { workspaceId });
  assert.notEqual(
    catalog.state,
    "configured",
    "Use an isolated backend without model credentials for this fixture.",
  );
  await client.mutation(api.agents.save, {
    workspaceId,
    name: "Cove",
    tone: "concise",
    detail: "brief",
    instructions: "Fictional verification preference.",
  });
  const pageId = await client.mutation(api.knowledge.createPage, {
    workspaceId,
    title: "Verification page",
    entityIds: [],
    body: "Verified fictional restore content.",
  });
  const fileId = await client.action(api.files.upload, {
    workspaceId,
    name: "verification.txt",
    contentType: "text/plain",
    base64: Buffer.from("Fictional restoration fixture.").toString("base64"),
  });
  const taskId = await client.mutation(api.execution.start, {
    workspaceId,
    prompt:
      "This fictional request must fail because no provider key is configured.",
    model: catalog.models[0].id,
  });
  let state: string = "";
  for (let i = 0; i < 40; i++) {
    const task = await client.query(api.execution.get, { taskId });
    state = task.state;
    if (state === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(state, "failed");
  const policy = await client.query(api.execution.policy, { workspaceId });
  assert.equal(policy.usage.workspace.reservedMicros, 0);
  assert.equal(policy.usage.workspace.spentMicros, 0);
  const other = new ConvexHttpClient(url);
  (
    other as ConvexHttpClient & {
      setAdminAuth: (key: string, identity: Record<string, string>) => void;
    }
  ).setAdminAuth(config.adminKey, {
    subject: "harbor-other",
    issuer: "https://identity.example.invalid",
    name: "Other Verification",
    tokenIdentifier: "https://identity.example.invalid|harbor-other",
  });
  await other.mutation(api.workspaces.bootstrap, {});
  await assert.rejects(() => other.query(api.execution.get, { taskId }));
  await assert.rejects(() => other.action(api.files.download, { fileId }));
  await writeFile(
    ".convex/verification.json",
    JSON.stringify({ workspaceId, pageId, fileId, taskId }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      liveLocalBackend: true,
      anonymousDenied: true,
      crossOwnerDenied: true,
      workflowFailedSafely: true,
      reservationReleased: true,
      persistentWiki: true,
      persistentFile: true,
    }),
  );
}
main().catch(() => {
  console.error(
    "Local verification failed; inspect the isolated deployment. No credentials have been printed.",
  );
  process.exitCode = 1;
});
