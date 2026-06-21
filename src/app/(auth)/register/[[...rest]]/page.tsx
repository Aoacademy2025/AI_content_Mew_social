import { SignUp } from "@clerk/nextjs";
import { getFoundingCoupon } from "@/lib/founding";
import { AuthShell, CLERK_APPEARANCE } from "@/components/marketing/auth-shell";

// Cache the founding-seat count for 60s (cheap, slightly-stale is fine).
export const revalidate = 60;

async function getFounding() {
  try {
    const c = await getFoundingCoupon();
    if (!c || c.maxUses <= 0) return null;
    const remaining = Math.max(0, c.maxUses - c.usedCount);
    return { active: remaining > 0, remaining, total: c.maxUses };
  } catch {
    return null;
  }
}

export default async function RegisterPage() {
  const founding = await getFounding();
  return (
    <AuthShell mode="register" founding={founding}>
      <SignUp forceRedirectUrl="/dashboard" appearance={CLERK_APPEARANCE} />
    </AuthShell>
  );
}
