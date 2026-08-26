import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideFirstClipPath } from "../src/lib/first-clip-path";
import { decideFirstClipConvertPrompt } from "../src/lib/first-clip-convert";
import { MONTHLY_GRANT } from "../src/lib/credit-costs";
import { minutesPerMonthForPlan, storageDaysForPlan } from "../src/lib/plan-limits";

const dir = mkdtempSync(join(tmpdir(), "trial-first-clip-path-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  assert.equal(
    decideFirstClipPath({
      isInternal: false,
      paidEquivalent: false,
      conversionTrial: true,
      hasCompletedVideo: false,
    }).reason,
    "conversion_trial",
  );
  assert.equal(
    decideFirstClipPath({
      isInternal: false,
      paidEquivalent: true,
      conversionTrial: false,
      hasCompletedVideo: false,
    }).reason,
    "on_path",
    "GRANT/paid stay on the Paid-Equivalent rail",
  );

  const paywall = decideFirstClipConvertPrompt({
    isInternal: false,
    isRecurringPayer: false,
    isPaidEquivalent: false,
    hasCompletedVideo: true,
    dismissedAt: null,
    monthlyPriceThb: 599,
    benefits: {
      storageDays: storageDaysForPlan("PRO"),
      minutesPerMonth: minutesPerMonthForPlan("PRO"),
      monthlyCredits: MONTHLY_GRANT.PRO ?? 0,
    },
    founding: { active: true, remaining: 50, total: 100, percentOff: 50 },
  });
  assert.equal(paywall.show, true, "sample clip unlocks the same convert prompt as GRANT");

  const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  assert.match(jobsRoute, /firstClip\.reason === "conversion_trial"/, "trial first clip is a distinct jobs path");
  assert.match(jobsRoute, /requestedSource = "kie-image"/, "trial first clip spends Hero AI Image allowance");
  const heroLayout = readFileSync("src/app/(dashboard)/hero-script/layout.tsx", "utf8");
  assert.doesNotMatch(
    heroLayout,
    /resolveFirstClipPath|firstClip\.onPath/,
    "Conversion Trial can reach the Hero Script locked preview from First-Clip Path",
  );

  const { decideHeroScriptAccess } = await import("../src/lib/hero-script-rollout.server");
  const heroScript = decideHeroScriptAccess({
    internal: false,
    paidEquivalent: {
      canUsePaidFeatures: false,
      effectivePlan: "FREE",
      source: "none",
      expiresAt: null,
      cashBacked: false,
      recurring: false,
      reason: "no_qualifying_evidence",
    },
    flags: { paidEnabled: true, publicPreview: true, trialPercent: 100, freePercent: 100 },
  });
  assert.equal(heroScript.canUse, false, "Hero Script generate stays denied on Conversion Trial");
  assert.equal(heroScript.canPreview, true, "Hero Script locked preview stays visible on Conversion Trial");

  const { prisma } = await import("../src/lib/prisma");
  const { resolveFirstClipPath } = await import("../src/lib/first-clip-path.server");
  const {
    createReservedImageJob,
    failAndRefundAiJob,
  } = await import("../src/lib/ai-generation-jobs.server");
  const { getStarterAiImageAllowanceStatus } = await import("../src/lib/starter-ai-image-allowance.server");
  const now = new Date();
  const future = new Date(now.getTime() + 6 * 86_400_000);

  const trial = await prisma.user.create({
    data: {
      id: "trial-first-clip",
      name: "Trial",
      email: "trial-first-clip@example.invalid",
      role: "USER",
      plan: "PRO",
      trialStartedAt: now,
      trialEndsAt: future,
    },
  });
  await prisma.creditBalance.create({ data: { userId: trial.id, granted: 0, purchased: 0 } });

  const before = await resolveFirstClipPath({ id: trial.id, email: trial.email, role: trial.role });
  assert.equal(before.onPath, true);
  assert.equal(before.reason, "conversion_trial");

  const reserved = await createReservedImageJob({
    userId: trial.id,
    model: "z-image-turbo",
    inputPreview: "trial first clip",
    inputJson: "{}",
    creditCost: 2,
    quoteVersion: "verify-v1",
    costBudgetUsdMicros: 10_000,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "verify-endpoint",
    estimatedCostUsdMicros: 1_000,
    idempotencyKey: "trial-first-clip:scene:0",
    mediaExpiresAt: future,
    fundingPolicy: "conversion-trial",
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("trial image reserve failed");
  assert.equal(reserved.fundingSource, "starter_allowance");
  const afterReserve = await getStarterAiImageAllowanceStatus(trial.id);
  assert.equal(afterReserve.remainingImages, 7);
  assert.ok(afterReserve.remainingImages <= 8);

  await failAndRefundAiJob(trial.id, reserved.job.id, "VERIFY_FAIL", "provider failed");
  const restored = await getStarterAiImageAllowanceStatus(trial.id);
  assert.equal(restored.remainingImages, 8, "failed image restores the Conversion Trial allowance");

  await prisma.video.create({
    data: {
      userId: trial.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/trial-first.mp4",
    },
  });
  const afterClip = await resolveFirstClipPath({ id: trial.id, email: trial.email, role: trial.role });
  assert.equal(afterClip.onPath, false);
  assert.equal(afterClip.reason, "has_completed_video");

  const grantor = await prisma.user.create({
    data: { id: "grantor-269", name: "Grantor", email: "grantor-269@example.invalid", role: "USER", plan: "PRO" },
  });
  const grant = await prisma.user.create({
    data: { id: "grant-269", name: "Grant", email: "grant-269@example.invalid", role: "USER", plan: "PRO" },
  });
  await prisma.administratorGrant.create({
    data: {
      userId: grant.id,
      plan: "PRO",
      reason: "CLIP0819",
      startsAt: now,
      expiresAt: future,
      grantedById: grantor.id,
    },
  });
  const grantPath = await resolveFirstClipPath({ id: grant.id, email: grant.email, role: grant.role });
  assert.equal(grantPath.reason, "on_path", "GRANT accounts stay on the Paid-Equivalent rail");

  await prisma.$disconnect();
  console.log("verify-trial-first-clip-path: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
