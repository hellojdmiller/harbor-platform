import type { WorkspaceView } from "./ui-types";
const now = Date.UTC(2026, 8, 20, 15);
export const demoWorkspace: WorkspaceView = {
  id: "demo",
  name: "Northstar workspace",
  userName: "Alex",
  role: "owner",
  agent: {
    name: "Piper",
    tone: "warm",
    detail: "balanced",
    instructions:
      "Start with the decision or next step. Keep meeting preparation practical. Ask before contacting someone.",
  },
  tasks: [
    {
      id: "brief",
      title: "Prepare for the Northstar partner meeting",
      status: "completed",
      createdAt: now,
      response:
        "Your meeting brief is ready. Review the investment memo, confirm the two open diligence questions, and reserve ten minutes for next steps.\n\nThis is a fictional example of an assistant result.",
    },
    {
      id: "followup",
      title: "Draft a follow-up to the product team",
      status: "awaiting_approval",
      createdAt: now - 3600000,
      response:
        "I’ve drafted the follow-up. Review the recipient and message before approving delivery.",
    },
    {
      id: "research",
      title: "Compare the three data room providers",
      status: "completed",
      createdAt: now - 86400000,
      response:
        "A fictional comparison would appear here with links to supporting sources.",
    },
  ],
  wiki: [
    {
      id: "overview",
      title: "Overview",
      body: "Alex leads operations at Northstar, a fictional investment firm. This is the starting point for their personal knowledge base.\n\nCurrent focus\nPreparing for the partner meeting, making onboarding easier, and connecting the right people to ongoing projects.\n\nHow this wiki works\nPages are an editable view of underlying knowledge. Facts keep their sources, permissions, timestamps, and review history separately from the prose.",
      updatedAt: now,
      sources: 0,
    },
    {
      id: "preferences",
      title: "Communication preferences",
      body: "Lead with a clear recommendation. Put open decisions before background context. Keep follow-ups short and include an owner and next step.\n\nThis fictional preference illustrates information a user can review and correct.",
      updatedAt: now,
      sources: 0,
    },
    {
      id: "projects",
      title: "Projects and goals",
      body: "Onboarding refresh\nBuild a clear first-week checklist and reduce repeated setup questions.\n\nPartner meeting\nBring source-backed updates and outstanding decisions together in one place.",
      updatedAt: now,
      sources: 0,
    },
  ],
  connections: [
    {
      id: "gmail",
      name: "Gmail",
      category: "Email",
      state: "planned",
      detail: "Direct Google API adapter is planned.",
    },
    {
      id: "outlook",
      name: "Outlook",
      category: "Email and calendar",
      state: "planned",
      detail: "Direct Microsoft Graph adapter is planned.",
    },
    {
      id: "resend",
      name: "Resend",
      category: "Application email",
      state: "not_configured",
      detail: "Server credentials and a verified sending domain are required.",
    },
    {
      id: "slack",
      name: "Slack",
      category: "Team communication",
      state: "planned",
      detail: "Pipedream Connect is being evaluated for OAuth custody.",
    },
    {
      id: "mcp",
      name: "Custom MCP",
      category: "Tools and knowledge",
      state: "planned",
      detail: "Scoped connector registration and execution are planned.",
    },
  ],
  members: [
    { id: "alex", name: "Alex Morgan", role: "owner", status: "active" },
    { id: "sam", name: "Sam Rivera", role: "member", status: "active" },
  ],
  audit: [
    { id: "a1", action: "workspace.created", createdAt: now },
    { id: "a2", action: "agent.updated", createdAt: now },
  ],
  spentUsd: 0,
  reservedUsd: 0,
  limitUsd: 20,
};
