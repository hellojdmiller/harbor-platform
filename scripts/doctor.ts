import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const required = [
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
];
let failed = false;
for (const key of required) {
  const ok = Boolean(process.env[key]);
  console.log(`${ok ? "PASS" : "MISSING"} ${key}`);
  if (!ok) failed = true;
}
const url = process.env.NEXT_PUBLIC_CONVEX_URL;
if (url) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
      throw new Error();
    console.log("PASS Backend URL uses HTTPS or local loopback");
  } catch {
    console.log("FAIL Backend URL must be HTTPS or local loopback");
    failed = true;
  }
}
console.log(
  "CHECK Convex deployment separately: OIDC_ISSUER, OIDC_AUDIENCE, HARBOR_BOOTSTRAP_SUBJECTS, ANTHROPIC_API_KEY",
);
console.log(
  "CHECK Production and preview use separate Convex deployments and identity instances",
);
console.log(
  "CHECK External writes remain disabled until a verified approval/delivery acceptance test passes",
);
if (failed) process.exitCode = 1;
