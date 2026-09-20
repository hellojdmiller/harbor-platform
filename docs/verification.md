# Verification evidence

## Local restoration rehearsal — 2026-09-20

An exported snapshot with file storage was imported into a new, empty anonymous Convex backend on ports 8792/8793. The original backend on 8790/8791 was not replaced or stopped. The verification script called the restored backend over HTTP and confirmed the fictional user's workspace, assistant preferences, wiki body, failed-before-dispatch task and exact stored file bytes.

A second export from the restored deployment matched all compared application and component table rows exactly; the stored file SHA-256 also matched. Nested Workflow, workpool and batchWorker configuration/worker metadata were included and restored. The snapshot contained **no active workflow journals, steps, events, pending approvals, outbound intents or routines**, so recovery of in-flight work and scheduled jobs remains unverified. Authentication used the local administrator's identity-impersonation test facility, not a real OIDC sign-in. No provider key was installed and external writes were disabled.

The test backend was stopped afterward; the original backend remained reachable. Sanitized counts, archive hash and limits are in [restore-verification.json](restore-verification.json). This local rehearsal is not evidence of production cloud backup, disaster recovery, RPO/RTO, or live provider verification.
