# Personal knowledge and wiki

Harbor stores an owner's reviewable knowledge separately from editable wiki prose. The current release implements verified identity, private workspace ownership, source provenance, review, corrections, text search, a relationship graph, wiki pages, and small private files. It does not train or fine-tune a model on personal data.

## Identity and authorization

Convex validates the JWT against the configured OIDC provider. `requireIdentity` uses `ctx.auth.getUserIdentity()`; user records bind `tokenIdentifier`, issuer, and subject. Public functions derive the current owner from this verified identity. They never accept an owner ID from the browser to choose whose private content to read.

An active user, workspace, and membership are required for every personal read or mutation. Workspace owner and administrator roles do not bypass another user's personal-data boundary. Backend-only entry points such as source import and task context take explicit owner IDs and independently recheck that owner's active membership. These internal functions must only be called by trusted server workflows that have already bound the work to its owner.

New workspace ownership is denied by default. Before the first sign-in, the deployment operator must set `OIDC_ISSUER` and `HARBOR_BOOTSTRAP_SUBJECTS` to a JSON array of exact OIDC subjects allowed to bootstrap ownership, for example `["user_operator_subject"]`. The issuer must match the verified identity exactly. Malformed or empty allowlists grant no access. Existing active memberships continue to work after an operator is removed from the allowlist.

`HARBOR_ALLOW_SELF_SERVICE_WORKSPACES=true` explicitly permits initial self-service workspace creation for local development. Keep it unset or `false` in production: each self-created workspace has its own spending pool backed by deployment provider credentials. This flag does not grant permission to create additional workspaces; `workspaces.create` always requires a configured bootstrap operator and retains its ten-workspace cap.

If a user's earliest membership is suspended, bootstrap selects another active workspace. If none remain active, it does not create a replacement workspace implicitly.

## Manual enterprise provisioning

A signed-in workspace owner can call `provisioning.assign({workspaceId, issuer, subject, role})` with `role` set to `member` or `admin`. Subjects are the exact stable identity-provider identifiers, not email addresses or user-controlled display names. The issuer must match the configured OIDC issuer. Administrators and members cannot issue admissions.

On the next `workspaces.bootstrap`, an exact issuer-and-subject match consumes the pending admission transactionally, creates an active membership, and persists a personal Piper agent with the default interaction settings. Repeated assignment/bootstrap does not duplicate membership, agents, or audit events. Existing users can acquire an explicitly provisioned additional membership without gaining permission to create workspaces.

`provisioning.list({workspaceId})` exposes admission state to the workspace owner. `provisioning.revoke({admissionId, expectedRevision})` revokes an unused admission with an optimistic revision check. A consumed admission cannot be used to change roles or restore a suspended membership; use the separate administrator controls for those changes. A revoked unused admission can be explicitly reissued by the owner. Assignment, consumption, revocation, and workspace creation produce audit records without copying identity values into audit metadata.

Admission processing is bounded to twenty pending matches per bootstrap and five hundred admission records per workspace. There is no open self-registration, domain auto-join, SCIM synchronization, invitation email, or onboarding UI implied by this API.

## Facts, evidence, and relationships

An entity is a person, company (the organization type), project, preference, goal, decision, note, account, identity, event, commitment, or instruction. These are data categories; marking an entity as an instruction does not grant it a higher priority than platform policy. Owners can directly enter manual entities. An entity derived from a source starts as a draft and includes an exact quote from the referenced source. The owner approves it before it appears in the wiki graph or agent context. This is provenance and review, not a guarantee that a proposed claim is true.

Corrections require the current entity revision and retain the original source references. An optimistic revision check rejects an edit based on stale data. Correction records contain the affected entity/revisions, reason, and time. They do not retain a full prior version of the text.

Relationships have their own proposed/accepted/dismissed state and preserve both endpoints' source references. A possible identity match requires owner review against both current entity revisions. Confirming a match adds a `same_as` relationship; it does not silently merge or delete either record.

## Source grants and current eligibility

Manual sources are explicitly entered by the owner. The internal connector import contract binds each snapshot to the workspace, owner, provider account, source key/version, and grant revision. It is scaffolding for a trusted ingestion worker: this release does **not** implement Gmail, Outlook, calendar, or Slack ingestion, an OAuth broker, automatic extraction, or continuous reconciliation.

Before any connector source or dependent fact is served, Harbor requires:

- The exact source revision is still active and within retention.
- The source and grant belong to the requested workspace and owner.
- The grant is active and its revision matches the imported source.
- The last verification lease remains current. A lease may last at most five minutes.

