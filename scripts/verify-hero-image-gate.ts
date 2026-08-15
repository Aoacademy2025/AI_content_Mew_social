// Subscription-first Hero AI Image policy verifier.
// Run: node --conditions=react-server --import tsx scripts/verify-hero-image-gate.ts

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "hero-image-gate-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { isHeroAiImageEligible } = await import("../src/lib/internal-ai-access");
  const { prisma } = await import("../src/lib/prisma");
  const { checkHeroImageRate, HERO_IMAGE_DAILY_CAP, HERO_IMAGE_HOURLY_CAP } = await import("../src/lib/hero-image-rate-limit");

  const actor = { id: "customer", email: "customer@example.com", role: "USER", plan: "BUSINESS" };
  const internal = { id: "admin", email: "admin@example.com", role: "ADMIN", plan: "FREE" };
  const paid = {
    canUsePaidFeatures: true, effectivePlan: "PRO" as const, source: "subscription" as const,
    expiresAt: new Date(Date.now() + 86_400_000), cashBacked: true, recurring: true, reason: "eligible" as const,
  };
  const noEvidence = {
    canUsePaidFeatures: false, effectivePlan: "FREE" as const, source: "none" as const,
    expiresAt: null, cashBacked: false, recurring: false, reason: "no_qualifying_evidence" as const,
  };
  const allowance = (eligible: boolean, remainingImages: number) => ({
    eligible, fundingSource: eligible ? "starter_allowance" as const : "credits" as const,
    windowStartedAt: new Date(), windowEndsAt: new Date(Date.now() + 86_400_000),
    limitImages: 8, reservedImages: 0, usedImages: 8 - remainingImages,
    remainingImages, accessMode: eligible ? "trial" as const : "locked" as const,
  });

  const prior = process.env.HERO_AI_IMAGE_PUBLIC;
  delete process.env.HERO_AI_IMAGE_PUBLIC;
  assert.equal(isHeroAiImageEligible(internal), true, "internal cohort bypasses public flag");
  assert.equal(isHeroAiImageEligible(actor, { paidEquivalent: paid, trialAllowance: allowance(false, 0) }), false, "flag off is fail-closed");
  process.env.HERO_AI_IMAGE_PUBLIC = "1";
  assert.equal(isHeroAiImageEligible(actor), false, "raw BUSINESS label without server evidence fails closed");
  assert.equal(isHeroAiImageEligible(actor, { paidEquivalent: paid, trialAllowance: allowance(false, 0) }), true, "paid-equivalent evidence qualifies");
  assert.equal(isHeroAiImageEligible({ ...actor, plan: "FREE" }, { paidEquivalent: noEvidence, trialAllowance: allowance(true, 1) }), true, "active Trial with remaining image qualifies");
  assert.equal(isHeroAiImageEligible({ ...actor, plan: "PRO" }, { paidEquivalent: noEvidence, trialAllowance: allowance(true, 0) }), false, "exhausted Trial fails closed despite raw PRO label");
  assert.equal(isHeroAiImageEligible({ ...actor, suspended: true }, { paidEquivalent: paid, trialAllowance: allowance(true, 8) }), false, "suspension wins over every source");
  if (prior === undefined) delete process.env.HERO_AI_IMAGE_PUBLIC;
  else process.env.HERO_AI_IMAGE_PUBLIC = prior;

  assert.equal(HERO_IMAGE_HOURLY_CAP, 20);
  assert.equal(HERO_IMAGE_DAILY_CAP, 120);
  const user = await prisma.user.create({ data: { name: "Gate", email: "gate@example.invalid" } });
  async function seed(count: number, minutesAgo: number, chargeState = "settled") {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    await Promise.all(Array.from({ length: count }, (_, index) => prisma.aiGenerationJob.create({
      data: { userId: user.id, kind: "image", provider: "runpod", model: `z-${index}`, chargeState, createdAt },
    })));
  }
  await seed(20, 10);
  const hourly = await checkHeroImageRate(user.id, 1);
  assert.equal(hourly.ok, false);
  assert.equal(hourly.ok ? null : hourly.scope, "hour");
  await prisma.aiGenerationJob.deleteMany({ where: { userId: user.id } });
  await seed(100, 90);
  const daily = await checkHeroImageRate(user.id, 21);
  assert.equal(daily.ok, false);
  assert.equal(daily.ok ? null : daily.scope, "day");
  assert.equal((await checkHeroImageRate(user.id, 20)).ok, true);
  assert.equal((await checkHeroImageRate(user.id, 500, { isAdmin: true })).ok, true, "Administrator rate bypass remains explicit");

  const fetchStock = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  const jobs = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  const reroll = readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
  const generator = readFileSync("src/lib/video-hero-image.server.ts", "utf8");
  assert.match(fetchStock, /resolveHeroAiImageAccess\(user\)/, "fetch-stock resolves canonical access");
  assert.match(jobs, /resolveHeroAiImageAccess\(user\)/, "VideoJob admission resolves canonical access");
  assert.match(generator, /resolveHeroAiImageAccess\(actor\)/, "shared generator re-checks canonical access before reservation");
  assert.match(generator, /mode === "trial" \? "conversion-trial" : "credits-only"/, "Trial uses the one-time allowance, paid cohorts use credits");
  assert.match(reroll, /productSurface: "scene_reroll"/, "scene reroll records a stable MAPC surface");
  assert.ok((fetchStock.match(/HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE\.body/g)?.length ?? 0) >= 2);
  assert.ok((jobs.match(/HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE\.body/g)?.length ?? 0) >= 2);
  assert.ok(fetchStock.indexOf("checkHeroImageRate(userId, clipsToGenerate)") < fetchStock.indexOf("const generated = await generateHeroImageForVideo({"));

  await prisma.$disconnect();
  console.log("verify-hero-image-gate: PASS evidence-only access + Trial cap + rate/order wiring");
}

main().catch((error) => { console.error(error); process.exit(1); });
