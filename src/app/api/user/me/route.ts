import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { limitsForPlan } from "@/lib/plan-limits";
import { syncUsageWindow } from "@/lib/usage-limits";
import { classifyEntitlement } from "@/lib/entitlements";
import { checkMinuteQuota } from "@/lib/minute-limits";
import { managedKieLaunchOn } from "@/lib/kie-image-guards";
import { isHeroAiBetaUser, isInternalAiTester, resolveHeroAiImageAccess } from "@/lib/internal-ai-access";
import { resolveHeroScriptAccess } from "@/lib/hero-script-rollout.server";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { getStarterAiImageAllowanceStatus } from "@/lib/starter-ai-image-allowance.server";
import { shouldDefaultToRecommendedAutoMix } from "@/lib/automix-plan";
import { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import { resolveFirstClipPath, resolveFirstClipProgress } from "@/lib/first-clip-path.server";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        plan: true,
        usageCount: true,
        usageLimit: true,
        usagePeriodStartedAt: true,
        avatar: true,
        cancelAtPeriodEnd: true,
        cancelAt: true,
        trialStartedAt: true,
        trialEndsAt: true,
        subStatus: true,
        billingPeriod: true,
        planExpiresAt: true,
      } as any,
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const entitlement = classifyEntitlement(authUser);
    const limits = limitsForPlan((user as any).plan ?? "FREE");
    const usage = await syncUsageWindow(authUser.id);
    let minuteFields: { minuteQuota: true; minutesUsed: number; minutesLimit: number } | Record<string, never> = {};
    if (process.env.MINUTE_QUOTA === "1") {
      const mq = await checkMinuteQuota(authUser.id);
      minuteFields = {
        minuteQuota: true,
        minutesUsed: mq.used,
        minutesLimit: mq.used + mq.remaining,
      };
    }
    // Managed-kie launch state (both server flags on) — independent of plan/admin.
    // Task 7 badge: lets the client tell "not launched yet" (เร็ว ๆ นี้) apart from
    // "launched but not paid" (อัปเกรดเพื่อใช้ภาพ AI) for locked AI-image UI.
    const managedKieOn = managedKieLaunchOn();
    const internalAiTester = isInternalAiTester(authUser);
    const heroAiBeta = isHeroAiBetaUser(authUser);
    // Public-launch eligibility (Task 5 consumes this for the editor's Hero AI
    // Image UI): beta cohort OR HERO_AI_IMAGE_PUBLIC=1 + PRO/BUSINESS (active
    // trial included — see isHeroAiImageEligible's doc comment for why).
    const [paidEquivalent, heroAiImageAccess, heroScriptAccess, brandVisualAccess, starterAllowance, firstClipPath] = await Promise.all([
      resolvePaidEquivalentEntitlement(authUser.id),
      resolveHeroAiImageAccess(authUser),
      resolveHeroScriptAccess(authUser),
      resolveBrandVisualAccess(authUser),
      getStarterAiImageAllowanceStatus(authUser.id),
      resolveFirstClipPath({ id: authUser.id, email: authUser.email, role: authUser.role }),
    ]);
    // Day-one dashboard stepper (#305): only accounts still on the path need the
    // extra project-status read, so nobody else pays for it on this hot route.
    const firstClipProgress = firstClipPath.onPath
      ? await resolveFirstClipProgress(authUser.id)
      : null;
    const heroAiImageEligible = heroAiImageAccess.canUse;
    // Recovery and exact rerender remain available for already-pinned projects
    // when new Brand Visual admission is rolled back. Funding disclosure must
    // therefore be independent from the live cohort flag.
    // Managed-kie: is AI image generation un-gated for THIS user? True for paid
    // (PRO/BUSINESS) plans only when both flags are on. Admins always have access
    // (client mirrors already OR this with an isAdmin check), so this is the
    // paid-user signal specifically. Mirrors the server gate in fetch-stock.
    const kiePaidUnlocked = internalAiTester &&
      managedKieOn && ((user as any).plan === "PRO" || (user as any).plan === "BUSINESS");
    const recommendedAutoMixDefault = shouldDefaultToRecommendedAutoMix({
      effectivePlan: paidEquivalent.canUsePaidFeatures
        ? paidEquivalent.effectivePlan
        : entitlement.effectivePlan,
      heroAiImageEligible,
      brandVisualAllowed: brandVisualAccess.canUse,
    });

    return NextResponse.json({
      ...user,
      effectivePlan: paidEquivalent.canUsePaidFeatures ? paidEquivalent.effectivePlan : entitlement.effectivePlan,
      usageCount: usage?.usageCount ?? user.usageCount,
      usageLimit: usage?.usageLimit ?? limits.clips,
      usagePeriodStartedAt: usage?.usagePeriodStartedAt ?? (user as any).usagePeriodStartedAt,
      usageResetAt: usage?.resetAt ?? null,
      kiePaidUnlocked,
      recommendedAutoMixDefault,
      // Public users keep seeing the existing "เร็ว ๆ นี้" state even while the
      // managed provider is enabled for the internal beta.
      managedKieOn: internalAiTester && managedKieOn,
      internalAiTester,
      heroAiBeta,
      heroAiImageEligible,
      firstClipPath: firstClipPath.onPath,
      firstClipPathReason: firstClipPath.reason,
      firstClipProgress,
      heroScriptAllowed: heroScriptAccess.canUse,
      heroScriptPreview: heroScriptAccess.canPreview,
      heroScriptCohort: heroScriptAccess.cohort,
      brandVisualAllowed: brandVisualAccess.canUse,
      brandVisualCohort: brandVisualAccess.cohort,
      brandVisualRolloutBucket: brandVisualAccess.bucket,
      paidEquivalent: {
        ...paidEquivalent,
        expiresAt: paidEquivalent.expiresAt?.toISOString() ?? null,
      },
      featureAccess: {
        heroAiImage: heroAiImageAccess,
        heroAiScript: {
          mode: heroScriptAccess.mode,
          source: heroScriptAccess.entitlementSource,
          effectivePlan: heroScriptAccess.effectivePlan,
          reason: heroScriptAccess.reason,
          canUse: heroScriptAccess.canUse,
          canPreview: heroScriptAccess.canPreview,
        },
        brandVisual: {
          mode: brandVisualAccess.mode,
          source: brandVisualAccess.entitlementSource,
          reason: brandVisualAccess.reason,
          canUse: brandVisualAccess.canUse,
          rolloutBucket: brandVisualAccess.bucket,
        },
      },
      starterAiImageAllowance: starterAllowance ? {
        ...starterAllowance,
        windowStartedAt: starterAllowance.windowStartedAt.toISOString(),
        windowEndsAt: starterAllowance.windowEndsAt.toISOString(),
      } : null,
      ...minuteFields,
    }, {
      headers: {
        // This response carries plan, credits and rollout admission. A browser
        // must revalidate it after a deploy instead of retaining an older JSON
        // shape that can hide newly-enabled Editor capabilities.
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    return apiError({ route: "user/me", error });
  }
}
