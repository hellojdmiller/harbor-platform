# Security

Harbor is a developer preview. Do not use it for sensitive production data until your organization has completed the readiness gates in docs/readiness.md.

Report a vulnerability privately through GitHub's private vulnerability reporting when enabled on this repository. Do not put credentials, message bodies, customer records, or a working exploit against another tenant into a public issue. If private reporting is unavailable, open a public issue containing only a request for a confidential reporting channel.

## Boundaries

Every public Convex function validates arguments and checks a verified identity and active workspace membership. Personal knowledge, tasks, files, and conversations also require the owning user. Administrator access does not grant blanket access to personal content. Internal actions recheck persisted authorization before provider dispatch.

Provider tokens are server secrets. Freeform preferences, retrieved text, and generated wiki prose are data, not authorization. External writes require deployment configuration, workspace policy, and a reviewed intent. A timeout after sending a provider request may have an unknown result and must not trigger a blind retry.

The Next.js demo has fictional data only. There is no development password or anonymous backend authorization bypass. The local Convex administrator key used by verification scripts must never be shipped to the browser or committed.

The initial release does not implement SCIM, entitlement billing, organization-wide eDiscovery, data residency policy enforcement, automatic source OAuth ingestion, or a complete retention purge engine. These are explicit release gates, not implied enterprise guarantees.
