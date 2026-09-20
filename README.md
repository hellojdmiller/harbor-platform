# Harbor

**Personal AI assistants, with the controls IT needs.**

Harbor is an open TypeScript application for deploying personal assistants to a managed workspace. People get a task-first home, an assistant personality, routines, and an editable personal wiki. Administrators get membership boundaries, model restrictions, spending limits, and audit records.

**Status: developer preview, not a production-certified enterprise release.** This is the new Convex/Vercel implementation. External integrations that have not been built or verified are labeled as such. The demo uses fictional data and cannot run tasks or send messages.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhellojdmiller%2Fharbor-platform&env=CONVEX_DEPLOY_KEY,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,CLERK_SECRET_KEY&envDescription=Create%20separate%20Convex%20and%20Clerk%20environments%20first&envLink=https%3A%2F%2Fgithub.com%2Fhellojdmiller%2Fharbor-platform%2Fblob%2Fmain%2Fdocs%2Fdeployment.md)

The button imports the application; it does not provision identity, provider credentials, a domain, or a production readiness review. Follow the [deployment guide](docs/deployment.md).

## What is built

- Next.js / React interface with a separate administration view and a responsive fictional demo.
- Convex database, file storage, server authorization, and reactive task/conversation/wiki/routine queries.
- Provider-neutral verified JWT identity, a Clerk reference frontend, default-deny owner bootstrap, and owner-assigned user provisioning.
- The official Convex Workflow component for durable tasks, approval events, cancellation, deadlines, bounded recovery, and recurring/event-triggered routines.
- Atomic workspace and personal model-spend reservations. Unknown provider outcomes retain their reservations until reconciled.
- An Anthropic adapter with configurable model IDs, explicit routing restrictions, and redacted usage receipts.
- Persisted external email intent, exact-message approval, Resend idempotency keys, signed webhook receipts, and an uncertain-outcome state.
- Owner-scoped knowledge entities, relationships, identity review, provenance, corrections, and editable wiki presentations.
- An OpenTelemetry exporter that strips content, URLs, identities, exceptions, and arbitrary attributes before export.

See [readiness](docs/readiness.md) for what remains. Google/Microsoft OAuth ingestion, Pipedream, MCP tools, E2B, subscriptions/billing, semantic embeddings, and automated lifecycle administration are **not complete**. Resend inbound events are verified and recorded; routing inbound messages to an assistant is not yet implemented.

## Local development

Requires Node.js 22 or newer and npm.

```sh
npm ci
cp .env.example .env.local
npm run dev:backend
```

Convex will guide you through a development deployment and set `NEXT_PUBLIC_CONVEX_URL`. In another terminal:

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000). Without identity keys, the setup screen links to `/demo`. For a working assistant, configure the Clerk JWT integration and the server-side Anthropic key as described in [deployment](docs/deployment.md). Never put provider credentials in `NEXT_PUBLIC_` variables.

```sh
npm run doctor
npm run check
npx playwright install chromium
npm run test:browser
```

Tests use fictional records and intercepted provider HTTP responses. They do not establish that a real mailbox, model account, or sending domain is configured.

## Deployment

The supported target is **Vercel + Convex**. The web app is Next.js; Convex owns durable application state and external-call actions. Vercel previews and production use separate Convex deployments and identity instances.

- [Deploy and configure](docs/deployment.md)
- [Architecture and engineering choices](docs/architecture.md)
- [Required architecture and acceptance tracking](docs/readiness.md)
- [Durable execution](docs/durable-execution.md)
- [Knowledge and permissions](docs/knowledge.md)
- [Providers and integration status](docs/providers-integrations.md)
- [Operations, recovery, and rollback](docs/operations.md)
- [Security policy](SECURITY.md)

This repository contains a clean public implementation. It contains no customer data or private pilot history. Apache-2.0 licensed. Vendor services retain their own terms and costs.
