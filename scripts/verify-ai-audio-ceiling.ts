// verify-ai-audio-ceiling.ts — managed-Gemini cost guard (L2a)
// Proof of the AI-audio-minute monthly ceiling (TTS + transcribe), the keystone
// that bounds server-Gemini cost when MANAGED_GEMINI=1.
//
// Run: npx tsx scripts/verify-ai-audio-ceiling.ts
//
// Part 1 (pure): aiAudioCeilingFor math — no DB.
// Part 2 (DB):   reserveAiAudioMinutes — spins a throwaway SQLite, pushes the
//                real schema, asserts block-at-ceiling / allow-under / refund /
//                trial-cap / window-reset / flag-off-noop.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aiceiling-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { aiAudioCeilingFor, reserveAiAudioMinutes, refundAiAudioMinutes } = await import("../src/lib/ai-spend-limits");
  const { prisma } = await import("../src/lib/prisma");

  // ── Part 1: pure ceiling math (default multiplier = 2) ─────────────────────
  ok(aiAudioCeilingFor(80) === 160, "PRO 80 → ceiling 160 (×2 default)");
  ok(aiAudioCeilingFor(150) === 300, "BUSINESS 150 → ceiling 300");
  ok(aiAudioCeilingFor(15) === 30, "Trial 15 → ceiling 30");
  ok(aiAudioCeilingFor(5) === 10, "FREE 5 → ceiling 10");
  ok(aiAudioCeilingFor(80, 1.5) === 120, "explicit mult 1.5: 80 → 120");
  ok(aiAudioCeilingFor(15, 1.5) === 23, "rounds to nearest: 15×1.5=22.5 → 23");
  ok(aiAudioCeilingFor(0) === 0, "0 limit → 0 ceiling (no room)");

  const aiUsed = async (id: string) =>
    (await prisma.user.findUnique({ where: { id }, select: { aiAudioMinutesUsed: true } }))!.aiAudioMinutesUsed;

  // ── Part 2: reserveAiAudioMinutes (DB). PRO, limit 80 → ceiling 160 ─────────
  const now = new Date();
  await prisma.user.create({
    data: {
      id: "ace-pro", name: "Ace Pro", email: "ace-pro@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });

  // flag-off (BYOK): always allowed, NO DB write (byte-identical noop)
  const off = await reserveAiAudioMinutes("ace-pro", 999, { enforce: false });
  ok(off.allowed === true, "enforce:false → allowed (BYOK, no ceiling)");
  ok((await aiUsed("ace-pro")) === 0, "enforce:false → DB counter untouched");

  // enforce: under ceiling
  const r1 = await reserveAiAudioMinutes("ace-pro", 100, { enforce: true });
  ok(r1.allowed === true && r1.ceiling === 160, "reserve 100 of 160 → allowed");
  ok((await aiUsed("ace-pro")) === 100, "counter incremented to 100");

  // exactly up to ceiling
  const r2 = await reserveAiAudioMinutes("ace-pro", 60, { enforce: true });
  ok(r2.allowed === true, "reserve 60 more → exactly 160 (ceiling inclusive) allowed");
  ok((await aiUsed("ace-pro")) === 160, "counter at 160");

  // over ceiling → blocked, no increment
  const r3 = await reserveAiAudioMinutes("ace-pro", 1, { enforce: true });
  ok(r3.allowed === false, "reserve past 160 → blocked");
  ok((await aiUsed("ace-pro")) === 160, "blocked reserve did NOT increment");

  // refund restores room
  await refundAiAudioMinutes("ace-pro", 10);
  ok((await aiUsed("ace-pro")) === 150, "refund 10 → counter 150");
  const r4 = await reserveAiAudioMinutes("ace-pro", 10, { enforce: true });
  ok(r4.allowed === true && (await aiUsed("ace-pro")) === 160, "reserve 10 after refund → allowed");

  // refund clamps at 0
  await refundAiAudioMinutes("ace-pro", 9999);
  ok((await aiUsed("ace-pro")) === 0, "refund clamps at 0 (never negative)");

  // ── Trial user: PRO but active trial → effective limit 15 → ceiling 30 ──────
  await prisma.user.create({
    data: {
      id: "ace-trial", name: "Ace Trial", email: "ace-trial@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
      usagePeriodStartedAt: now,
      trialStartedAt: new Date(now.getTime() - 24 * 3600 * 1000),
      trialEndsAt: new Date(now.getTime() + 5 * 24 * 3600 * 1000),
      usageLimit: 100, usageCount: 0,
    },
  });
  const t1 = await reserveAiAudioMinutes("ace-trial", 30, { enforce: true });
  ok(t1.allowed === true && t1.ceiling === 30, "trial: ceiling capped at 30 (15×2), reserve 30 ok");
  const t2 = await reserveAiAudioMinutes("ace-trial", 0.5, { enforce: true });
  ok(t2.allowed === false, "trial: reserve past 30 → blocked");

  // ── Window reset: expired usagePeriodStartedAt → counter treated as 0 ───────
  await prisma.user.create({
    data: {
      id: "ace-stale", name: "Ace Stale", email: "ace-stale@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 70, aiAudioMinutesUsed: 160,
      usagePeriodStartedAt: new Date(now.getTime() - 40 * 24 * 3600 * 1000),
      trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });
  const w1 = await reserveAiAudioMinutes("ace-stale", 5, { enforce: true });
  ok(w1.allowed === true, "stale window: reserve 5 allowed (counter reset)");
  ok((await aiUsed("ace-stale")) === 5, "stale window: counter reset to 0 then +5 (not 165)");

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
