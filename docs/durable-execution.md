# Durable assistant execution

Harbor uses the official [`@convex-dev/workflow`](https://github.com/get-convex/workflow) component, pinned in the lockfile, for persisted assistant tasks. The first executable path is a text task using an approved Anthropic model, followed optionally by an exact-draft email approval and Resend submission. The same path runs from a scheduled routine or an authenticated owner event. This is not an arbitrary agent/tool executor.

The application persists task state, a user message, spending reservations, provider dispatch claims, model usage, approvals, outbound intents and receipts. Workflow steps and approval events survive application process restarts. Browser subscriptions observe this state; closing a tab does not cancel a task.

## Lifecycle

1. `execution.start` resolves the signed-in user and active workspace membership. The client cannot select an owner. It checks the current model policy, recipient format, capacity and spending limits, then reserves both the owner's and workspace's monthly allowance in the same Convex transaction that starts the workflow.
2. `ai.generateTask` requires a configured deployment key. `execution.claimModelDispatch` checks access, deadline, policy and reservation again and records a one-use dispatch barrier. The action composes the task with the owner's agent preferences and current reviewed knowledge. Provider calls are server-only and are never automatically retried.
3. `execution.finishModel` settles a verified usage receipt, releases the unused reservation, and rechecks membership, model access and the exact knowledge revisions. Only a still-authorized result becomes a task result and assistant message. A source change during generation can withhold the result while still recording known usage.
4. A task without delivery completes. A delivery task stores the exact recipient, subject and generated body in an immutable intent and pauses on a durable `delivery-approval-v1` event. No recipient or body is regenerated after approval.
5. Only the task owner can approve the displayed draft. Current context, workspace email permission, membership and deadlines are checked again. `integrations.sendIntent` also requires the deployment write switch and Resend configuration; its one-use claim is recorded before HTTP dispatch.
6. A successful provider receipt records `submitted` and the provider's ID. This means the provider accepted the email; it does not establish delivery. Independently signature-verified provider events supply delivery evidence.

Task states are `queued`, `running`, `awaiting_approval`, `succeeded`, `failed`, `canceled`, `timed_out` and `needs_reconciliation`. An uncertain model charge has no invented token count or zero-cost receipt. An uncertain email submission has no invented provider ID.

## Spending and capacity

Amounts are integer **USD microdollars**: 1,000,000 micros is $1. Defaults are $20 per user and $100 per workspace per UTC calendar month. Administrators can lower limits to zero, restrict the allowed server model IDs, and turn workspace email delivery on or off with `execution.updatePolicy`. Email delivery is off by default; enabling workspace policy alone does not enable deployment writes.

The reservation uses configured server model pricing, a conservative UTF-8 input bound, system/framing allowance, a fixed additional 16 KiB for personality and authorized knowledge, and a 4,096-token output ceiling. Per-task reserve must be at most $0.25. Unused allowance is released only after a known outcome. Reservations remain in their creation month's ledger, including a task that finishes after a month boundary. Provider price configuration must be maintained by the deployer; these are application controls, not a provider-enforced billing guarantee.

The component allows four concurrent workflow steps. Harbor separately allows three active tasks per owner and twenty per workspace; awaiting approvals count toward these limits. Tasks expire after one hour. Approval expires at the earlier of thirty minutes after draft creation or the task deadline.

## Cancellation, recovery and uncertain outcomes

Cancellation and timeout prevent future dispatches. They cannot recall a request already sent to a provider. If a model or email dispatch may have happened without a final receipt, Harbor marks the task `needs_reconciliation`. A model reservation remains held. An already settled model charge remains recorded even if subsequent email delivery is uncertain.

The component's durable journal resumes completed steps after normal worker restarts. Paid model and email actions use `retry: false`; the configured three-attempt exponential retry policy is available only for future explicitly opted-in, safe steps. `execution.recover` can create a fresh task only when the original **never claimed a model dispatch**, and permits at most two successive recoveries. It refuses ambiguous or already-dispatched tasks.

`execution.reconcile` is an administrator operation that records an independently checked provider outcome and evidence reference. It waits at least ten minutes after dispatch to allow in-flight action completion. It never resends an email, repeats a model call, or reconstructs lost output. Closing a lost model response requires a verified cost; the task remains failed even when that charge is known. Unknown charges must remain reserved until evidence resolves them. A confirmation of email submission requires its provider receipt ID. Operator attestations remain distinct from automatically verified webhook receipts.

There is no blanket “exactly once” claim for external systems. Harbor combines a durable dispatch barrier, stable Resend idempotency key, persisted intent and conservative reconciliation to avoid blind replay. Component cancellation does not undo a running action; see the [official cancellation semantics](https://github.com/get-convex/workflow#canceling-a-workflow).

## Routine triggers

Owners can create at most fifty routines. Each routine uses either an interval of 60–10,080 minutes or an event key. Interval scheduling persists the next due time, uses a revision to ignore old schedules after a pause/change, and prevents duplicate task creation for the same tick. A blocked run records `blocked` and leaves the next scheduled occurrence intact; it does not accumulate missed runs. An event call requires owner authentication and a caller-supplied bounded event ID; repeating that ID returns the original task.

Routine execution rechecks membership, model policy, capacity and both budgets on every run. This first path does not give routines outbound delivery capability. There is no public unauthenticated event webhook, arbitrary remote URL, shell execution, MCP execution or generic integration proxy.

## Data boundaries

Knowledge-derived results retain exact entity revision references through task results, assistant messages and email intents. Source retirement, grant revocation or expiry, entity correction and membership suspension are checked through the shared knowledge eligibility helper. A revoked context is withheld from owner task reads and cannot authorize a new email submission. This cannot withdraw an email already sent or data already processed by a provider.

Task prompts, generated results, email drafts and workflow step arguments contain user data. The Workflow component journal is also a data store, not merely telemetry. Harbor cleans completed workflow journals unless a workspace preservation hold applies. A scheduled expiry invalidates normal task reads; an hourly, paginated sweep handles retention changes and hold release. Expired task prompts/results, intent recipients/subjects/bodies, conversation messages and event details are removed while minimal IDs, spending balances, provider receipt IDs and outcome statuses remain. Holds preserve bytes and journals without restoring expired access. Lowering a retention policy can require the next hourly sweep to invalidate a previously cached subscription; a fresh query checks the current cutoff.

Deployers must apply the same access controls to component storage as application records. Usage receipts and automatic lifecycle events omit prompts, model responses and credentials; operator reconciliation may include a bounded evidence reference. Do not add content to routine logs, OTEL attributes or exception details.

This release's source connectors are interfaces and internal ingestion contracts. Google/Microsoft OAuth ingestion, a connection broker and remote MCP tools are not wired to this TypeScript runtime. Local fixtures must not be described as a live connected mailbox.

## Verification and deployment limits

`tests/execution.test.ts` runs the actual Workflow component with Convex's test harness, the real action/provider adapters and mocked Anthropic/Resend HTTP. It covers tenant/owner scope, both budget caps, policy and membership changes, generation and conversation persistence, disabled configuration, approval pause/resume and expiry, cancellation, uncertain outcomes without resending, scoped event deduplication, scheduled runs, knowledge revocation races, journal cleanup, payload retention and preservation holds. These tests make no paid model call and send no real email.

A real deployment still needs its configured OIDC issuer, Convex deployment and component installation, model credentials, maintained model catalog/pricing, and optional Resend sender/domain, key, webhook verification secret and explicit write enablement. Verify these against your own tenant before enabling employee access. The [Convex action limits](https://docs.convex.dev/production/state/limits) and [action execution semantics](https://docs.convex.dev/functions/actions) apply; durable orchestration does not turn an individual network call into an unlimited process.
