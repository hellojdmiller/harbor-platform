import type { AuthConfig } from "convex/server";
// A missing issuer does not create a development bypass: all protected functions deny anonymous callers.
export default {
  providers: process.env.OIDC_ISSUER
    ? [
        {
          domain: process.env.OIDC_ISSUER,
          applicationID: process.env.OIDC_AUDIENCE ?? "convex",
        },
      ]
    : [],
} satisfies AuthConfig;
