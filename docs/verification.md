# Verification evidence

## Local restoration rehearsal — 2026-09-20

An exported snapshot with file storage was imported into a new, empty anonymous Convex backend on ports 8792/8793. The original backend on 8790/8791 was not replaced or stopped. The verification script called the restored backend over HTTP and confirmed the fictional user's workspace, assistant preferences, wiki body, failed-before-dispatch task and exact stored file bytes.

A second export from the restored deployment matched all compared application and component table rows exactly; the stored file SHA-256 also matched. Nested Workflow, workpool and batchWorker configuration/worker metadata were included and restored. The snapshot contained **no active workflow journals, steps, events, pending approvals, outbound intents or routines**, so recovery of in-flight work and scheduled jobs remains unverified. Authentication used the local administrator's identity-impersonation test facility, not a real OIDC sign-in. No provider key was installed and external writes were disabled.

The test backend was stopped afterward; the original backend remained reachable. Sanitized counts, archive hash and limits are in [restore-verification.json](restore-verification.json). This local rehearsal is not evidence of production cloud backup, disaster recovery, RPO/RTO, or live provider verification.

## Application and protocol checks

The initial public implementation passed TypeScript checks, an optimized Next.js build and 88 backend/protocol tests. Coverage includes owner/workspace isolation, admission, spending reservations, durable component execution, exact approval, provider ambiguity, source revocation, expiry, held conversation visibility, editable wiki revisions, signatures/deduplication and real SDK-to-OTLP redaction.

GitHub CI also passed desktop and mobile browser tests against the production build: demo navigation, composer boundary, personality edits, wiki edits, administration and horizontal overflow. In-app browser checks inspected both desktop and narrow layouts and exercised the same user-facing controls. These are fictional demo checks, not authenticated cloud acceptance.

The real local Convex backend was exercised over HTTP with its local test identity facility: anonymous and cross-owner access was rejected, wiki/files persisted, an unconfigured model task failed before dispatch, and its cost reservation was released. No provider credentials or paid external calls were used. Production OIDC sign-in, live model output, live email delivery and a cloud deployment remain unverified.
