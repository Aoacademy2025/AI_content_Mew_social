import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY21_CONVERT_TITLE } from "../src/lib/day21-convert-reminder";

const dir = mkdtempSync(join(tmpdir(), "day21-convert-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const cron = readFileSync("src/app/api/cron/renewal-reminders/route.ts", "utf8");
  assert.match(cron, /sendDueDay21ConvertReminders/, "existing renewal-reminders cron sends day-21 convert");

  const { prisma } = await import("../src/lib/prisma");
  const { sendDueDay21ConvertReminders } = await import("../src/lib/day21-convert-reminder.server");

  const now = new Date("2026-09-09T09:00:00+07:00");
  const started = new Date("2026-08-19T12:00:00+07:00");
  const expires = new Date("2026-09-18T12:00:00+07:00");

  const grantor = await prisma.user.create({
    data: { id: "grantor-d21", name: "Grantor", email: "grantor-d21@example.invalid", role: "USER", plan: "PRO" },
  });
  const grantUser = await prisma.user.create({
    data: {
      id: "clip-d21",
      name: "Clip",
      email: "clip-d21@example.invalid",
      role: "USER",
      plan: "PRO",
    },
  });
  const coupon = await prisma.coupon.create({
    data: {
      code: "CLIP0819-D21",
      plan: "PRO",
      durationDays: 30,
      maxUses: 100,
      type: "GRANT",
    },
  });
  await prisma.couponRedemption.create({
    data: {
      couponId: coupon.id,
      userId: grantUser.id,
      outcome: "ACTIVATED",
      entitlementPlan: "PRO",
      entitlementStartsAt: started,
      entitlementExpiresAt: expires,
    },
  });

  const recurring = await prisma.user.create({
    data: {
      id: "sub-d21",
      name: "Sub",
      email: "sub-d21@example.invalid",
      role: "USER",
      plan: "PRO",
      stripeSubscriptionId: "sub_live",
      subStatus: "active",
      billingPeriod: "monthly",
      planExpiresAt: expires,
    },
  });
  await prisma.payment.create({
    data: {
      userId: recurring.id,
      stripeSessionId: "cs_d21",
      plan: "PRO",
      amount: 59900,
      status: "PAID",
      periodDays: 30,
      paidAt: started,
    },
  });
  await prisma.couponRedemption.create({
    data: {
      couponId: coupon.id,
      userId: recurring.id,
      outcome: "ACTIVATED",
      entitlementPlan: "PRO",
      entitlementStartsAt: started,
      entitlementExpiresAt: expires,
    },
  });

  const adminGrantUser = await prisma.user.create({
    data: { id: "admin-grant-d21", name: "AdminGrant", email: "admin-grant-d21@example.invalid", role: "USER", plan: "PRO" },
  });
  await prisma.administratorGrant.create({
    data: {
      userId: adminGrantUser.id,
      plan: "PRO",
      reason: "campaign",
      startsAt: started,
      expiresAt: expires,
      grantedById: grantor.id,
    },
  });

  const first = await sendDueDay21ConvertReminders(now);
  assert.equal(first.sent, 2, "GRANT coupon + administrator grant are reminded");
  const titles = await prisma.notification.findMany({
    where: { title: DAY21_CONVERT_TITLE },
    select: { userId: true },
  });
  assert.equal(titles.some((row) => row.userId === grantUser.id), true);
  assert.equal(titles.some((row) => row.userId === adminGrantUser.id), true);
  assert.equal(titles.some((row) => row.userId === recurring.id), false);

  const second = await sendDueDay21ConvertReminders(now);
  assert.equal(second.sent, 0, "same-day retry is idempotent");
  assert.equal(await prisma.notification.count({ where: { title: DAY21_CONVERT_TITLE } }), 2);

  await prisma.$disconnect();
  console.log("verify-day21-convert-reminder-server: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
