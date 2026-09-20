# Deploy Harbor for IT

## Services and ownership

| Service                | Required                          | Purpose                                           | Where credentials live                          |
| ---------------------- | --------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Vercel                 | Yes for supported hosting         | Next.js web application                           | Vercel project environment                      |
| Convex                 | Yes                               | Database, files, subscriptions, actions, Workflow | Deployment settings and scoped deploy key       |
| OIDC identity provider | Yes for real workspaces           | Authentication and account recovery               | Identity service; issuer/audience in Convex     |
| Clerk                  | Reference frontend implementation | Sign-in UI and token refresh                      | Publishable frontend key; secret only on Vercel |
| Anthropic              | Yes for assistant generation      | General text assistance                           | Convex ANTHROPIC_API_KEY                        |
| Resend                 | Optional                          | Approved email submission and signed receipts     | Convex secrets and verified sender domain       |
| OTLP collector         | Optional                          | Redacted web traces                               | Vercel server environment                       |

The backend stores issuer + subject identity, not a Clerk-specific account ID. Adopting another OIDC provider requires replacing the React token adapter and configuring the verified JWT issuer/audience; it does not mean arbitrary OAuth access tokens are accepted. Email/calendar OAuth grants and user sign-in are separate authorization concerns.

## Development

1. Install Node.js 22+ and run `npm ci`.
2. Copy `.env.example` to `.env.local` and run `npm run dev:backend`. Choose a development Convex deployment. Keep this process running while developing.
3. Create a Clerk development application. Create the **Convex JWT template**, keeping its audience `convex`. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` locally.
4. On the Convex development deployment set `OIDC_ISSUER` to the issuer shown in the template and `OIDC_AUDIENCE=convex`. Do not append a slash unless it is part of the actual issuer.
5. Set `ANTHROPIC_API_KEY` in **Convex**, not in a public browser variable. Model catalog configuration is documented in providers-integrations.md.
6. Set `HARBOR_BOOTSTRAP_SUBJECTS` on Convex to a JSON array of explicitly authorized operator subjects from your configured OIDC issuer. New owners are denied by default. Keep `HARBOR_ALLOW_SELF_SERVICE_WORKSPACES` unset in production. Run `npm run doctor`, `npm run dev`, then sign in as an allowed operator. First sign-in creates an owner and personal assistant. In Administration, provision other people by exact identity-provider subject; their next sign-in creates the assigned membership and assistant. Invitations, SSO domain policy and SCIM remain later gates.
7. In Administration, review allowed models, personal/workspace monthly limits, and whether approved email is permitted.

For a no-account developer backend, the current Convex CLI supports `CONVEX_AGENT_MODE=anonymous npx convex dev`. This is a local development backend, not a deployment strategy. It still needs a valid issuer configured for browser sign-in. The backend administrator credential must stay in `.convex/` and never enter the app.

## Vercel production

1. Fork this public repository into the organization that will operate it.
2. Create a **production Convex deployment** in the required region and a separate production identity application. Configure a custom application domain for Clerk production.
3. Configure Convex production secrets: `OIDC_ISSUER`, `OIDC_AUDIENCE`, `HARBOR_BOOTSTRAP_SUBJECTS`, `ANTHROPIC_API_KEY`, and optional Resend configuration. The backend rejects protected requests until identity is configured.
4. Generate a scoped Convex production deploy key. Import the repo in Vercel and set `CONVEX_DEPLOY_KEY` for **Production only**, plus the production Clerk keys. The key needs deployment permission; keep operational export/admin credentials separately scoped.
5. Vercel uses the checked-in build command:

   `convex deploy --cmd 'npm run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL`

   The CLI provides the correct backend URL during the Next build. Do not point a production frontend at a development deployment.

6. Use a **separate preview deploy key** for Vercel Preview. Use development identity credentials and test-only provider credentials on previews. Keep `ENABLE_EXTERNAL_WRITES` unset there.
7. Complete the acceptance checklist in readiness.md. The import/deploy button alone is not a completed enterprise rollout.

## Optional email

Set `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` and, after validation, `ENABLE_EXTERNAL_WRITES=true` on Convex. Verify the sending domain with Resend. Register `https://<your-deployment>.convex.site/webhooks/resend` for signed events. Workspace policy defaults to no email; the exact destination, subject, and generated body need an owner approval before execution.

An accepted provider request is **submitted**, not delivered. Check the signed receipt. Inbound event verification exists; inbound-body retrieval, account-to-user routing, and assistant invocation are not implemented.

## Configuration checks

`npm run doctor` reports configuration presence without printing secrets. `/api/health` reports web process health and configuration presence only; it is not a provider or authentication health probe.

Before an upgrade, run `npm ci`, `npm run check`, `npm run test:browser`, and the target environment acceptance checks. Keep the lockfile committed. Review identity recovery settings, MFA, production access, secret rotation and account ownership within the identity/Vercel/Convex control planes.

References verified 2026-09-20: [Convex + Vercel](https://docs.convex.dev/production/hosting/vercel), [Convex + Clerk](https://docs.convex.dev/auth/clerk), [Clerk environments](https://clerk.com/docs/guides/development/managing-environments).
