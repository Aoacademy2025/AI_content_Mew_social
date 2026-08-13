import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "subscription-north-star-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getSubscriptionNorthStar, writeSubscriptionNorthStarSnapshot, bangkokSnapshotDate } = await import("../src/lib/subscription-north-star.server");
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 86_400_000);

  async function user(id: string, data: Record<string, unknown> = {}) {
    return prisma.user.create({ data: { id, name: id, email: `${id}@example.invalid`, ...data } });
  }
  async function payment(userId: string, plan: "PRO" | "BUSINESS" = "PRO") {
    return prisma.payment.create({ data: {
      userId, stripeSessionId: `cs_${userId}`, plan, amount: 9900,
      status: "PAID", periodDays: 30, paidAt: now,
    } });
  }

  const monthly = await user("monthly", { plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_monthly", billingPeriod: "monthly", planExpiresAt: future });
  await payment(monthly.id);
  await prisma.video.create({ data: {
    userId: monthly.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 1,
    status: "COMPLETED", videoUrl: "/outputs/monthly.mp4",
  } });

  const annual = await user("annual", { plan: "BUSINESS", subStatus: "active", stripeSubscriptionId: "sub_annual", billingPeriod: "annual", planExpiresAt: future });
  await payment(annual.id, "BUSINESS");
  await prisma.script.create({ data: { userId: annual.id, topic: "Saved", hookText: "Hook", bodyText: "Body", ctaText: "CTA" } });
  await prisma.aiGenerationJob.create({ data: {
    userId: annual.id, kind: "image", provider: "runpod", model: "z-image-turbo",
    status: "completed", outputUrl: "/outputs/annual.png", chargeState: "settled",
    productSurface: "hero_video", finishedAt: now,
  } });

  const inactive = await user("inactive", { plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_no_cash", billingPeriod: "monthly", planExpiresAt: future });
  await prisma.video.create({ data: { userId: inactive.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 1, status: "COMPLETED", videoUrl: "/outputs/no-cash.mp4" } });

  const team = await user("team", { email: "team@aoacademy.co", role: "ADMIN", plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_team", billingPeriod: "monthly", planExpiresAt: future });
  await payment(team.id);
  await prisma.script.create({ data: { userId: team.id, topic: "Internal", hookText: "Hook", bodyText: "Body", ctaText: "CTA" } });

  const trial = await user("trial", { plan: "PRO", trialStartedAt: now, trialEndsAt: future });
  await prisma.script.create({ data: { userId: trial.id, topic: "Trial", hookText: "Hook", bodyText: "Body", ctaText: "CTA" } });

  const bundle = await user("bundle", {
    bundleSubscriptionId: "bundle_sub", bundleStatus: "ACTIVE", bundleBillingPeriod: "annual",
    bundleAccessExpiresAt: future, bundleAmountThb: 7900,
  });
  await prisma.aiGenerationJob.create({ data: {
    userId: bundle.id, kind: "image", provider: "runpod", model: "z-image-turbo",
    status: "completed", outputUrl: "/outputs/bundle.png", chargeState: "settled",
    productSurface: "automix", finishedAt: now,
  } });

  const metric = await getSubscriptionNorthStar(now);
  assert.equal(metric.activeRecurringPayers, 3, "cash-backed monthly, annual, and recurring Bundle form the denominator");
  assert.equal(metric.activeCreators, 3, "all three delivered a durable core outcome");
  assert.equal(metric.monthlyCreators, 1);
  assert.equal(metric.annualCreators, 2);
  assert.equal(metric.outcomes.videoCreators, 1);
  assert.equal(metric.outcomes.scriptCreators, 1);
  assert.equal(metric.outcomes.imageCreators, 2);
  assert.equal(metric.creatorRatePct, 100);

  const snapshot = await writeSubscriptionNorthStarSnapshot(now);
  assert.equal(snapshot.snapshotDate, bangkokSnapshotDate(now));
  assert.equal(await prisma.northStarDailySnapshot.count(), 1);
  await writeSubscriptionNorthStarSnapshot(new Date(now.getTime() + 60_000));
  assert.equal(await prisma.northStarDailySnapshot.count(), 1, "same Bangkok day updates idempotently");
  const row = await prisma.northStarDailySnapshot.findFirstOrThrow();
  assert.deepEqual(Object.keys(row).sort(), [
    "activeCreators", "activeRecurringPayers", "annualCreators", "asOf", "createdAt", "id",
    "imageCreators", "monthlyCreators", "scriptCreators", "snapshotDate", "videoCreators",
  ].sort(), "snapshot is counts-only and contains no customer identifiers or content");

  await prisma.$disconnect();
  console.log("verify-subscription-north-star: PASS recurring cash denominator + durable outcomes + counts-only snapshot");
}

main().catch((error) => { console.error(error); process.exit(1); });