A scheduled metadata mutation invalidates reactive query caches at lease expiry, while revision and deadline checks prevent old jobs from invalidating a renewed lease. An adapter must refresh that lease only after verifying the authoritative grant. During an outage, it must let the lease expire; it must never interpret an unavailable provider as an empty successful catalog or issue a fresh lease from cached authority. A revoked or paused grant needs a new revision before reactivation. Old imports cannot become eligible merely because a new grant was created.

Identical repeated imports reuse the source ID without extending its retention. Changed source content retires the old revision; dependent facts then stop being served. Source retirement is permitted during a preservation hold because it changes eligibility while retaining the stored content.

## Search and model context

Convex text search applies workspace, owner, and active-state filters inside the search index. Each result then passes current provenance and retention checks before being returned. There is no semantic embedding index or vector search in this release.

`internal.knowledge.contextForRun` supplies at most twelve whole approved/manual facts and 12,000 characters of titles and summaries. Its output includes entity IDs/revisions and source references. Editable wiki prose is not included. The model integration must treat this context as data rather than instructions, record the selected entity references with derived output, and validate them after external calls and again when serving or dispatching that output.

The shared `runContextVisible` helper and `internal.knowledge.validateContext` recheck exact entity revisions and transitive source grants. A revoked source, expired lease, correction, or membership suspension makes old derived output unavailable through guarded paths. These checks cannot recall data already delivered to an external model or recipient; provider retention is a separate deployment decision.

No automatic extraction/consolidation jobs, confidence calibration, entity resolution model, or model learning loop are implemented. The review and provenance APIs are a foundation for that future worker, not evidence that one is running.

## Editable wiki

`knowledge.pages` returns private eligible pages. `createPage` can project up to twelve approved entities into a page or create an owner-authored page. `savePage` uses an expected page revision and changes only its body.

Pages retain their source references and supporting entity revisions even after edits. A page becomes unavailable if that evidence is retired, expires, loses authorization, or a supporting fact changes. The owner can create a fresh page from the corrected facts. Editing narrative never silently rewrites a fact or creates a new agent memory.

## Files

The current file API supports text, Markdown, PDF, PNG, and JPEG files up to 256 KB. An authenticated action creates a private reservation, stores the blob server-side, and binds it through an internal mutation after checking size and available MIME metadata. No public mutation accepts a caller-supplied storage ID.

Downloads use an authenticated action that rechecks ownership and retention before and after reading the blob. It returns bytes as base64, not a reusable public storage URL. MIME declarations are not malware scanning or content extraction. Uploaded files do not automatically become knowledge sources or model context.

## Retention and preservation limits

Workspace retention applies as a serving cutoff to sources, entities, wiki pages, and files, including retroactive shortening of the workspace duration. Derived entities/pages cannot outlive their source expiry. A preservation hold blocks replacing entity/page content and deleting files; it preserves content but does not make expired or unauthorized content visible.

Creation schedules a bounded metadata invalidation at each source, entity, wiki page, and file deadline. The job verifies the original expiry before marking eligibility expired; it preserves all content, including under a hold. Corrections and page edits retain the original deadline. These writes make reactive subscriptions rerun when retention expires; dispatch mutations also recheck current source eligibility. Scheduling is durable but not a hard real-time guarantee during backend outages. A future retention-policy editing API must reschedule existing deadlines when shortening a policy; directly editing workspace rows in the dashboard is not that lifecycle API.

This module does not yet implement scheduled physical deletion, complete personal export/erasure, configurable retention per source type, recovery/version history, or legal-hold administration beyond the workspace flag. Expired and retired rows remain stored until such lifecycle operations are added. Do not represent the serving cutoff as completed physical deletion or compliance certification. Other platform tables, including task history and integration receipts, have their own documented lifecycle.

## Validation

`npm test -- tests/knowledge.test.ts` covers anonymous and cross-issuer access, cross-workspace references, admin isolation, suspended memberships, exact evidence, grant expiry/revocation, changed snapshots, duplicate import retention, corrections and stale review, wiki provenance, durable output eligibility, holds, and authenticated file ownership. Tests use fictional users and content through `convex-test`.

Relevant official implementation references:

- [Convex authentication interface](https://docs.convex.dev/api/interfaces/server.Auth)
- [Convex text search and index filters](https://docs.convex.dev/search/text-search)
- [Convex file storage from actions](https://docs.convex.dev/file-storage/store-files)
- [Convex backend testing](https://docs.convex.dev/testing/convex-test)
