import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { resolveFirstClipPath } from "@/lib/first-clip-path.server";
import { BrandVisualLockedPreview } from "./_components/BrandVisualLockedPreview";

export default async function BrandsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect_url=/brands");
  const firstClip = await resolveFirstClipPath({ id: user.id, email: user.email, role: user.role });
  if (firstClip.onPath) redirect("/video-editor");
  const access = await resolveBrandVisualAccess(user);
  if (!access.canUse) {
    const lockedReason = access.reason === "eligible" ? "feature_off" : access.reason;
    return <BrandVisualLockedPreview reason={lockedReason} source={access.entitlementSource} />;
  }
  return <>{children}</>;
}
