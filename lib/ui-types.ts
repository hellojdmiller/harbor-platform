export type View =
  "home" | "tasks" | "wiki" | "agent" | "connections" | "admin";
export type TaskView = {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  response?: string;
  reviewReady?: boolean;
  error?: string;
  approvalId?: string;
  delivery?: { to: string; subject: string };
};
export type WikiView = {
  id: string;
  title: string;
  body: string;
  revision?: number;
  updatedAt: number;
  sources: number;
};
export type AgentView = {
  name: string;
  tone: "concise" | "warm" | "analytical";
  detail: "brief" | "balanced" | "thorough";
  instructions: string;
};
export type ConnectionView = {
  id: string;
  name: string;
  category: string;
  state: string;
  detail: string;
};
export type MemberView = {
  id: string;
  name: string;
  role: string;
  status: string;
};
export type WorkspaceView = {
  id: string;
  name: string;
  userName: string;
  role: string;
  tasks: TaskView[];
  wiki: WikiView[];
  agent: AgentView;
  connections: ConnectionView[];
  members: MemberView[];
  audit: { id: string; action: string; createdAt: number }[];
  spentUsd: number;
  reservedUsd: number;
  limitUsd: number;
};
