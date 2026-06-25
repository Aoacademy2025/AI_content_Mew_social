// Proof of the credit-overflow refund primitives (Task 2: refundCredits + creditsSpent).
// Run with: npx tsx scripts/verify-credit-overflow.ts
//
// Self-contained: spins a throwaway SQLite DB, pushes the real schema.prisma,
// dynamically imports helpers, asserts, exits non-zero on failure.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "creditoverflow-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { refundCredits, getBalance, grantCredits } = await import("../src/lib/credits");
  const { recordChargedClip } = await import("../src/lib/clip-charge");
  const { prisma } = await import("../src/lib/prisma");

  // ── Seed a user with CreditBalance { granted: 0, purchased: 10 } ──────────
  const userId = "user-overflow-test-1";
  await grantCredits(userId, 10, "purchase", "seed-purchased");

  const balBefore = await getBalance(userId);
  ok(balBefore.purchased === 10, "seed: purchased = 10");
  ok(balBefore.granted === 0, "seed: granted = 0");
  ok(balBefore.total === 10, "seed: total = 10");

  // ── refundCredits: adds to purchased bucket ───────────────────────────────
  await refundCredits(userId, 4, "render-overflow-refund:job1");
  const bal = await getBalance(userId);
  ok(bal.purchased === 14, "refund adds to purchased: 10 + 4 = 14");
  ok(bal.total === 14, "refund total = 14");

  // ── refundCredits: writes a ledger row with kind:"refund" ─────────────────
  const row = await prisma.creditLedger.findFirst({
    where: { userId, action: "render-overflow-refund:job1" },
  });
  ok(row?.kind === "refund", "refund ledger row: kind = 'refund'");
  ok(row?.delta === 4, "refund ledger row: delta = 4");
  ok((row?.balanceAfter ?? -1) === 14, "refund ledger row: balanceAfter = 14");

  // ── refundCredits: rejects non-positive amount ────────────────────────────
  let threw = false;
  try { await refundCredits(userId, 0, "x"); } catch { threw = true; }
  ok(threw, "refundCredits(0) rejects with thrown error");

  let threw2 = false;
  try { await refundCredits(userId, -5, "x"); } catch { threw2 = true; }
  ok(threw2, "refundCredits(-5) rejects with thrown error");

  // ── refundCredits: accumulated via multiple calls ─────────────────────────
  await refundCredits(userId, 6, "render-overflow-refund:job2");
  const bal2 = await getBalance(userId);
  ok(bal2.purchased === 20, "two refunds: 10 + 4 + 6 = 20 in purchased");
  ok(bal2.total === 20, "two refunds total = 20");

  // ── recordChargedClip 4-arg: stores creditsSpent ──────────────────────────
  const userId2 = "user-overflow-test-2";
  const urlC = "/api/renders/render-overflow-c.mp4";
  await recordChargedClip(userId2, urlC, undefined, 4);
  const rowC = await prisma.chargedClip.findFirst({
    where: { userId: userId2, outputUrl: urlC },
    select: { chargedMinutes: true, creditsSpent: true },
  });
  ok(rowC !== null, "recordChargedClip(u, url, undefined, 4) stored a row");
  ok(rowC?.creditsSpent === 4, "creditsSpent === 4 (credit-funded row)");
  ok(rowC?.chargedMinutes === null, "chargedMinutes === null when not supplied");

  // ── recordChargedClip 2-arg: creditsSpent stays null (backward-compat) ────
  const urlD = "/api/renders/render-overflow-d.mp4";
  await recordChargedClip(userId2, urlD);
  const rowD = await prisma.chargedClip.findFirst({
    where: { userId: userId2, outputUrl: urlD },
    select: { chargedMinutes: true, creditsSpent: true },
  });
  ok(rowD !== null, "recordChargedClip(u, urlD) 2-arg stored a row");
  ok(rowD?.creditsSpent === null, "2-arg call → creditsSpent === null (backward-compat)");
  ok(rowD?.chargedMinutes === null, "2-arg call → chargedMinutes === null (backward-compat)");

  // ── recordChargedClip 3-arg: creditsSpent stays null (backward-compat) ────
  const urlE = "/api/renders/render-overflow-e.mp4";
  await recordChargedClip(userId2, urlE, 3);
  const rowE = await prisma.chargedClip.findFirst({
    where: { userId: userId2, outputUrl: urlE },
    select: { chargedMinutes: true, creditsSpent: true },
  });
  ok(rowE !== null, "recordChargedClip(u, urlE, 3) 3-arg stored a row");
  ok(rowE?.chargedMinutes === 3, "3-arg call → chargedMinutes === 3");
  ok(rowE?.creditsSpent === null, "3-arg call → creditsSpent === null (backward-compat)");

  await prisma.$disconnect();

  if (failures) {
    console.error(`\n${failures} FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} CREDIT-OVERFLOW CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
