# Operations and recovery

## Ownership and environments

Assign an application owner, identity administrator, Convex operator and incident responder before production. Use separate development, preview and production deployments, scoped keys and provider accounts. Clerk handles account recovery/MFA in the reference deployment; Harbor does not implement password reset itself. Keep organization app assignment restricted. Default backend admission is explicit: only configured bootstrap subjects can create owner workspaces; other users need an administrator-created admission.

Health endpoints report process/configuration state, not provider success. Monitor Convex action failures, workflow completion/timeout, stale approvals, uncertain intents, reservation age, monthly usage, webhook rejection, and source verification expiry. Unknown results require an operator reconciliation record. Turning a provider off does not establish whether an earlier dispatched request completed.

## OpenTelemetry and errors

Set an HTTPS `OTEL_EXPORTER_OTLP_ENDPOINT` and server-only collector headers on Vercel. The checked-in exporter projects spans onto an allowlist: method/status and explicit Harbor operation/outcome/duration attributes. It replaces names, removes URL/content/identity attributes, events, links, exception text, trace state and inherited resource attributes. Tests serialize a real SDK span to OTLP to verify the boundary.

Convex model receipts hold usage, latency, model ID, routing reasons, provider request ID and bounded error codes. They do not hold prompt/response bodies. These records are not yet exported as correlated backend OTLP spans; collector alerts and end-to-end tracing are a remaining gate. Configure Convex log streaming/error reporting in the chosen plan and verify notifications reach the operator. Do not export raw task or knowledge tables to an observability vendor.

## Backups and restoration

Use managed backups where available, plus independently tested exports appropriate to the organization's RPO. Include Convex file storage. Keep snapshots encrypted with a restricted access policy; an export is private user data, not an artifact to put in Git.

```sh
npx convex export --include-file-storage --path /secure/backup/harbor-snapshot.zip
```

The command above targets development unless a production selector is deliberately provided. Inspect the target before exporting. Separate file/DB snapshots are insufficient if workflow component state or provider secrets are missing.

Restore into an **isolated empty deployment** first:

```sh
npx convex import /secure/backup/harbor-snapshot.zip
```

Configure identity and server secrets separately; an export is not a credentials backup. Convex snapshot exports include component subdirectories; the component-aware import behavior and any required `--component` import must be verified for your installed CLI. Never assume scheduled jobs or external provider results rolled back with database data.

Keep external writes disabled on restoration. Verify workspace/user/owner relationships, source grants, file bytes, wiki revisions, tasks, budgets, approvals and Workflow journals. Reconcile every dispatched/uncertain intent against the real provider before resuming. Record record counts/hashes, elapsed time, failures, and the approved RPO/RTO. A successful ZIP import alone is not recovery acceptance.

`docs/verification.md` records the local fictional-data rehearsal. A production cloud restore with real identity and providers remains required.

## Upgrades and rollback

1. Run CI and acceptance tests against isolated preview data. Export a current snapshot before schema/data changes.
2. Use expand/migrate/contract: add optional fields/indexes, backfill in bounded internal mutations, verify counts, switch readers/writers, then remove old fields in a later release. This initial release has schema validation, not a versioned migration runner.
3. Keep a known-good frontend/backend commit and a record of compatible schema/component versions. Workflow journals replay code: do not reorder existing durable steps without the component's supported migration/versioning strategy.
4. A Vercel frontend rollback does not roll back Convex code, data, component state or external effects. Deploy a compatible backend revision or a forward fix separately. Never automatically restore production data as a frontend rollback.
5. Re-run auth, task, source revocation, approval and receipt tests. Keep uncertain external intents paused throughout.

## Retention

Current source/entity/wiki/file read eligibility and scheduled expiry invalidation coexist with physical retained bytes. Tasks/conversations/intent bodies have bounded cleanup; held data remains preserved but ineligible for normal expired reads. Receipt metadata has bounded scheduled deletion. Complete organization retention administration, legal preservation, erasure across all derived tables/backups, and policy-change rescheduling still need a dedicated lifecycle rollout. The product must not claim compliant deletion from a read-time filter alone.

## Capacity and estimated costs

Planning assumptions, not a quote: a small development/pilot footprint, one developer/operator seat and low traffic. Prices checked 2026-09-20; review current billing and contractual requirements before purchase.

| Service             | Illustrative baseline                                                            | Source                                           |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| Vercel Pro          | $20/month, plus applicable usage and seats                                       | [Vercel pricing](https://vercel.com/pricing)     |
| Convex Professional | $25/developer/month, plus usage                                                  | [Convex pricing](https://www.convex.dev/pricing) |
| Clerk               | Free tier or $20/month Pro billed annually; enterprise connections/add-ons extra | [Clerk pricing](https://clerk.com/pricing)       |
| Resend              | Free tier or $20/month Pro at listed email allowance                             | [Resend pricing](https://resend.com/pricing)     |

Illustrative infrastructure baseline is roughly **$45–85/month**, before model use, extra seats, storage/egress, enterprise identity features, telemetry, support and taxes. An enterprise plan/contract can be substantially higher. End-user Harbor membership is different from vendor developer/operator seats.

Model cost is `(input tokens × input rate) + (output tokens × output rate)` with prices in `lib/ai/routing.ts` or the configured catalog. Reservations deliberately overestimate plain-text usage; they are a spending control, not an invoice. Preserve unknown spend until reconciled. Start with a small user budget and measure workload before increasing concurrency or adopting more infrastructure.
