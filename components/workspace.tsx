"use client";
import { useState } from "react";
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Compass,
  Home,
  Layers3,
  Link2,
  ListTodo,
  LockKeyhole,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { AgentView, View, WorkspaceView, TaskView } from "@/lib/ui-types";
const navigation = [
  { id: "home", label: "Home", icon: Home },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "wiki", label: "My wiki", icon: BookOpen },
  { id: "connections", label: "Connections", icon: Link2 },
  { id: "agent", label: "My assistant", icon: Sparkles },
] as const;
const statuses: Record<string, string> = {
  completed: "Completed",
  succeeded: "Completed",
  awaiting_approval: "Needs approval",
  queued: "Queued",
  running: "Working",
  failed: "Failed",
  canceled: "Canceled",
  timed_out: "Timed out",
  needs_reconciliation: "Needs reconciliation",
  planned: "Planned",
  not_configured: "Not configured",
  configured: "Configured",
  connected: "Connected",
  functioning: "Functioning",
  live_verified: "Live verified",
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
const date = (n: number) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(n);
type Props = {
  data: WorkspaceView;
  demo?: boolean;
  workspaceSwitcher?: React.ReactNode;
  allowEmail?: boolean;
  account?: React.ReactNode;
  adminControls?: React.ReactNode;
  knowledgeControls?: React.ReactNode;
  routineControls?: React.ReactNode;
  models?: string[];
  onSubmit: (
    prompt: string,
    model?: string,
    delivery?: { to: string; subject: string },
  ) => Promise<void>;
  onSaveAgent: (agent: AgentView) => Promise<void>;
  onSaveWiki: (
    id: string,
    body: string,
    expectedRevision?: number,
  ) => Promise<void>;
  onTaskOpen?: (id: string) => void;
  onCancel: (id: string) => Promise<void>;
  onApprove: (id: string, approve: boolean) => Promise<void>;
};
export function Workspace({
  data,
  demo = false,
  workspaceSwitcher,
  allowEmail = false,
  account,
  adminControls,
  knowledgeControls,
  routineControls,
  models,
  onSubmit,
  onSaveAgent,
  onSaveWiki,
  onCancel,
  onApprove,
  onTaskOpen,
}: Props) {
  const [emailDraft, setEmailDraft] = useState(false),
    [recipient, setRecipient] = useState(""),
    [subject, setSubject] = useState("");
  const [draftRevision, setDraftRevision] = useState<number>();
  const [model, setModel] = useState(models?.[0]);
  const [view, setView] = useState<View>("home"),
    [menu, setMenu] = useState(false),
    [notice, setNotice] = useState<string>(),
    [busy, setBusy] = useState(false),
    [prompt, setPrompt] = useState(""),
    [selected, setSelected] = useState<TaskView>(),
    [wikiId, setWikiId] = useState(data.wiki[0]?.id),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(""),
    [search, setSearch] = useState(""),
    [agent, setAgent] = useState(data.agent);
  const page = data.wiki.find((p) => p.id === wikiId) ?? data.wiki[0];
  const currentTask = data.tasks.find((t) => t.id === selected?.id) ?? selected;
  const run = async (fn: () => Promise<void>, success?: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await fn();
      if (success) setNotice(success);
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "The action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const navigate = (id: View) => {
    setView(id);
    setMenu(false);
    setNotice(undefined);
    setEditing(false);
  };
  const submit = () =>
    run(async () => {
      if (!prompt.trim()) return;
      await onSubmit(
        prompt.trim(),
        model,
        emailDraft && allowEmail ? { to: recipient, subject } : undefined,
      );
      setPrompt("");
      setView("tasks");
    });
  const pending = data.tasks.filter(
    (t) => t.status === "awaiting_approval",
  ).length;
  return (
    <div className="application">
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <a className="brand" href={demo ? "/demo" : "/"}>
          <Compass size={29} strokeWidth={1.8} />
          <span>Harbor</span>
        </a>
        {workspaceSwitcher ?? (
          <button className="workspace-switch" onClick={() => navigate("home")}>
            <span className="workspace-mark">{data.name[0]}</span>
            <span>{data.name}</span>
            <ChevronDown size={15} />
          </button>
        )}
        <button
          className="new-task"
          onClick={() => {
            navigate("home");
            document.getElementById("task-prompt")?.focus();
          }}
        >
          <Plus size={17} /> New task <span>↵</span>
        </button>
        <nav aria-label="Workspace navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              aria-current={view === id ? "page" : undefined}
              className={view === id ? "selected" : ""}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "tasks" && pending > 0 && (
                <span className="nav-count">{pending}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {data.role !== "member" && (
            <button
              className={
                view === "admin" ? "admin-link selected" : "admin-link"
              }
              onClick={() => navigate("admin")}
            >
              <ShieldCheck size={19} /> Administration
            </button>
          )}
          <a
            className="help-link"
            href="https://github.com/hellojdmiller/harbor-platform#deployment"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={18} /> Help & deployment
          </a>
          <button className="agent-mini" onClick={() => navigate("agent")}>
            <span className="avatar small">
              <Sparkles size={21} />
            </span>
            <span>
              <strong>{data.agent.name}</strong>
              <small>Your personal assistant</small>
            </span>
          </button>
          <div className="account">
            {account ?? <span className="user-avatar">{data.userName[0]}</span>}
            <span>
              <strong>{data.userName}</strong>
              <small>
                {demo
                  ? "Demo workspace"
                  : data.role === "member"
                    ? "Member"
                    : "Workspace administrator"}
              </small>
            </span>
            <Settings2 size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {view === "wiki"
                ? "My wiki"
                : view === "agent"
                  ? "My assistant"
                  : view === "admin"
                    ? "Administration"
                    : view[0].toUpperCase() + view.slice(1)}
            </strong>
          </div>
          <span className="privacy">
            <LockKeyhole size={13} />
            {demo ? "Fictional demo" : "Your private workspace"}
          </span>
        </header>
        {demo && (
          <div className="demo-bar">
            <span>
              <span className="status-dot" /> Explore Harbor with fictional
              data. Edits stay in this tab; tasks and delivery are disabled.
            </span>
            <a href="/">
              Set up your instance <ChevronRight size={13} />
            </a>
          </div>
        )}
        <main className={`workspace-content view-${view}`}>
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                aria-label="Dismiss message"
                className="icon-button"
                onClick={() => setNotice(undefined)}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {view === "home" && (
            <>
              <div className="greeting">
                <div>
                  <p className="quiet">Your workspace, in one place</p>
                  <h1>Good to see you, {data.userName.split(" ")[0]}.</h1>
                  <p>What would you like to move forward?</p>
                </div>
                <button
                  className="assistant-badge"
                  onClick={() => navigate("agent")}
                >
                  <span className="avatar">
                    <Sparkles size={38} strokeWidth={1.4} />
                  </span>
                  <span>{data.agent.name} is here to help</span>
                </button>
              </div>
              <div className="home-columns">
                <section className="home-main">
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit();
                    }}
                  >
                    <label className="sr-only" htmlFor="task-prompt">
                      Give your assistant a task
                    </label>
                    <textarea
                      id="task-prompt"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={`Give ${data.agent.name} a task…`}
                      maxLength={12000}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void submit();
                        }
                      }}
                    />
                    {allowEmail && (
                      <div className="email-composer">
                        <label className="check-label">
                          <input
                            type="checkbox"
                            checked={emailDraft}
                            onChange={(e) => setEmailDraft(e.target.checked)}
                          />{" "}
                          Prepare an email for my approval
                        </label>
                        {emailDraft && (
                          <>
                            <label>
                              Recipient
                              <input
                                type="email"
                                required
                                value={recipient}
                                onChange={(e) => setRecipient(e.target.value)}
                                maxLength={254}
                              />
                            </label>
                            <label>
                              Subject
                              <input
                                required
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                maxLength={200}
                              />
                            </label>
                            <p className="quiet">
                              Review and approve the exact draft before any
                              delivery.
                            </p>
                          </>
                        )}
                      </div>
                    )}
                    <div className="composer-tools">
                      <span>
                        <ShieldCheck size={16} /> Private to you
                      </span>
                      <div>
                        {models?.length ? (
                          <select
                            className="model-picker"
                            aria-label="Model"
                            value={model ?? models[0]}
                            onChange={(e) => setModel(e.target.value)}
                          >
                            {models.map((m) => (
                              <option key={m} value={m}>
                                {m
                                  .replace("claude-", "Claude ")
                                  .replaceAll("-", " ")}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="composer-mode">
                            Task <ChevronDown size={14} />
                          </span>
                        )}
                        <button
                          className="send"
                          type="submit"
                          disabled={busy || !prompt.trim()}
                          aria-label="Start task"
                        >
                          <ArrowUp size={21} />
                        </button>
                      </div>
                    </div>
                  </form>
                  <div className="suggestion-chips">
                    {[
                      "Prepare for a meeting",
                      "Draft a follow-up",
                      "Help me plan my week",
                    ].map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setPrompt(s);
                          document.getElementById("task-prompt")?.focus();
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="section-heading">
                    <h2>Recent work</h2>
                    <button onClick={() => navigate("tasks")}>
                      View all <ChevronRight size={15} />
                    </button>
                  </div>
                  <TaskList
                    tasks={data.tasks.slice(0, 6)}
                    onSelect={(t) => {
                      setSelected(t);
                      onTaskOpen?.(t.id);
                    }}
                  />
                  {data.tasks.length === 0 && (
                    <div className="empty">
                      <ListTodo />
                      <h3>Your next task starts here</h3>
                      <p>
                        Ask your assistant to prepare a brief, organize a plan,
                        or draft a response.
                      </p>
                    </div>
                  )}
                </section>
                <aside className="suggestions">
                  <div className="section-heading">
                    <h2>A little more headspace</h2>
                    <Sparkles size={17} />
                  </div>
                  <p className="quiet">A few good places to start.</p>
                  {[
                    {
                      title: "Make the next meeting easier",
                      text: "Turn an agenda into a useful preparation brief.",
                      prompt:
                        "Help me prepare for my next meeting. Ask me for the agenda and context you need.",
                    },
                    {
                      title: "Close an open loop",
                      text: "Draft a thoughtful follow-up and review it together.",
                      prompt:
                        "Help me draft a concise follow-up. Ask who it is for and what outcome I need.",
                    },
                    {
                      title: "Build a better memory",
                      text: "Give your assistant context about how you work.",
                      action: () => navigate("wiki"),
                    },
                  ].map((item) => (
                    <button
                      className="suggestion-row"
                      key={item.title}
                      onClick={() =>
                        item.action ? item.action() : setPrompt(item.prompt!)
                      }
                    >
                      <span className="suggestion-icon">
                        <Layers3 size={17} />
                      </span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.text}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  <div className="context-note">
                    <BookOpen size={21} />
                    <h3>It starts with understanding you.</h3>
                    <p>
                      Your wiki brings together the context you choose to share.
                      You can inspect and correct it at any time.
                    </p>
                    <button onClick={() => navigate("wiki")}>
                      Explore my wiki <ChevronRight size={15} />
                    </button>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === "tasks" && (
            <>
              <PageHeading
                title="Your work, moving forward."
                text="Follow progress, review a draft, or pick up where you left off."
              />
              {routineControls}
              <TaskList
                tasks={data.tasks}
                onSelect={(t) => {
                  setSelected(t);
                  onTaskOpen?.(t.id);
                }}
              />
              {!data.tasks.length && (
                <div className="empty">
                  <ListTodo />
                  <h3>No tasks yet</h3>
                  <button className="primary" onClick={() => navigate("home")}>
                    Start a task
                  </button>
                </div>
              )}
            </>
          )}
          {view === "wiki" && (
            <>
              <PageHeading
                title="A wiki that grows with you."
                text="Your projects, people, and preferences, with the context behind them."
              />
              {knowledgeControls}
              <div className="wiki-layout">
                <aside className="wiki-index">
                  <label className="search">
                    <Search size={16} />
                    <input
                      aria-label="Search wiki pages"
                      placeholder="Find a page"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  {data.wiki
                    .filter((p) =>
                      p.title.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((p) => (
                      <button
                        className={p.id === page?.id ? "selected" : ""}
                        key={p.id}
                        onClick={() => {
                          setWikiId(p.id);
                          setEditing(false);
                        }}
                      >
                        <BookOpen size={16} />
                        {p.title}
                      </button>
                    ))}
                  {!data.wiki.length && (
                    <p className="quiet">
                      Reviewed knowledge pages will appear here.
                    </p>
                  )}
                </aside>
                <article className="wiki-page">
                  {page ? (
                    <>
                      <div className="section-heading">
                        <h2>{page.title}</h2>
                        <button
                          onClick={() => {
                            setDraft(page.body);
                            setDraftRevision(page.revision);
                            setEditing(!editing);
                          }}
                        >
                          {editing ? "Cancel" : "Edit page"}
                        </button>
                      </div>
                      <p className="quiet">
                        Updated {date(page.updatedAt)} · {page.sources} linked
                        sources
                      </p>
                      {editing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(
                              async () => {
                                await onSaveWiki(page.id, draft, draftRevision);
                                setEditing(false);
                              },
                              demo
                                ? "Demo page updated for this tab."
                                : "Page updated.",
                            );
                          }}
                        >
                          <textarea
                            className="wiki-editor"
                            aria-label="Page content"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            maxLength={20000}
                          />
                          <button className="primary" disabled={busy}>
                            Save page
                          </button>
                        </form>
                      ) : (
                        <div className="wiki-prose">
                          {page.body.split("\n\n").map((p, i) => (
                            <p key={i}>{p}</p>
                          ))}
                        </div>
                      )}
                      <div className="provenance-note">
                        <ShieldCheck size={17} />
                        <span>
                          Editing a page preserves its underlying source records
                          and relationships.
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="empty">
                      <BookOpen />
                      <h3>Your knowledge starts with you</h3>
                      <p>
                        Approved facts and source-backed pages will appear here.
                        No account has been imported automatically.
                      </p>
                    </div>
                  )}
                </article>
              </div>
            </>
          )}
          {view === "agent" && (
            <>
              <PageHeading
                title="An assistant that feels like yours."
                text="Choose how your assistant communicates. Workspace rules always apply."
              />
              <div className="agent-profile">
                <span className="avatar large">
                  <Sparkles size={45} strokeWidth={1.5} />
                </span>
                <div>
                  <h2>{data.agent.name}</h2>
                  <p className="quiet">Your personal assistant</p>
                </div>
              </div>
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => onSaveAgent(agent),
                    demo
                      ? "Personality updated for this demo tab."
                      : "Assistant preferences saved.",
                  );
                }}
              >
                <label>
                  Name
                  <input
                    value={agent.name}
                    onChange={(e) =>
                      setAgent({ ...agent, name: e.target.value })
                    }
                    maxLength={60}
                    required
                  />
                </label>
                <fieldset>
                  <legend>Communication style</legend>
                  <div className="choices">
                    {(["warm", "concise", "analytical"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        aria-pressed={agent.tone === t}
                        className={
                          agent.tone === t ? "choice selected" : "choice"
                        }
                        onClick={() => setAgent({ ...agent, tone: t })}
                      >
                        <strong>{t[0].toUpperCase() + t.slice(1)}</strong>
                        <span>
                          {t === "warm"
                            ? "Thoughtful and conversational"
                            : t === "concise"
                              ? "Direct and to the point"
                              : "Structured and evidence-led"}
                        </span>
                        {agent.tone === t && <Check size={16} />}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label>
                  Level of detail
                  <select
                    value={agent.detail}
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        detail: e.target.value as AgentView["detail"],
                      })
                    }
                  >
                    <option value="brief">Brief</option>
                    <option value="balanced">Balanced</option>
                    <option value="thorough">Thorough</option>
                  </select>
                </label>
                <label>
                  How should your assistant work with you?
                  <textarea
                    rows={4}
                    maxLength={3000}
                    value={agent.instructions}
                    onChange={(e) =>
                      setAgent({ ...agent, instructions: e.target.value })
                    }
                  />
                </label>
                <p className="quiet">
                  Preferences guide responses. They never grant access to
                  accounts, bypass approvals, or change retention rules.
                </p>
                <button className="primary" disabled={busy}>
                  Save preferences
                </button>
              </form>
            </>
          )}
          {view === "connections" && (
            <>
              <PageHeading
                title="Bring your context together."
                text="See what is available and what has actually been verified."
              />
              <div className="connection-grid">
                {data.connections.map((c) => (
                  <article className="connection" key={c.id}>
                    <div className="connection-heading">
                      <span className="connection-logo">{c.name[0]}</span>
                      <Status value={c.state} />
                    </div>
                    <h2>{c.name}</h2>
                    <p className="quiet">{c.category}</p>
                    <p>{c.detail}</p>
                  </article>
                ))}
              </div>
              <div className="provenance-note">
                <ShieldCheck size={18} />
                <span>
                  A configured service is not necessarily connected or working.
                  Live verification requires a confirmed provider result.
                </span>
              </div>
            </>
          )}
          {view === "admin" && (
            <>
              <PageHeading
                title="A clear view for IT."
                text="Manage the workspace without opening someone’s private conversations or wiki."
              />
              <div className="admin-metrics">
                <div>
                  <span>Members</span>
                  <strong>{data.members.length}</strong>
                  <small>In this workspace</small>
                </div>
                <div>
                  <span>Model usage</span>
                  <strong>{money(data.spentUsd)}</strong>
                  <small>
                    {money(data.reservedUsd)} reserved for work in progress
                  </small>
                </div>
                <div>
                  <span>Workspace limit</span>
                  <strong>{money(data.limitUsd)}</strong>
                  <small>Monthly spending ceiling</small>
                </div>
              </div>
              {adminControls}
              <section className="admin-section">
                <div className="section-heading">
                  <h2>People & access</h2>
                  <Users size={19} />
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Role</th>
                        <th>Access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((m) => (
                        <tr key={m.id}>
                          <td>
                            <span className="table-avatar">{m.name[0]}</span>
                            {m.name}
                          </td>
                          <td>{m.role}</td>
                          <td>
                            <span className="pill">{m.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="admin-section">
                <div className="section-heading">
                  <h2>Activity log</h2>
                  <ShieldCheck size={19} />
                </div>
                {data.audit.map((event) => (
                  <div className="audit-row" key={event.id}>
                    <ShieldCheck size={16} />
                    <span>{event.action.replaceAll(".", " / ")}</span>
                    <time>{date(event.createdAt)}</time>
                  </div>
                ))}
                {!data.audit.length && (
                  <p className="quiet">
                    Workspace administration events appear here.
                  </p>
                )}
              </section>
              <p className="quiet">
                This first release provides workspace membership, spending
                controls, and audit foundations. See the readiness checklist for
                remaining enterprise controls.
              </p>
            </>
          )}
        </main>
        <footer className="workspace-footer">
          <Compass size={14} />
          <span>Harbor</span>
          <span>Personal by design. Managed by you.</span>
        </footer>
      </div>
      {currentTask && (
        <div className="modal-scrim" onClick={() => setSelected(undefined)}>
          <section
            className="task-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close-dialog icon-button"
              aria-label="Close task"
              onClick={() => setSelected(undefined)}
            >
              <X />
            </button>
            <Status value={currentTask.status} />
            <h2 id="task-title">{currentTask.title}</h2>
            <p className="quiet">Created {date(currentTask.createdAt)}</p>
            {currentTask.delivery && (
              <div className="delivery-review">
                <p>
                  <strong>To:</strong> {currentTask.delivery.to}
                </p>
                <p>
                  <strong>Subject:</strong> {currentTask.delivery.subject}
                </p>
              </div>
            )}
            <div className="task-result">
              {currentTask.response ??
                (currentTask.error
                  ? "This task could not finish. Review its status before trying again."
                  : "Results will appear here as the task progresses.")}
            </div>
            {currentTask.status === "awaiting_approval" && (
              <div className="dialog-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => onApprove(currentTask.id, false),
                      "Request declined.",
                    )
                  }
                >
                  Decline
                </button>
                <button
                  className="primary"
                  disabled={busy || !currentTask.reviewReady}
                  onClick={() =>
                    void run(
                      () => onApprove(currentTask.id, true),
                      "Approval recorded.",
                    )
                  }
                >
                  Approve
                </button>
              </div>
            )}
            {["queued", "running", "awaiting_approval"].includes(
              currentTask.status,
            ) && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => onCancel(currentTask.id),
                    "Cancellation requested.",
                  )
                }
              >
                Cancel task
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function PageHeading({ title, text }: { title: string; text: string }) {
  return (
    <div className="page-heading">
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      {statuses[value] ?? value.replaceAll("_", " ")}
    </span>
  );
}
function TaskList({
  tasks,
  onSelect,
}: {
  tasks: TaskView[];
  onSelect: (t: TaskView) => void;
}) {
  return (
    <div className="task-list">
      {tasks.map((task) => (
        <button
          className="task-row"
          key={task.id}
          onClick={() => onSelect(task)}
        >
          <span className="task-icon">
            {task.status === "awaiting_approval" ? (
              <ShieldCheck size={18} />
            ) : task.status === "running" ? (
              <Clock3 size={18} />
            ) : (
              <MessageSquare size={18} />
            )}
          </span>
          <span className="task-row-text">
            <strong>{task.title}</strong>
            <Status value={task.status} />
          </span>
          <time>{date(task.createdAt)}</time>
          <ChevronRight size={15} />
        </button>
      ))}
    </div>
  );
}
