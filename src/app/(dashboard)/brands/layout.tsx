import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { decideBrandVisualAccess } from "@/lib/brand-visual-rollout.server";

export default async function BrandsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect_url=/brands");
  if (!decideBrandVisualAccess(user).canUse) redirect("/dashboard");
  return <>{children}</>;
}
