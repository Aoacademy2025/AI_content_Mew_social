// Verifies task 6 of docs/plans/2026-08-07-hero-ai-image-p0-launch.md:
//   every NEW trial account gets a one-time 10-credit taste grant so trial users can
//   actually try Hero AI Image (3-5 images at 2cr each) without buying credits first.
//
// Run via: tsx scripts/verify-trial-taste-grant.ts
// (no react-server condition needed — trial.ts's import chain (credits.ts, prisma,
// plan-helpers, notifications, usage-limits, entitlements) has no "server-only" tags,
// unlike the image-provider modules verify-hero-image-price.ts has to route around.)
//
// DATABASE_URL is pointed at a throwaway temp SQLite file BEFORE any module that
// transitively imports src/lib/prisma.ts is loaded, so the cached PrismaClient
// singleton never touches the real dev.db.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "trial-taste-grant-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  // ensureMonthlyGrant / grantOnPaidActivation are both flag-gated on CREDITS_LIVE — flip
  // it on so this script actually exercises the interaction chain the task asks for.
  process.env.CREDITS_LIVE = "1";

  let failures = 0;
  function check(name: string, condition: boolean) {
    if (condition) console.log(`  PASS  ${name}`);
    else { failures += 1; console.error(`  FAIL  ${name}`); }
  }

  const { prisma } = await import("../src/lib/prisma");
  const { grantTrial, TRIAL_DAYS_PUBLIC } = await import("../src/lib/trial");
  const { getBalance, ensureMonthlyGrant, TRIAL_TASTE_CREDITS, grantCreditsOnce, MONTHLY_GRANT } =
    await import("../src/lib/credits");
  const { grantOnPaidActivation } = await import("../src/lib/entitlements");

  check("TRIAL_TASTE_CREDITS === 10", (TRIAL_TASTE_CREDITS as number) === 10);

  // ── 1. New trial → granted === 10 exactly, ledger row kind=grant with the taste ref. ──
  const trialUser = await prisma.user.create({
    data: { name: "Trial Taste Verify", email: "trial-taste-verify@example.invalid" },
  });

  const granted1 = await grantTrial(trialUser.id, TRIAL_DAYS_PUBLIC);
  check("grantTrial() returns true for a brand-new user", granted1 === true);

  const balanceAfterGrant = await getBalance(trialUser.id);
  check("balance.granted === 10 after a new trial", balanceAfterGrant.granted === 10);
  check("balance.purchased === 0 after a new trial", balanceAfterGrant.purchased === 0);

  const ref = `trial-taste:${trialUser.id}`;
  const ledgerRow = await prisma.creditLedger.findFirst({ where: { userId: trialUser.id, action: ref } });
  check("a ledger row exists with action === trial-taste:<userId>", ledgerRow !== null);
  check('ledger row kind === "grant"', ledgerRow?.kind === "grant");
  check("ledger row delta === 10", ledgerRow?.delta === 10);

  // ── 2. grantCreditsOnce with the same ref twice → second call is a no-op. ──
  const doubleGrant = await grantCreditsOnce(trialUser.id, TRIAL_TASTE_CREDITS, "grant", ref);
  check("grantCreditsOnce() with the same ref returns granted:false", doubleGrant.granted === false);
  const balanceAfterDouble = await getBalance(trialUser.id);
  check("balance.granted still === 10 after the duplicate-ref attempt", balanceAfterDouble.granted === 10);

  // Also: calling grantTrial() again for the same (now-trialing) user is a no-op end to
  // end (trialStartedAt is no longer null), so the taste credits can't be re-granted via
  // that path either.
  const grantedAgain = await grantTrial(trialUser.id, TRIAL_DAYS_PUBLIC);
  check("grantTrial() on an already-trialing user returns false", grantedAgain === false);
  const balanceAfterRetrial = await getBalance(trialUser.id);
  check("balance.granted still === 10 after a repeat grantTrial() call", balanceAfterRetrial.granted === 10);

  // ── 3. ensureMonthlyGrant during an ACTIVE trial must NOT wipe or reset the 10. ──
  await ensureMonthlyGrant(trialUser.id);
  const balanceAfterMonthlyGrant = await getBalance(trialUser.id);
  check(
    "balance.granted still === 10 after ensureMonthlyGrant() during an active trial",
    balanceAfterMonthlyGrant.granted === 10,
  );
  const userRow = await prisma.user.findUniqueOrThrow({ where: { id: trialUser.id } });
  check(
    "ensureMonthlyGrant() did not stamp grantedResetAt during an active trial (true early-return, no write)",
    (await prisma.creditBalance.findUniqueOrThrow({ where: { userId: trialUser.id } })).grantedResetAt === null,
  );
  check("user is still plan=PRO via the trial (unaffected by ensureMonthlyGrant)", userRow.plan === "PRO");

  // Spend a bit of the taste balance before conversion, so we can see conversion's exact
  // documented behavior: grantOnPaidActivation HARD-SETS `granted` via resetMonthlyGranted
  // (no `guard`), which OVERWRITES whatever is in the granted bucket with the plan's
  // monthly allowance — it does not add to unspent taste credits, and any unspent taste
  // credits are lost (only the granted bucket is overwritten; purchased is untouched).
  const { spendCredits } = await import("../src/lib/credits");
  const spend = await spendCredits(trialUser.id, 3, "verify-trial-taste-grant:test-spend");
  assert.equal(spend.ok, true, "expected the test spend of 3 taste credits to succeed");
  const balanceAfterSpend = await getBalance(trialUser.id);
  check("balance.granted === 7 after spending 3 of the 10 taste credits", balanceAfterSpend.granted === 7);

  // ── 4. Paid activation → balance per EXISTING semantics (assert the actual number). ──
  await grantOnPaidActivation(trialUser.id, "PRO");
  const balanceAfterActivation = await getBalance(trialUser.id);
  check(
    `balance.granted === ${MONTHLY_GRANT.PRO} after grantOnPaidActivation("PRO") ` +
      `(hard-set/overwrite, NOT additive — the 7 remaining unspent taste credits are replaced, not topped up)`,
    balanceAfterActivation.granted === MONTHLY_GRANT.PRO,
  );

  // ── 5. Expiry behavior, pinned: unspent granted credits are NOT touched by
  //      revertExpiredTrials (it only rewrites plan/planExpiresAt/trialEndsAt/usage-window
  //      fields, never CreditBalance) — the granted balance simply persists. Separately,
  //      once plan=FREE, MONTHLY_GRANT.FREE === 0 means ensureMonthlyGrant() will never
  //      reset it either (allowance<=0 early-return), so it persists indefinitely unless
  //      spent. It is FUNCTIONALLY inert on FREE because Hero AI Image is plan-gated to
  //      PRO/BUSINESS (incl. active trial) regardless of credit balance — see Task 4's
  //      isHeroAiImageEligible gate. This is pre-existing behavior; this task does not
  //      change it (out of scope per the plan). ──
  const expiryUser = await prisma.user.create({
    data: { name: "Trial Expiry Verify", email: "trial-expiry-verify@example.invalid" },
  });
  await grantTrial(expiryUser.id, TRIAL_DAYS_PUBLIC);
  const expiryBalanceBefore = await getBalance(expiryUser.id);
  check("expiry-test user has 10 taste credits before expiry", expiryBalanceBefore.granted === 10);

  // Force the trial into the past so revertExpiredTrials() picks it up.
  await prisma.user.update({
    where: { id: expiryUser.id },
    data: { trialEndsAt: new Date(Date.now() - 60_000) },
  });
  const { revertExpiredTrials } = await import("../src/lib/trial");
  const revertedCount = await revertExpiredTrials();
  check("revertExpiredTrials() reverted at least the expiry-test user", revertedCount >= 1);

  const expiredUserRow = await prisma.user.findUniqueOrThrow({ where: { id: expiryUser.id } });
  check("expired user's plan === FREE after revert", expiredUserRow.plan === "FREE");
  const expiryBalanceAfter = await getBalance(expiryUser.id);
  check(
    "expired user's balance.granted still === 10 (revertExpiredTrials never touches CreditBalance — pinned pre-existing behavior)",
    expiryBalanceAfter.granted === 10,
  );

  // ensureMonthlyGrant() on the now-FREE user must still be a no-op (allowance 0), so the
  // stranded 10 credits are never wiped by a later balance read either.
  await ensureMonthlyGrant(expiryUser.id);
  const expiryBalanceAfterMonthlyGrant = await getBalance(expiryUser.id);
  check(
    "expired FREE user's balance.granted still === 10 after ensureMonthlyGrant() (FREE allowance is 0 -> early-return, no reset)",
    expiryBalanceAfterMonthlyGrant.granted === 10,
  );

  // ── 6. A FREE (never-trial) user gets nothing from grantTrial's taste-grant path. ──
  const freeUser = await prisma.user.create({
    data: { name: "Never Trial Verify", email: "never-trial-verify@example.invalid" },
  });
  const freeBalance = await getBalance(freeUser.id);
  check("a never-trial FREE user has balance.granted === 0", freeBalance.granted === 0);
  const freeLedger = await prisma.creditLedger.findFirst({
    where: { userId: freeUser.id, action: `trial-taste:${freeUser.id}` },
  });
  check("no trial-taste ledger row exists for a never-trial user", freeLedger === null);

  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
