import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isHeroScriptAllowedUser } from "@/lib/hero-script-access";

// Internal-beta gate for /hero-script (post-review amendment, 2026-07-31):
// same server-side redirect pattern as the legacy admin-gated /style, /content
// routes (see their layout.tsx). Non-allowlisted users never see the page —
// they're bounced to /dashboard before any client code runs.
export default async function HeroScriptLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user || !isHeroScriptAllowedUser(user)) redirect("/dashboard");
  return <>{children}</>;
}
