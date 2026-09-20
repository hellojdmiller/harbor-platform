import { Setup } from "@/components/setup";
import { LiveApp } from "@/components/live";
export default function Page() {
  return process.env.NEXT_PUBLIC_CONVEX_URL &&
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
    <LiveApp />
  ) : (
    <Setup />
  );
}
