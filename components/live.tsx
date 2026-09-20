"use client";
import { useEffect, useState } from "react";
import {
  ClerkProvider,
  SignInButton,
  UserButton,
  useAuth,
} from "@clerk/nextjs";
import {
  Authenticated,
  AuthLoading,
  ConvexReactClient,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { KnowledgeControls } from "./knowledge-controls";
import {
  AdminControls,
  RoutineControls,
  PeopleControls,
} from "./admin-controls";
import { Workspace } from "./workspace";
import type { WorkspaceView } from "@/lib/ui-types";
const client = process.env.NEXT_PUBLIC_CONVEX_URL
  ? new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL)
  : null;
export function LiveApp() {
  if (!client) return null;
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        <AuthLoading>
          <p className="loading">Connecting your workspace…</p>
        </AuthLoading>
        <Unauthenticated>
          <main className="setup">
            <div className="brand">Harbor</div>
            <div className="setup-intro">
              <h1>
                Your work.
                <br />
                Your personal assistant.
              </h1>
              <p>Sign in to your organization’s workspace to continue.</p>
              <SignInButton mode="modal">
                <button className="primary">Sign in</button>
              </SignInButton>
            </div>
            <a href="/demo">Explore the fictional demo</a>
          </main>
        </Unauthenticated>
        <Authenticated>
          <Session />
        </Authenticated>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
function Session() {
  const bootstrap = useMutation(api.workspaces.bootstrap);
  const [workspaceId, setWorkspaceId] = useState<Id<"workspaces">>(),
    [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    void bootstrap({})
      .then((r) => {
        if (current) setWorkspaceId(r.workspaceId);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [bootstrap]);
  const workspaces = useQuery(api.workspaces.list, workspaceId ? {} : "skip");
  if (error)
    return (
      <main className="setup">
        <h1>Workspace access is unavailable.</h1>
        <p>
          Ask your administrator to check your membership and identity
          configuration.
        </p>
        <UserButton />
      </main>
    );
  if (!workspaceId) return <p className="loading">Opening your workspace…</p>;
  return (
    <ConnectedWorkspace
      key={workspaceId}
      workspaceId={workspaceId}
      switcher={
        <select
          aria-label="Workspace"
          className="workspace-switch"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value as Id<"workspaces">)}
        >
          {workspaces?.map((w) => (
            <option key={w._id} value={w._id}>
              {w.name}
            </option>
          ))}
        </select>
      }
    />
  );
}
function ConnectedWorkspace({
  workspaceId,
  switcher,
}: {
  workspaceId: Id<"workspaces">;
  switcher: React.ReactNode;
}) {
  const current = useQuery(api.workspaces.current, { workspaceId });
  const tasks = useQuery(api.execution.list, { workspaceId });
  const policy = useQuery(api.execution.policy, { workspaceId });
  const agent = useQuery(api.agents.get, { workspaceId });
  const connections = useQuery(api.integrations.status, { workspaceId });
  const pages = useQuery(api.knowledge.pages, { workspaceId });
  // These subscriptions preserve server state across tabs and reconnection.
  const conversations = useQuery(api.conversations.list, { workspaceId });
  const routines = useQuery(api.execution.listRoutines, { workspaceId });
  const [openTask, setOpenTask] = useState<Id<"taskRuns">>();
  const detail = useQuery(
    api.execution.get,
    openTask ? { taskId: openTask } : "skip",
  );
  const admin = useQuery(
    api.admin.overview,
    current && current.membership.role !== "member" ? { workspaceId } : "skip",
  );
  const start = useMutation(api.execution.start),
    saveAgent = useMutation(api.agents.save),
    savePage = useMutation(api.knowledge.savePage),
    cancel = useMutation(api.execution.cancel),
    approve = useMutation(api.execution.approve);
  if (
    !current ||
    !tasks ||
    !policy ||
    !agent ||
    !connections ||
    !pages ||
    !conversations ||
    !routines
  )
    return <p className="loading">Loading your saved workspace…</p>;
  const data: WorkspaceView = {
    id: workspaceId,
    name: current.workspace.name,
    userName: current.user.displayName,
    role: current.membership.role,
    agent: {
      name: agent.name,
      tone: agent.tone,
      detail: agent.detail,
      instructions: agent.instructions,
    },
    tasks: tasks.map((t) => ({
      id: t._id,
      title: t.title,
      status: t.state,
      createdAt: t.createdAt,
      ...(detail?._id === t._id
        ? {
            response: detail.intent?.text ?? detail.result,
            error: detail.detail,
            delivery: detail.intent
              ? { to: detail.intent.to, subject: detail.intent.subject }
              : detail.delivery,
            reviewReady:
              detail.contextAvailable &&
              Boolean(detail.intent) &&
              Boolean(detail.result),
          }
        : {}),
    })),
    wiki: pages.map((p) => ({
      id: p._id,
      title: p.title,
      body: p.body,
      updatedAt: p.updatedAt,
      revision: p.revision,
      sources: p.sourceRefs.length,
    })),
    connections: connections.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.actions.join(", "),
      state: c.state,
      detail: c.detail,
    })),
    members: admin?.members ?? [],
    audit: (admin?.audit ?? []).map((e) => ({
      id: e._id,
      action: e.action,
      createdAt: e.createdAt,
    })),
    spentUsd: policy.usage.workspace.spentMicros / 1e6,
    reservedUsd: policy.usage.workspace.reservedMicros / 1e6,
    limitUsd: policy.monthlyWorkspaceMicros / 1e6,
  };
  return (
    <Workspace
      data={data}
      workspaceSwitcher={switcher}
      allowEmail={policy.allowEmail}
      models={policy.allowedModels}
      knowledgeControls={<KnowledgeControls workspaceId={workspaceId} />}
      adminControls={
        current.membership.role !== "member" ? (
          <>
            <AdminControls workspaceId={workspaceId} />
            <PeopleControls
              workspaceId={workspaceId}
              issuer={current.user.issuer}
              owner={current.membership.role === "owner"}
            />
          </>
        ) : undefined
      }
      routineControls={<RoutineControls workspaceId={workspaceId} />}
      account={<UserButton />}
      onTaskOpen={(id) => setOpenTask(id as Id<"taskRuns">)}
      onSubmit={async (prompt, model, delivery) => {
        await start({
          workspaceId,
          prompt,
          model: model ?? policy.defaultModel,
          ...(delivery ? { delivery } : {}),
        });
      }}
      onSaveAgent={async (value) => {
        await saveAgent({ workspaceId, ...value });
      }}
      onSaveWiki={async (id, body, expectedRevision) => {
        const p = pages.find((p) => p._id === id);
        if (!p) throw new Error("Refresh this page before saving.");
        await savePage({
          pageId: p._id,
          expectedRevision: expectedRevision ?? p.revision,
          body,
        });
      }}
      onCancel={async (id) => {
        await cancel({ taskId: id as Id<"taskRuns"> });
      }}
      onApprove={async (id, value) => {
        await approve({ taskId: id as Id<"taskRuns">, approve: value });
      }}
    />
  );
}
