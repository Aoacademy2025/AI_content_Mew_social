import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "first-clip-convert-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getFirstClipConvertPrompt } = await import("../src/lib/first-clip-convert.server");
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 86_400_000);

  await prisma.coupon.create({
    data: {
      code: "FOUNDING100",
      type: "DISCOUNT",
      plan: "PRO",
      percentOff: 50,
      isActive: true,
      maxUses: 100,
      usedCount: 12,
      stripePromotionCodeId: "promo_founding",
    },
  });

  const grant = await prisma.user.create({
    data: {
      id: "grant-user",
      name: "Grant",
      email: "grant@example.invalid",
      plan: "PRO",
      planExpiresAt: future,
    },
  });
  const noClip = await getFirstClipConvertPrompt(grant.id, now);
  assert.equal(noClip.show, false);
  if (!noClip.show) assert.equal(noClip.reason, "no_completed_video");

  await prisma.video.create({
    data: {
      userId: grant.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/grant.mp4",
    },
  });
  const grantShown = await getFirstClipConvertPrompt(grant.id, now);
  assert.equal(grantShown.show, true);
  if (grantShown.show) {
    assert.equal(grantShown.monthlyPriceThb, 599);
    assert.equal(grantShown.founding?.annualPriceThb, 2995);
    assert.equal(grantShown.annualListThb, 5990);
  }

  const payer = await prisma.user.create({
    data: {
      id: "payer-user",
      name: "Payer",
      email: "payer@example.invalid",
      plan: "PRO",
      subStatus: "active",
      stripeSubscriptionId: "sub_payer",
      billingPeriod: "monthly",
      planExpiresAt: future,
    },
  });
  await prisma.payment.create({
    data: {
      userId: payer.id,
      stripeSessionId: "cs_payer",
      plan: "PRO",
      amount: 59900,
      status: "PAID",
      periodDays: 30,
      paidAt: now,
    },
  });
  await prisma.video.create({
    data: {
      userId: payer.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/payer.mp4",
    },
  });
  const payerHidden = await getFirstClipConvertPrompt(payer.id, now);
  assert.equal(payerHidden.show, false);
  if (!payerHidden.show) assert.equal(payerHidden.reason, "recurring_payer");

  const admin = await prisma.user.create({
    data: {
      id: "admin-user",
      name: "Admin",
      email: "qa@aoacademy.co",
      role: "ADMIN",
      plan: "PRO",
    },
  });
  await prisma.video.create({
    data: {
      userId: admin.id,
      avatarModel: "none",
      voiceModel: "gemini",
      sceneCount: 1,
      status: "COMPLETED",
      videoUrl: "/renders/admin.mp4",
    },
  });
  const adminHidden = await getFirstClipConvertPrompt(admin.id, now);
  assert.equal(adminHidden.show, false);
  if (!adminHidden.show) assert.equal(adminHidden.reason, "internal");

  await prisma.$disconnect();
  console.log("verify-first-clip-convert-server: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
