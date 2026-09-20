# Providers and integrations

Harbor implements a server-side Anthropic text adapter and one approval-gated Resend email action. These are real provider HTTP paths, covered by local fixtures. This repository has **not been live verified against a customer account**. No Gmail, Outlook, Slack, Pipedream, E2B, or remote MCP connection is fabricated.

## Capability states

| State             | Evidence required                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `not_implemented` | Research or interface only; no working connection path.                                                          |
| `implemented`     | Adapter and validation exist; local fixture tests pass.                                                          |
| `configured`      | Required deployment configuration is present. This does not establish credential validity or account access.     |
| `connected`       | A specific owner account completed authorization and passed a current access check. Not emitted by this release. |
| `live_verified`   | A documented operation succeeded against the intended real account. Not emitted by this release.                 |

`integrations.status` and `ai.catalog` require an active workspace member. They expose capability metadata, never credentials. The Google/Microsoft mail and calendar types in `lib/integrations/types.ts` are extension interfaces, not ingestion implementations. Browser sign-in/OIDC does not authorize mailbox access: each connector needs its own scoped OAuth consent, refresh/revocation handling, and owner binding.

## Anthropic text generation

`lib/ai/types.ts` separates provider behavior from routing policy. `convex/ai.ts` is an internal task action; browsers cannot submit arbitrary owner IDs, credentials, endpoints, or unrestricted provider requests. The adapter uses the official [Messages API](https://platform.claude.com/docs/en/api/messages/create), a fixed HTTPS endpoint, a fixed API-version header, bounded text input/output, no redirects, and one HTTP attempt. Tools, image input, streaming, provider-side memory, prompt caching, and arbitrary code execution are not enabled.

The bundled catalog was checked against the [official models overview](https://platform.claude.com/docs/en/models/overview) on **2026-09-20**:

| Explicit API ID             | Provider context / maximum output | Input / output USD per million tokens |
| --------------------------- | --------------------------------- | ------------------------------------- |
| `claude-sonnet-5`           | 1,000,000 / 128,000               | $2 / $10                              |
| `claude-opus-5`             | 1,000,000 / 128,000               | $5 / $25                              |
| `claude-haiku-4-5-20251001` | 200,000 / 64,000                  | $1 / $5                               |

Application limits are intentionally smaller than those provider limits. Normal durable tasks request at most 4,096 output tokens. The generic adapter caps output at 8,192 tokens and combined prompt input at 64,000 UTF-8 bytes. Adapter capabilities are text-only even where the underlying model supports more. Quality and latency tiers are routing labels, not measurements or service guarantees. Unknown IDs fail closed. See Anthropic's [model ID versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) before changing the server catalog.

Set `ANTHROPIC_API_KEY` only in the **Convex deployment environment**. Optionally set `ANTHROPIC_MODELS_JSON` to a JSON array with every `ModelDescriptor` field: explicit ID, provider `anthropic`, label, capabilities `["text"]`, context/output limits, quality, latency, and positive integer input/output microdollars per token. A custom catalog replaces the bundled list; workspace policy must separately allow its IDs. Never prefix provider credentials with `NEXT_PUBLIC_`.

Routing checks model/provider allowlists, implemented capabilities, context capacity, configured quality/latency constraints, and reservation size. The current task UI exposes an explicit model choice; it does not implement a learned optimizer. Reservation uses UTF-8 input bytes plus system/framing allowance and the maximum output cost. Task creation also reserves 16 KiB for profile and selected knowledge context. This is conservative internal accounting with versioned prices, not a guarantee of a provider invoice; configure provider-side spending limits as a backstop and review pricing changes.

## Personal behavior and reviewed knowledge

The actual provider request includes the owner's agent name, tone, detail preference, and bounded custom instructions. A fixed system instruction makes those preferences subordinate to action authorization. Preferences are encoded as data; they cannot authorize email, tools, or memory writes.

The request may include up to 12 currently approved owner knowledge entries. Whole facts must fit a 12 KiB UTF-8 JSON budget; profile and fact context together must fit the reserved 16 KiB. Omitted entries are not represented as retrieved or used. This is bounded retrieval of explicitly reviewed facts, not model training, embeddings, or automatic mailbox learning.

Owner membership, entity revisions, source revisions, source expiration, and connector grant leases are checked before provider dispatch. Selected entity references travel with derived task, conversation, and email-intent content. After the HTTP response, Harbor rechecks those exact references; already-revoked text is discarded before the workflow journals its action result. The workflow then performs an atomic final check before publishing. A withheld response still records verified token usage. Reads, approval, and external dispatch revalidate the same provenance. Revocation cannot retract content already delivered to an external recipient, and provider-side retention is a separate contract.

A task reserves budget and persists its dispatch barrier before calling the provider. Transport failures or unverified usage keep the reservation held in `needs_reconciliation`; they do not invent zero usage or automatically retry a possibly billed request. Verified output records input/output tokens, configured cost, safe provider request ID, bounded routing reasons, and timing. Prompts, model output, custom instructions, email addresses, and provider error bodies are absent from provider receipt metadata.

## Approval-gated Resend email

The real action posts the exact approved recipient, subject, and plain text to [Resend's email endpoint](https://resend.com/docs/api-reference/emails/send-email). The sender is server controlled. HTML, attachments, recipient lists, and arbitrary endpoints are not supported in this initial action.

All three deployment settings are required: `RESEND_API_KEY`, `RESEND_FROM` (a sender valid for the deployment's verified domain), and `ENABLE_EXTERNAL_WRITES=true`. External writes remain off unless the last value is exactly `true`. Workspace email policy must also allow sending. A user must approve the concrete generated draft; an internal claim checks ownership, current approval, source access, policy, and the dispatch barrier immediately before the HTTP request. The adapter accepts only the resulting server intent.

A stable intent ID is used as the [Resend idempotency key](https://resend.com/docs/dashboard/emails/idempotency-keys). Resend caches keys for 24 hours; Harbor's durable barrier prevents automatic resubmission after that window too. A successful HTTP receipt means **submitted**, not delivered. Uncertain submissions need reconciliation against the provider record before a new attempt.

## Verified event receiver

Configure `RESEND_WEBHOOK_SECRET` in Convex and point the Resend webhook at `https://<your-deployment>.convex.site/webhooks/resend`. The receiver preserves raw bytes, limits bodies to 64 KiB, validates the `svix-id`, `svix-timestamp`, and `svix-signature` headers, and rejects timestamps outside a five-minute window. It follows [Resend verification guidance](https://resend.com/docs/webhooks/verify-webhooks-requests) and the [Svix manual HMAC protocol](https://docs.svix.com/receiving/verifying-payloads/how-manual) using Web Crypto, which is available in the Convex runtime. A published Svix fixture provides an independent signature test.

Only allowlisted event type, event ID, provider message ID, and timestamps are retained. Event IDs deduplicate atomically. A signed `email.received` event records receipt metadata only: it does not retrieve an email body, start an agent, trust instructions in mail, or authorize a reply. Owners can read delivery receipts only through an intent they own; workspace administrators do not inherit access to personal email content.

## Metadata retention and observability

Provider receipt expiry is the workspace retention setting at creation, capped at 90 days. Email event metadata expires after 30 days. Expired records are hidden from ordinary reads. Hourly internal jobs physically purge receipt metadata in bounded 100-row pages; held workspaces retain their provider receipts and associated outbound email events. Unattached receipt events have no workspace hold association and expire after 30 days. Holds do not restore expired records to normal reads. Changing the workspace retention period does not rewrite historical provider-receipt expiry.

The execution retention job separately handles expired task/intent payloads and completed Workflow journals. Full platform retention, backups, attachments, knowledge history, downstream providers, and legal-hold administration require the broader documented release review; this receipt purge is not a complete data deletion guarantee. Next.js OpenTelemetry export is separately configured by the web deployment. Provider metadata here is persisted in Convex, not automatically exported as a distributed trace.

## Evaluated extension paths

- **Pipedream Connect:** [managed end-user authorization](https://pipedream.com/docs/connect) could supply Google, Microsoft, and Slack OAuth. A future implementation must bind its external-user identifier to Harbor's authenticated owner, keep project credentials server-side, minimize scopes, verify refresh/revocation, and use the existing grant/source revision boundary. No OAuth session or retrieval call is wired today.
- **E2B:** the [sandbox SDK](https://docs.e2b.dev/) is a candidate for code execution. Adoption requires explicit execution approval, CPU/time/spend limits, isolated file handling, egress controls, and cleanup receipts. No sandbox executes in this release.
- **MCP:** remote servers must meet [MCP authorization requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), including resource-bound tokens and owner-scoped access. Harbor would also need tool allowlists and per-action approval; a connector token must not become broad execution authority. No remote server or tool is connected.
- **Other model providers:** implement `ModelProvider`, add validated catalog metadata and policy routing, and run the same dispatch/cost/revocation tests. The typed boundary does not itself provide OpenAI, Codex, Claude Code, or ChatGPT product parity.

## Verification before enabling a deployment

Local provider tests use fictional accounts and controlled HTTP responses. They cover real request shapes, output/usage validation, byte limits, no duplicate dispatch, signature tampering, replay deduplication, owner isolation, held-record pagination, and revoked context. They do not establish that a real API key, sender domain, OAuth grant, webhook subscription, or cloud deployment works.

For a staging verification, configure the intended deployment's keys, leave writes off initially, run one bounded text request, and compare its usage receipt with the provider console. Then enable a restricted workspace and deployment email gate, approve one exact test email addressed to an operator-controlled inbox, and correlate its submission ID with a signed delivery event. Record provider account, deployment, time, and outcome without storing secrets. Only then label that specific path live verified. No live provider calls were made while building these fixtures.
