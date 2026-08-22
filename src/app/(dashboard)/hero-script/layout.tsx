import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { resolveHeroScriptAccess } from "@/lib/hero-script-rollout.server";
import { resolveFirstClipPath } from "@/lib/first-clip-path.server";
import { HeroScriptLockedPreview } from "./_components/HeroScriptLockedPreview";

// Server-side rollout gate: internal and enabled cohorts get the product;
// everyone else either gets the public locked preview or is redirected when
// preview itself is disabled. API routes independently enforce the same gate.
export default async function HeroScriptLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect_url=/hero-script");
  const firstClip = await resolveFirstClipPath({ id: user.id, email: user.email, role: user.role });
  if (firstClip.onPath) redirect("/video-editor");
  const access = await resolveHeroScriptAccess(user);
  if (!access.canUse) {
    if (access.canPreview) {
      return <HeroScriptLockedPreview
        entitlementSource={access.entitlementSource}
        isTrial={Boolean(user.trialEndsAt && user.trialEndsAt > new Date())}
      />;
    }
    redirect("/dashboard");
  }
  return <>{children}</>;
}
