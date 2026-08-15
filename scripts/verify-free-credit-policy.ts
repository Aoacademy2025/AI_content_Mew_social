// Regression harness for the real support case: a FREE account bought credits but
// could not keep rendering because plan minutes and managed-AI meters were not
// settled as one coherent paid job.
//
// Run: npx tsx scripts/verify-free-credit-policy.ts

// Self-contained: uses a throwaway SQLite database and the real Prisma schema.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "free-credit-policy-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
process.env.MINUTE_QUOTA = "1";
execSync("npx prisma db push --skip-generate", {
  stdio: "ignore",
  env: process.env,
});

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`ok: ${message}`);
    return;
  }
  failed++;
  console.error(`FAIL: ${message}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { grantCredits, getBalance } = await import("../src/lib/credits");
  const { reserveMinutesOrCredits } = await import("../src/lib/minute-credits");
  const { syncUserEntitlement } = await import("../src/lib/entitlements");

  const now = new Date("2026-08-15T06:00:00.000Z");

  // Exact billing policy approved for FREE + purchased credits:
  // use the final included minute first, then charge only the one-minute overflow.
  const walletUser = await prisma.user.create({
    data: {
      id: "free-wallet-user",
      name: "Free Wallet",
      email: "free-wallet@example.test",
      plan: "FREE",
      usagePeriodStartedAt: now,
      minutesLimit: 5,
      minutesUsed: 4,
      usageLimit: 2,
      usageCount: 0,
    },
  });
  await grantCredits(walletUser.id, 200, "purchase", "pack:test-free-wallet");

  const reservation = await reserveMinutesOrCredits(walletUser.id, 2, {
    creditsLive: true,
    ref: "two-minute-stock-render",
  });
  const walletAfter = await prisma.user.findUniqueOrThrow({ where: { id: walletUser.id } });
  const balanceAfter = await getBalance(walletUser.id);

  check(reservation.allowed, "two-minute FREE render is allowed with one included minute + credits");
  check(
    walletAfter.minutesUsed === 5,
    "reservation consumes the one remaining included minute",
    `minutesUsed=${walletAfter.minutesUsed}`,
  );
  check(
    balanceAfter.purchased === 198,
    "reservation charges only one overflow minute at 2 credits/minute",
    `purchased=${balanceAfter.purchased}`,
  );

  // Exact stale-meter failure from the support account: a paid entitlement expires,
  // the user becomes FREE, but old AI-audio/text counters must not survive the
  // transition and immediately block the newly valid FREE workflow.
  const expiredUser = await prisma.user.create({
    data: {
      id: "expired-paid-user",
      name: "Expired Paid",
      email: "expired-paid@example.test",
      plan: "PRO",
      planExpiresAt: new Date(now.getTime() - 1_000),
      subStatus: null,
      usagePeriodStartedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000),
      usageLimit: 100,
      usageCount: 12,
      minutesLimit: 80,
      minutesUsed: 49,
      aiAudioMinutesUsed: 49.83,
      aiTextCallsUsed: 130,
    },
  });

  await syncUserEntitlement(expiredUser.id, now);
  const expiredAfter = await prisma.user.findUniqueOrThrow({ where: { id: expiredUser.id } });
  check(expiredAfter.plan === "FREE", "expired paid account transitions to FREE");
  check(expiredAfter.minutesUsed === 0, "plan transition resets render minutes");
  check(
    expiredAfter.aiAudioMinutesUsed === 0,
    "plan transition resets stale managed AI-audio usage",
    `aiAudioMinutesUsed=${expiredAfter.aiAudioMinutesUsed}`,
  );
  check(
    expiredAfter.aiTextCallsUsed === 0,
    "plan transition resets stale managed AI-text usage",
    `aiTextCallsUsed=${expiredAfter.aiTextCallsUsed}`,
  );

  await prisma.$disconnect();

  if (failed > 0) {
    console.error(`\n${failed} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} FREE-CREDIT POLICY CHECKS PASSED`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
