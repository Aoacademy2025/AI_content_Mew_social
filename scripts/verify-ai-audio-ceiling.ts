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
  const { aiAudioCeilingFor, reserveAiAudioMinutes, refundAiAudioMinutes, checkAiAudioCeiling, recordAiAudioMinutes, reconcileAiAudioMinutes, estimateTtsAudioMinutes } = await import("../src/lib/ai-spend-limits");
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

  // ── checkAiAudioCeiling (peek, read-only) + recordAiAudioMinutes (post-hoc) ──
  // Route pattern: peek BEFORE generating (block if at ceiling), record ACTUAL
  // audio-minutes AFTER success (record allows overshoot by ≤1 generation).
  await prisma.user.create({
    data: {
      id: "ace-peek", name: "Ace Peek", email: "ace-peek@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });

  // enforce:false → always allowed, no DB read/write
  const pOff = await checkAiAudioCeiling("ace-peek", { enforce: false });
  ok(pOff.allowed === true, "peek enforce:false → allowed (BYOK)");

  // peek does NOT mutate
  const p1 = await checkAiAudioCeiling("ace-peek", { enforce: true });
  ok(p1.allowed === true && p1.ceiling === 160, "peek under ceiling → allowed");
  ok((await aiUsed("ace-peek")) === 0, "peek did NOT mutate counter");

  // record increments unconditionally (post-hoc charge)
  await recordAiAudioMinutes("ace-peek", 1.5, { enforce: true });
  ok((await aiUsed("ace-peek")) === 1.5, "record 1.5 → counter 1.5 (Float)");

  // record enforce:false → no-op; record 0/neg → no-op
  await recordAiAudioMinutes("ace-peek", 99, { enforce: false });
  await recordAiAudioMinutes("ace-peek", 0, { enforce: true });
  await recordAiAudioMinutes("ace-peek", -5, { enforce: true });
  ok((await aiUsed("ace-peek")) === 1.5, "record no-op for enforce:false / 0 / negative");

  // at/over ceiling → peek blocks; record still allows overshoot (no block)
  await recordAiAudioMinutes("ace-peek", 158.5, { enforce: true }); // now 160 = ceiling
  const p2 = await checkAiAudioCeiling("ace-peek", { enforce: true });
  ok(p2.allowed === false, "peek at ceiling (160) → blocked");
  await recordAiAudioMinutes("ace-peek", 10, { enforce: true });
  ok((await aiUsed("ace-peek")) === 170, "record overshoots past ceiling (170) — no block on record");

  // ── estimateTtsAudioMinutes (H2): text length → reservable audio-minutes ─────
  // tts-gemini doesn't know the audio length until AFTER generation, so it
  // reserves an ESTIMATE from the input text up front (atomic), then reconciles.
  ok(estimateTtsAudioMinutes("") === 0.25, "estimate: empty text → minimum reserve 0.25");
  ok(estimateTtsAudioMinutes("   \n\t  ") === 0.25, "estimate: whitespace-only → minimum 0.25");
  // 840 non-space chars @ 14 chars/sec = 60s = 1.0 min
  ok(Math.abs(estimateTtsAudioMinutes("ก".repeat(840)) - 1) < 1e-9, "estimate: 840 chars → 1.0 min (14 cps)");
  ok(Math.abs(estimateTtsAudioMinutes("ก ".repeat(840)) - 1) < 1e-9, "estimate: whitespace ignored (spaces don't speak)");
  ok(estimateTtsAudioMinutes("ก".repeat(2000)) > estimateTtsAudioMinutes("ก".repeat(1000)), "estimate: longer text → more minutes (monotonic)");

  // ── reconcileAiAudioMinutes (H2): settle a reserve to the real audio length ──
  await prisma.user.create({
    data: {
      id: "ace-reco", name: "Ace Reco", email: "ace-reco@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });
  await reserveAiAudioMinutes("ace-reco", 5, { enforce: true });        // reserve estimate → counter 5
  await reconcileAiAudioMinutes("ace-reco", 5, 3, { enforce: true });   // actual 3 < reserved 5 → refund 2
  ok((await aiUsed("ace-reco")) === 3, "reconcile: actual<reserve → refund surplus (5→3)");
  await reconcileAiAudioMinutes("ace-reco", 3, 4.5, { enforce: true }); // actual 4.5 > reserved 3 → record +1.5
  ok((await aiUsed("ace-reco")) === 4.5, "reconcile: actual>reserve → record delta (3→4.5)");
  await reconcileAiAudioMinutes("ace-reco", 4.5, 4.5, { enforce: true });
  ok((await aiUsed("ace-reco")) === 4.5, "reconcile: actual==reserve → no change");
  await reconcileAiAudioMinutes("ace-reco", 4.5, 99, { enforce: false }); // BYOK → no DB touch
  ok((await aiUsed("ace-reco")) === 4.5, "reconcile: enforce:false → no-op (byte-identical)");

  // ── ATOMICITY under concurrency: the actual H2 fix ──────────────────────────
  // A read-only peek-then-write (checkAiAudioCeiling → recordAiAudioMinutes) lets
  // N racing TTS calls all see "under ceiling" and overshoot; the atomic
  // conditional reserve admits only those that fit. (No global render queue, so
  // concurrent re-rolls/previews from one user really do race.)
  await prisma.user.create({
    data: {
      id: "ace-race", name: "Ace Race", email: "ace-race@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });
  // First, characterize the HOLE the fix closes: the read-only peek allows ALL racers.
  const peeks = await Promise.all(
    Array.from({ length: 5 }, () => checkAiAudioCeiling("ace-race", { enforce: true })),
  );
  ok(peeks.every((p) => p.allowed), "race: read-only peek allows ALL 5 racers (the non-atomic hole)");
  // Now the fix: 5 concurrent reserves of 100 vs ceiling 160. A peek passes all 5
  // (→500, 3× over). The atomic reserve admits exactly ONE (100≤160; a 2nd = 200>160).
  const racers = await Promise.all(
    Array.from({ length: 5 }, () => reserveAiAudioMinutes("ace-race", 100, { enforce: true })),
  );
  ok(racers.filter((r) => r.allowed).length === 1, "race: atomic reserve admits exactly 1 of 5 (100 of 160)");
  ok((await aiUsed("ace-race")) === 100, "race: counter = 100 (never overshoots ceiling 160)");

  // Tighter tiling: 4 racers ×60 vs ceiling 160 — 60+60 fit (120), a 3rd (180) cannot.
  await prisma.user.create({
    data: {
      id: "ace-race2", name: "Ace Race2", email: "ace-race2@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
    },
  });
  const racers2 = await Promise.all(
    Array.from({ length: 4 }, () => reserveAiAudioMinutes("ace-race2", 60, { enforce: true })),
  );
  ok(racers2.filter((r) => r.allowed).length === 2, "race2: 4 racers ×60 vs ceiling 160 → exactly 2 admitted");
  ok((await aiUsed("ace-race2")) === 120, "race2: counter = 120 ≤ 160 (atomic tiling, no overshoot)");

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
