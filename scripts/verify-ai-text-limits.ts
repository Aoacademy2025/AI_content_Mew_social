// verify-ai-text-limits.ts — managed-Gemini text-LLM call-frequency guard (H1)
// Proof of the per-user MONTHLY text-LLM call ceiling, the keystone that bounds
// server-Gemini TEXT spend (extract-keywords, fetch-stock ranker, contents/generate,
// analyze-script, split-phrases, align-scenes, split-script, styles/analyze) when
// MANAGED_GEMINI=1. The audio ceiling (ai-spend-limits) only covers TTS/transcribe.
//
// Run: npx tsx scripts/verify-ai-text-limits.ts
//
// Part 1 (pure): aiTextCallCeilingFor math — no DB.
// Part 2 (DB):   reserveAiTextCall — spins a throwaway SQLite, pushes the real
//                schema, asserts block-at-ceiling / allow-under / atomicity /
//                refund / trial-cap / window-reset / flag-off-noop.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aitext-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
// Pin the multiplier so the math assertions are deterministic regardless of the
// host env. Default (no env) = 25; we assert the default explicitly below by
// importing the math helper BEFORE setting any override... but keep it simple:
// the lib reads process.env at call time, so set the canonical default here.
delete process.env.AI_TEXT_CALLS_MULT;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { aiTextCallCeilingFor, aiTextCallCeilingMult, reserveAiTextCall, refundAiTextCalls } = await import("../src/lib/ai-text-limits");
  const { prisma } = await import("../src/lib/prisma");

  // ── Part 1: pure ceiling math (default multiplier = 25) ────────────────────
  ok(aiTextCallCeilingMult() === 25, "default multiplier = 25");
  ok(aiTextCallCeilingFor(80) === 2000, "PRO 80 → ceiling 2000 (×25 default)");
  ok(aiTextCallCeilingFor(150) === 3750, "BUSINESS 150 → ceiling 3750");
  ok(aiTextCallCeilingFor(15) === 375, "Trial 15 → ceiling 375");
  ok(aiTextCallCeilingFor(5) === 125, "FREE 5 → ceiling 125");
  ok(aiTextCallCeilingFor(80, 10) === 800, "explicit mult 10: 80 → 800");
  ok(aiTextCallCeilingFor(0) === 0, "0 limit → 0 ceiling (no room)");
  ok(aiTextCallCeilingFor(-5) === 0, "negative limit → 0 ceiling");

  const used = async (id: string) =>
    (await prisma.user.findUnique({ where: { id }, select: { aiTextCallsUsed: true } }))!.aiTextCallsUsed;

  // ── Part 2: reserveAiTextCall (DB). Use a tiny ceiling for fast assertions by
  // pinning a small minutesLimit via a low-limit user (FREE 5 → ceiling 125).
  const now = new Date();
  await prisma.user.create({
    data: {
      id: "tx-pro", name: "Tx Pro", email: "tx-pro@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiTextCallsUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });

  // flag-off (BYOK): always allowed, NO DB write (byte-identical noop)
  const off = await reserveAiTextCall("tx-pro", { enforce: false });
  ok(off.allowed === true, "enforce:false → allowed (BYOK, no ceiling)");
  ok((await used("tx-pro")) === 0, "enforce:false → DB counter untouched");

  // enforce: a normal single call under ceiling
  const r1 = await reserveAiTextCall("tx-pro", { enforce: true });
  ok(r1.allowed === true && r1.ceiling === 2000, "reserve 1 of 2000 → allowed");
  ok((await used("tx-pro")) === 1, "counter incremented to 1");

  // count param: reserve a batch at once
  const r2 = await reserveAiTextCall("tx-pro", { enforce: true, count: 1998 });
  ok(r2.allowed === true, "reserve 1998 more → exactly 1999");
  ok((await used("tx-pro")) === 1999, "counter at 1999");

  // exactly up to ceiling (inclusive)
  const r3 = await reserveAiTextCall("tx-pro", { enforce: true });
  ok(r3.allowed === true, "reserve 1 more → exactly 2000 (ceiling inclusive)");
  ok((await used("tx-pro")) === 2000, "counter at 2000 (ceiling)");

  // over ceiling → blocked, no increment
  const r4 = await reserveAiTextCall("tx-pro", { enforce: true });
  ok(r4.allowed === false, "reserve past 2000 → blocked");
  ok((await used("tx-pro")) === 2000, "blocked reserve did NOT increment");
  ok(typeof r4.message === "string" && r4.message.length > 0, "block returns a user message");

  // atomicity: the conditional where prevents a batch from overshooting the ceiling
  // even when the pre-check would otherwise pass under a race. Set counter to 1999
  // then try a batch of 2 → blocked (1999+2 > 2000), counter unchanged.
  await refundAiTextCalls("tx-pro", 1); // 2000 → 1999
  ok((await used("tx-pro")) === 1999, "refund 1 → counter 1999");
  const r5 = await reserveAiTextCall("tx-pro", { enforce: true, count: 2 });
  ok(r5.allowed === false, "batch of 2 at 1999/2000 → blocked (atomic conditional)");
  ok((await used("tx-pro")) === 1999, "blocked batch did NOT increment");
  const r6 = await reserveAiTextCall("tx-pro", { enforce: true, count: 1 });
  ok(r6.allowed === true && (await used("tx-pro")) === 2000, "single call fills the last slot");

  // refund clamps at 0 (never negative)
  await refundAiTextCalls("tx-pro", 99999);
  ok((await used("tx-pro")) === 0, "refund clamps at 0 (never negative)");

  // refund 0 / negative → no-op
  await refundAiTextCalls("tx-pro", 0);
  await refundAiTextCalls("tx-pro", -5);
  ok((await used("tx-pro")) === 0, "refund 0/negative → no-op");

  // ── Trial user: PRO but active trial → effective limit 15 → ceiling 375 ─────
  await prisma.user.create({
    data: {
      id: "tx-trial", name: "Tx Trial", email: "tx-trial@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiTextCallsUsed: 0,
      usagePeriodStartedAt: now,
      trialStartedAt: new Date(now.getTime() - 24 * 3600 * 1000),
      trialEndsAt: new Date(now.getTime() + 5 * 24 * 3600 * 1000),
      usageLimit: 100, usageCount: 0,
    },
  });
  const t1 = await reserveAiTextCall("tx-trial", { enforce: true, count: 375 });
  ok(t1.allowed === true && t1.ceiling === 375, "trial: ceiling capped at 375 (15×25), reserve 375 ok");
  const t2 = await reserveAiTextCall("tx-trial", { enforce: true });
  ok(t2.allowed === false, "trial: reserve past 375 → blocked");

  // ── Window reset: expired usagePeriodStartedAt → counter treated as 0 ───────
  await prisma.user.create({
    data: {
      id: "tx-stale", name: "Tx Stale", email: "tx-stale@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 70, aiTextCallsUsed: 2000,
      usagePeriodStartedAt: new Date(now.getTime() - 40 * 24 * 3600 * 1000),
      trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });
  const w1 = await reserveAiTextCall("tx-stale", { enforce: true });
  ok(w1.allowed === true, "stale window: reserve allowed (counter reset)");
  ok((await used("tx-stale")) === 1, "stale window: counter reset to 0 then +1 (not 2001)");

  // ── Missing user → blocked with message (defensive) ────────────────────────
  const nu = await reserveAiTextCall("does-not-exist", { enforce: true });
  ok(nu.allowed === false, "missing user (enforce) → blocked");
  const nuOff = await reserveAiTextCall("does-not-exist", { enforce: false });
  ok(nuOff.allowed === true, "missing user (enforce:false) → allowed (no DB touch)");

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
