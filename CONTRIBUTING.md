# Contributing

Use Node 22+, npm ci, and npm run check. Run npm run test:browser after building for interface changes. Commit the lockfile and Convex generated types. Never commit environment files, local Convex state, backups, credentials, or real user examples.

Use queries for reads, mutations for transactional state, actions for external calls, and verified HTTP actions for provider events. Keep source provenance and active permissions attached to derived records. A test must distinguish provider submission from verified delivery and an uncertain result from a confirmed failure.

Propose infrastructure additions with a demonstrated need and update the readiness matrix when behavior changes. Include validation evidence and remaining limitations in pull requests.
