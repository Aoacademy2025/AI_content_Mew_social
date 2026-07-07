// Proof of the trial lifecycle. Run against a throwaway SQLite DB with an ABSOLUTE path
// (Prisma CLI resolves relative file: paths vs the schema dir; runtime vs cwd — they must agree):
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-trial.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-trial.db?connection_limit=1" npx tsx scripts/verify-trial.ts
import { prisma } from "../src/lib/prisma";
import { grantTrial, revertExpiredTrials, trialStatus, hashTrialEmail, TRIAL_DAYS_PUBLIC } from "../src/lib/trial";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

let n = 0;
async function mkUser(over: Record<string, unknown> = {}) {
  n++;
  return prisma.user.create({ data: { name: "u" + n, email: `u${n}@t.test`, ...over } });
}

async function main() {
  await prisma.user.deleteMany();
  await prisma.usedTrialEmail.deleteMany();

  // grant
  const a = await mkUser();
  assert((await grantTrial(a.id, TRIAL_DAYS_PUBLIC)) === true, "grantTrial returns true for a fresh user");
  let A = await prisma.user.findUnique({ where: { id: a.id } });
  assert(A!.plan === "PRO" && !!A!.trialStartedAt && !!A!.trialEndsAt, "user is PRO with trialStartedAt+trialEndsAt set");
  assert(A!.usageLimit === 100, "usageLimit set to PRO clips (100)");
  const st = trialStatus(A!);
  assert(st.active && st.daysLeft === 7 && st.hasUsedTrial, "trialStatus: active, 7 days left, hasUsedTrial");

  // one-trial-per-user (idempotent)
  assert((await grantTrial(a.id, TRIAL_DAYS_PUBLIC)) === false, "grantTrial returns false the second time");

  // active subscriber is not granted
  const sub = await mkUser({ subStatus: "active" });
  assert((await grantTrial(sub.id, 7)) === false, "active subscriber is not granted a trial");

  // conversion clears trialEndsAt → revert skips them
  const conv = await mkUser();
  await grantTrial(conv.id, 7);
  await prisma.user.update({ where: { id: conv.id }, data: { trialEndsAt: null } }); // simulate payment/coupon conversion
  // expiry: past-due unconverted trial reverts; converted + active + never-trialed are untouched
  const expired = await mkUser();
  await grantTrial(expired.id, 7);
  await prisma.user.update({ where: { id: expired.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
  const activeSubExpired = await mkUser({ subStatus: "active", trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() - 1000), plan: "PRO" });
  const neverTrialedPaid = await mkUser({ plan: "PRO" }); // trialStartedAt null

  const reverted = await revertExpiredTrials();
  assert(reverted === 1, `revertExpiredTrials reverts exactly the 1 past-due unconverted trial (got ${reverted})`);
  const E = await prisma.user.findUnique({ where: { id: expired.id } });
  assert(E!.plan === "FREE" && E!.trialEndsAt === null && !!E!.trialStartedAt && E!.usageLimit === 2, "expired trial → FREE, trialEndsAt cleared, trialStartedAt kept, usageLimit 2");
  const C = await prisma.user.findUnique({ where: { id: conv.id } });
  assert(C!.plan === "PRO", "converted user (trialEndsAt null) NOT reverted");
  const S = await prisma.user.findUnique({ where: { id: activeSubExpired.id } });
  assert(S!.plan === "PRO", "active subscriber NOT reverted even with past trialEndsAt");
  const N = await prisma.user.findUnique({ where: { id: neverTrialedPaid.id } });
  assert(N!.plan === "PRO", "never-trialed paid user untouched");

  // revert created a notification for the reverted user
  const notif = await prisma.notification.findFirst({ where: { userId: expired.id } });
  assert(!!notif, "revert created an upgrade notification");

  // ── MON-5 anti-farming: delete account → re-register same email → no 2nd trial ──
  // Reproduces the exploit: user X earns a trial, deletes their account (Clerk
  // user.deleted hard-deletes the User row — cascading away trialStartedAt), then
  // re-registers with the SAME email. Without the UsedTrialEmail guard the brand-new
  // row has trialStartedAt=null and grantTrial would happily grant a second trial.
  const farmEmail = "farmer@t.test";
  const farmer1 = await mkUser({ email: farmEmail });
  assert((await grantTrial(farmer1.id, TRIAL_DAYS_PUBLIC)) === true, "farming: 1st account grants trial");
  const usedRow = await prisma.usedTrialEmail.findUnique({ where: { emailHash: hashTrialEmail(farmEmail) } });
  assert(!!usedRow, "farming: UsedTrialEmail row written after grant");

  await prisma.user.delete({ where: { id: farmer1.id } }); // simulate Clerk user.deleted hard-delete

  const farmer2 = await mkUser({ email: farmEmail }); // fresh row, trialStartedAt=null
  assert(farmer2.trialStartedAt === null, "farming: re-registered row starts with no trial (would fool the old guard)");
  assert((await grantTrial(farmer2.id, TRIAL_DAYS_PUBLIC)) === false, "farming: 2nd account (same email) is BLOCKED from a 2nd trial");
  const F2 = await prisma.user.findUnique({ where: { id: farmer2.id } });
  assert(F2!.plan === "FREE" && F2!.trialStartedAt === null, "farming: re-registered account stays FREE, never trialed");

  await prisma.user.deleteMany();
  await prisma.usedTrialEmail.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} TRIAL CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
