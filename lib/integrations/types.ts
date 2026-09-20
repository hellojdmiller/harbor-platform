export type IntegrationState =
  | "not_implemented"
  | "implemented"
  | "configured"
  | "connected"
  | "live_verified";
export interface IntegrationCapability {
  id: string;
  name: string;
  state: IntegrationState;
  actions: readonly string[];
  externalWrites: boolean;
  detail: string;
}
export interface EmailIntent {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}
export type EmailResult =
  | { status: "submitted"; providerId: string }
  | { status: "failed" | "uncertain"; detail: string };
export interface OutboundEmailAdapter {
  readonly id: string;
  send(intent: EmailIntent): Promise<EmailResult>;
}
// Future read adapters must import server-verified grant revisions, never browser-supplied provenance.
export interface MailRecord {
  id: string;
  revision: string;
  subject: string;
  text: string;
}
export interface CalendarRecord {
  id: string;
  revision: string;
  title: string;
  startsAt: string;
  endsAt: string;
}
export interface MailReadAdapter {
  list(): Promise<MailRecord[]>;
  read(id: string): Promise<MailRecord>;
}
export interface CalendarReadAdapter {
  list(): Promise<CalendarRecord[]>;
  read(id: string): Promise<CalendarRecord>;
}
