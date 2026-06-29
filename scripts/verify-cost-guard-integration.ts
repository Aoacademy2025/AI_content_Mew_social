// verify-cost-guard-integration.ts — managed-Gemini cost guard (integration)
//
// The libs are unit-tested individually (verify-ai-audio-ceiling, verify-minute-credits,
// verify-credit-overflow). This test exercises the COMPOSED system in the exact call
// sequences the routes + render worker make, against a real throwaway SQLite — catching
// wiring bugs (double-charge, wrong-bucket refund, counter cross-contamination, refund
// not firing) that per-function unit tests miss. This is the handoff-flagged
// "minutes-mode + credits-mode queue-refund integration test" gate before flipping
// MANAGED_GEMINI=1.
//
// Run: npx tsx scripts/verify-cost-guard-integration.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "costguard-int-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { passed++; console.log("ok:", msg); }
}

async function main() {
  const { reserveAiAudioMinutes, refundAiAudioMinutes } = await import("../src/lib/ai-spend-limits");
  const { reserveMinutesOrCredits, refundReservation } = await import("../src/lib/minute-credits");
  const { grantCredits, getBalance } = await import("../src/lib/credits");
  const { prisma } = await import("../src/lib/prisma");

  const ENF = { enforce: true } as const;
  const now = new Date();

  // Seed a PRO user (limit 80 → AI-audio ceiling 160). usagePeriodStartedAt=now so the
  // window isn't reset; trialEndsAt=null so limit isn't trial-capped; subStatus=null +
  // no planExpiresAt → entitlement stays PRO.
  async function seed(id: string, over: Record<string, unknown> = {}) {
    await prisma.user.create({
      data: {
        id, name: id, email: `${id}@example.com`,
        plan: "PRO", minutesLimit: 80, minutesUsed: 0, aiAudioMinutesUsed: 0,
        usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
        ...over,
      },
    });
  }
  const snap = async (id: string) => {
    const u = (await prisma.user.findUnique({ where: { id }, select: { minutesUsed: true, aiAudioMinutesUsed: true } }))!;
    const b = await getBalance(id);
    return { minutes: u.minutesUsed, ai: u.aiAudioMinutesUsed, credits: b.total, purchased: b.purchased };
  };

  // ── S1: render minutes vs AI-audio are INDEPENDENT counters (no double-charge) ──
  await seed("cg-s1");
  await reserveAiAudioMinutes("cg-s1", 2, ENF);                                   // TTS gen 2 min
  const s1r = await reserveMinutesOrCredits("cg-s1", 2, { creditsLive: true });   // render 2 min
  let s = await snap("cg-s1");
  ok(s1r.allowed && s1r.via === "minutes", "S1: render reserves via minutes");
  ok(s.minutes === 2 && s.ai === 2, "S1: TTS→ai=2, render→minutes=2 (independent, no double-charge)");

  // ── S2: TTS re-rolls draw down the ceiling ONLY, never render minutes ──
  for (let i = 0; i < 3; i++) await reserveAiAudioMinutes("cg-s1", 2, ENF);
  s = await snap("cg-s1");
  ok(s.ai === 8 && s.minutes === 2, "S2: 3 re-rolls → ai=8, render minutes still 2");

  // ── S3: render FAILS → refund restores minutes; AI-audio untouched ──
  await seed("cg-s3");
  const s3r = await reserveMinutesOrCredits("cg-s3", 5, { creditsLive: true });
  ok(s3r.allowed && s3r.via === "minutes", "S3: reserve 5 render minutes");
  ok((await snap("cg-s3")).minutes === 5, "S3: minutesUsed=5 after reserve");
  await refundReservation("cg-s3", { reservedMinutes: s3r.via === "minutes" ? s3r.reservedMinutes : null, creditsSpent: null }, "render-fail");
  s = await snap("cg-s3");
  ok(s.minutes === 0 && s.ai === 0, "S3: refund → minutes back to 0, ai untouched");

  // ── S4: out of minutes → credit overflow; refund goes to the CREDIT bucket ──
  await seed("cg-s4", { minutesUsed: 80, aiAudioMinutesUsed: 10 });
  await grantCredits("cg-s4", 100, "purchase", "seed");
  const s4r = await reserveMinutesOrCredits("cg-s4", 3, { creditsLive: true });   // 3 min × 2 = 6 credits
  ok(s4r.allowed && s4r.via === "credits", "S4: out of minutes → overflow via credits");
  s = await snap("cg-s4");
  ok(s.purchased === 94 && s.minutes === 80, "S4: 6 credits spent from purchased, minute meter untouched");
  await refundReservation("cg-s4", { reservedMinutes: null, creditsSpent: s4r.via === "credits" ? s4r.creditsSpent : null }, "render-fail");
  s = await snap("cg-s4");
  ok(s.purchased === 100, "S4: refund → credits restored to purchased bucket (not minutes)");
  ok(s.ai === 10, "S4: AI-audio counter untouched by the whole render/credit flow");

  // ── S5: AI-audio ceiling blocks TTS, but render path is independent + still works ──
  await seed("cg-s5", { aiAudioMinutesUsed: 160 }); // at ceiling
  const s5tts = await reserveAiAudioMinutes("cg-s5", 1, ENF);
  const s5rnd = await reserveMinutesOrCredits("cg-s5", 2, { creditsLive: true });
  ok(s5tts.allowed === false, "S5: TTS blocked at ceiling");
  ok(s5rnd.allowed && s5rnd.via === "minutes", "S5: render still allowed (independent counter)");
  ok((await snap("cg-s5")).minutes === 2, "S5: render minutes reserved despite TTS being capped");

  // ── S6: AI-audio refund (transcribe-fail fast-follow path) restores the counter ──
  await seed("cg-s6");
  await reserveAiAudioMinutes("cg-s6", 5, ENF);
  await refundAiAudioMinutes("cg-s6", 5);
  ok((await snap("cg-s6")).ai === 0, "S6: refundAiAudioMinutes restores the ceiling counter");

  // ── S7: window expiry resets BOTH counters together on the next reserve ──
  await seed("cg-s7", {
    minutesUsed: 70, aiAudioMinutesUsed: 160,
    usagePeriodStartedAt: new Date(now.getTime() - 40 * 24 * 3600 * 1000),
  });
  const s7r = await reserveMinutesOrCredits("cg-s7", 2, { creditsLive: true });
  s = await snap("cg-s7");
  ok(s7r.allowed && s7r.via === "minutes", "S7: stale window → render reserve allowed (not credit overflow)");
  ok(s.minutes === 2 && s.ai === 0, "S7: window reset zeroed BOTH minutes(→2) and ai(→0)");

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
