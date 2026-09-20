export async function GET() {
  return Response.json(
    {
      service: "harbor-web",
      status: "ok",
      version: "0.1.0",
      backendConfigured: Boolean(process.env.NEXT_PUBLIC_CONVEX_URL),
      identityConfigured: Boolean(
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      ),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
