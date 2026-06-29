// ai-text-limits.ts — managed-Gemini text-LLM call-frequency guard (H1)
//
// When MANAGED_GEMINI=1 the server pays for every Gemini call. The audio ceiling
// (ai-spend-limits.ts) bounds TTS/transcribe spend, but the text-Gemini endpoints
// (extract-keywords, fetch-stock LLM ranker, contents/generate, analyze-script,
// split-phrases, align-scenes, split-script, styles/analyze) had NO per-user cap
// and NO rate-limit — a client could loop them to burn the server key.
//
// This module bounds that by counting the NUMBER of text-LLM route invocations
// against an INVISIBLE monthly ceiling of `minutesLimit × AI_TEXT_CALLS_MULT`,
// shared across the same 30-day usage window as render minutes (the per-request
// blast radius — how big each call's input can be — is the separate L4 guard in
// ai-input-caps.ts). Normal users (a few text calls per video) never reach it;
// an abuser is bounded to ceiling calls / 30 days.

import { prisma } from "@/lib/prisma";
import { syncMinuteWindow } from "@/lib/minute-limits";

const DEFAULT_MULT = 25;

/** Configured ceiling multiplier (env AI_TEXT_CALLS_MULT, default 25).
 *  ~5-7 text calls per short video × generous re-roll headroom → PRO 80min×25 =
 *  2000 calls / 30 days, BUSINESS 150×25 = 3750, FREE 5×25 = 125, trial 15×25 = 375. */
export function aiTextCallCeilingMult(): number {
  const raw = Number(process.env.AI_TEXT_CALLS_MULT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MULT;
}

/** Monthly text-LLM call ceiling for a plan's render-minute limit.
 *  Rounded to nearest whole call (matches minute-system rounding). */
export function aiTextCallCeilingFor(minutesLimit: number, mult: number = aiTextCallCeilingMult()): number {
  const m = Number.isFinite(minutesLimit) && minutesLimit > 0 ? minutesLimit : 0;
  return Math.round(m * mult);
}

export type AiTextReserveResult = {
  allowed: boolean;
  used: number;
  ceiling: number;
  remaining: number;
  message?: string;
};

function ceilingMessage(plan: string, ceiling: number): string {
  const name = plan === "BUSINESS" ? "Business" : plan === "PRO" ? "Pro" : "Free";
  return `ใช้ AI ช่วยประมวลผลข้อความ (คีย์เวิร์ด/สคริปต์/สไตล์) ครบเพดานรอบนี้แล้ว (${name}: ${ceiling} ครั้ง/30 วัน) — รอรอบถัดไป`;
}

/** Reserve `count` text-LLM calls (default 1) against the monthly ceiling, BEFORE
 *  the Gemini call. Mirrors reserveAiAudioMinutes / reserveMinutes (atomic
 *  conditional updateMany). Charged on attempt (NOT refunded on Gemini failure) —
 *  the whole point is to bound retry/loop frequency, so a failed-then-retried
 *  call must still count. `enforce` is the managed-mode flag — when false (BYOK)
 *  this is a no-op that always allows and touches NO DB row (flag-off
 *  byte-identical). */
export async function reserveAiTextCall(
  userId: string,
  opts: { enforce: boolean; count?: number }
): Promise<AiTextReserveResult> {
  const count = opts.count != null && opts.count > 0 ? opts.count : 1;

  if (!opts.enforce) {
    return { allowed: true, used: 0, ceiling: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY };
  }

  const s = await syncMinuteWindow(userId);
  if (!s) return { allowed: false, used: 0, ceiling: 0, remaining: 0, message: "ไม่พบผู้ใช้" };

  const ceiling = aiTextCallCeilingFor(s.minutesLimit);
  const used = s.aiTextCallsUsed;
  if (used + count > ceiling) {
    return { allowed: false, used, ceiling, remaining: Math.max(0, ceiling - used), message: ceilingMessage(s.plan, ceiling) };
  }

  // Atomic conditional reserve — same pattern as reserveMinutes / reserveAiAudioMinutes.
  const reserved = await prisma.user.updateMany({
    where: { id: userId, aiTextCallsUsed: { lte: ceiling - count } },
    data: { aiTextCallsUsed: { increment: count } },
  });

  if (reserved.count !== 1) {
    // Lost the race — re-read and report current state.
    const latest = await syncMinuteWindow(userId);
    const lu = latest?.aiTextCallsUsed ?? used;
    const lc = latest ? aiTextCallCeilingFor(latest.minutesLimit) : ceiling;
    return { allowed: false, used: lu, ceiling: lc, remaining: Math.max(0, lc - lu), message: ceilingMessage(latest?.plan ?? s.plan, lc) };
  }

  const newUsed = used + count;
  return { allowed: true, used: newUsed, ceiling, remaining: Math.max(0, ceiling - newUsed) };
}

/** Give back text-LLM calls (e.g. an admin correction). Clamps at 0 — never
 *  goes negative. Routes deliberately do NOT refund on Gemini failure (see
 *  reserveAiTextCall) — this exists for completeness / parity with the audio guard. */
export async function refundAiTextCalls(userId: string, count: number): Promise<void> {
  if (!(count > 0)) return;
  await prisma.$executeRaw`UPDATE "User" SET "aiTextCallsUsed" = MAX(0, "aiTextCallsUsed" - ${count}) WHERE "id" = ${userId}`;
}
