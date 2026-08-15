// ai-spend-limits.ts — managed AI-audio cost/capacity guard (L2a)
//
// When the platform supplies Gemini or runs OmniVoice, the server pays for each
// call in money or worker capacity. The render-minute
// reserve only caps *render compute* (Remotion/ffmpeg spend 0 Gemini) — the
// expensive Gemini spend (TTS audio out, transcribe audio in) happens in
// separate, client-callable, loopable endpoints that bypass the render reserve.
//
// This module bounds that spend with an INVISIBLE monthly ceiling of
// `minutesLimit × AI_AUDIO_CEILING_MULT` audio-minutes (TTS + transcribe
// combined), shared across the same 30-day usage window as render minutes.
// Normal users (a couple of re-rolls/previews per clip) never reach it; an
// abuser is bounded to ~ceiling × ฿0.53/min ≈ heavy-normal cost.

import { prisma } from "@/lib/prisma";
import { syncMinuteWindow } from "@/lib/minute-limits";

const DEFAULT_MULT = 2;

/** Configured ceiling multiplier (env AI_AUDIO_CEILING_MULT, default 2). */
export function aiAudioCeilingMult(): number {
  const raw = Number(process.env.AI_AUDIO_CEILING_MULT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MULT;
}

/** Monthly AI-audio-minute ceiling for a plan's render-minute limit.
 *  Rounded to nearest whole minute (matches minute-system rounding). */
export function aiAudioCeilingFor(minutesLimit: number, mult: number = aiAudioCeilingMult()): number {
  const m = Number.isFinite(minutesLimit) && minutesLimit > 0 ? minutesLimit : 0;
  return Math.round(m * mult);
}

export type AiAudioReserveResult = {
  allowed: boolean;
  used: number;
  ceiling: number;
  remaining: number;
  message?: string;
};

function ceilingMessage(plan: string, ceiling: number): string {
  const name = plan === "BUSINESS" ? "Business" : plan === "PRO" ? "Pro" : "Free";
  return `ใช้เสียง AI (สร้างเสียง/ถอดเสียง) ครบเพดานรอบนี้แล้ว (${name}: ${ceiling} นาที/30 วัน) — เรนเดอร์วิดีโอที่ทำไว้ หรือรอรอบถัดไป`;
}

/** Reserve `minutes` of AI audio (TTS generated / audio transcribed) against the
 *  monthly ceiling. Mirrors reserveMinutes (atomic conditional updateMany).
 *  `enforce` is the managed-mode flag — when false (BYOK) this is a no-op that
 *  always allows and touches NO DB row (flag-off byte-identical). */
export async function reserveAiAudioMinutes(
  userId: string,
  minutes: number,
  opts: { enforce: boolean; allowOverCeiling?: boolean }
): Promise<AiAudioReserveResult> {
  if (!opts.enforce) {
    return { allowed: true, used: 0, ceiling: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY };
  }

  const s = await syncMinuteWindow(userId);
  if (!s) return { allowed: false, used: 0, ceiling: 0, remaining: 0, message: "ไม่พบผู้ใช้" };

  const ceiling = aiAudioCeilingFor(s.minutesLimit);
  const used = s.aiAudioMinutesUsed;
  if (opts.allowOverCeiling) {
    await prisma.user.update({
      where: { id: userId },
      data: { aiAudioMinutesUsed: { increment: minutes } },
    });
    const newUsed = used + minutes;
    return { allowed: true, used: newUsed, ceiling, remaining: Math.max(0, ceiling - newUsed) };
  }
  if (used + minutes > ceiling) {
    return { allowed: false, used, ceiling, remaining: Math.max(0, ceiling - used), message: ceilingMessage(s.plan, ceiling) };
  }

  // Atomic conditional reserve — same pattern as reserveMinutes.
  const reserved = await prisma.user.updateMany({
    where: { id: userId, aiAudioMinutesUsed: { lte: ceiling - minutes } },
    data: { aiAudioMinutesUsed: { increment: minutes } },
  });

  if (reserved.count !== 1) {
    // Lost the race — re-read and report current state.
    const latest = await syncMinuteWindow(userId);
    const lu = latest?.aiAudioMinutesUsed ?? used;
    const lc = latest ? aiAudioCeilingFor(latest.minutesLimit) : ceiling;
    return { allowed: false, used: lu, ceiling: lc, remaining: Math.max(0, lc - lu), message: ceilingMessage(latest?.plan ?? s.plan, lc) };
  }

  const newUsed = used + minutes;
  return { allowed: true, used: newUsed, ceiling, remaining: Math.max(0, ceiling - newUsed) };
}

/** Give back AI-audio minutes (e.g. a TTS/transcribe call failed after reserve).
 *  Clamps at 0 — never goes negative. */
export async function refundAiAudioMinutes(userId: string, minutes: number): Promise<void> {
  await prisma.$executeRaw`UPDATE "User" SET "aiAudioMinutesUsed" = MAX(0, "aiAudioMinutesUsed" - ${minutes}) WHERE "id" = ${userId}`;
}

/** Read-only peek of the AI-audio ceiling — for gating BEFORE a TTS/transcribe
 *  call whose output minutes aren't known yet. Allowed while under the ceiling;
 *  `recordAiAudioMinutes` charges the actual minutes after success (so overshoot
 *  is bounded to ≤1 generation). `enforce:false` (BYOK) → always allowed, no read. */
export async function checkAiAudioCeiling(
  userId: string,
  opts: { enforce: boolean }
): Promise<AiAudioReserveResult> {
  if (!opts.enforce) {
    return { allowed: true, used: 0, ceiling: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY };
  }
  const s = await syncMinuteWindow(userId);
  if (!s) return { allowed: false, used: 0, ceiling: 0, remaining: 0, message: "ไม่พบผู้ใช้" };
  const ceiling = aiAudioCeilingFor(s.minutesLimit);
  const used = s.aiAudioMinutesUsed;
  const allowed = used < ceiling;
  return { allowed, used, ceiling, remaining: Math.max(0, ceiling - used), message: allowed ? undefined : ceilingMessage(s.plan, ceiling) };
}

/** Charge the ACTUAL audio-minutes after a successful TTS/transcribe call.
 *  Unconditional increment (the ceiling block is the peek's job) so a generation
 *  that started under the ceiling is always recorded. `enforce:false` / non-positive
 *  → no-op. Pairs with checkAiAudioCeiling. */
export async function recordAiAudioMinutes(
  userId: string,
  minutes: number,
  opts: { enforce: boolean }
): Promise<void> {
  if (!opts.enforce || !(minutes > 0)) return;
  await prisma.user.update({
    where: { id: userId },
    data: { aiAudioMinutesUsed: { increment: minutes } },
  });
}

// TTS audio length isn't known until AFTER generation, so the route can't reserve
// the exact minutes the way transcribe does (it knows the input duration). Instead
// it reserves an ESTIMATE from the input text up front — atomically — then reconciles
// to the real duration. Thai speech runs ~13-16 chars/sec (see tts-timing.ts); we
// estimate at a slightly conservative 14 cps so the reserve tends to meet-or-exceed
// the real duration (the reconcile refunds any surplus) and concurrent overshoot
// stays bounded. Whitespace isn't spoken, so it's stripped (matches the route's
// chars-per-sec logging). Floored at a small minimum so even a near-empty/preview
// call still holds a real, race-safe slice of the ceiling.
const TTS_ESTIMATE_CHARS_PER_SEC = 14;
const MIN_TTS_RESERVE_MINUTES = 0.25;

/** Estimate the audio-minutes a managed TTS call will produce from its input text,
 *  for the up-front atomic ceiling reserve. Always ≥ MIN_TTS_RESERVE_MINUTES. */
export function estimateTtsAudioMinutes(text: string): number {
  const chars = (typeof text === "string" ? text : "").replace(/\s+/g, "").length;
  const minutes = chars / (TTS_ESTIMATE_CHARS_PER_SEC * 60);
  return Math.max(minutes, MIN_TTS_RESERVE_MINUTES);
}

/** Reconcile an up-front AI-audio RESERVE to the ACTUAL minutes a TTS call produced.
 *  Pairs with `reserveAiAudioMinutes(estimate)`: if the audio ran LONGER than the
 *  estimate, record the extra (unconditional, like recordAiAudioMinutes — a call
 *  that started under the ceiling is always fully charged); if it ran SHORTER,
 *  refund the surplus so the counter lands on the real spend. `enforce:false`
 *  (BYOK) → no-op, no DB touch (flag-off byte-identical). */
export async function reconcileAiAudioMinutes(
  userId: string,
  reservedMinutes: number,
  actualMinutes: number,
  opts: { enforce: boolean }
): Promise<void> {
  if (!opts.enforce) return;
  const delta = actualMinutes - reservedMinutes;
  if (delta > 0) {
    await recordAiAudioMinutes(userId, delta, opts);
  } else if (delta < 0) {
    await refundAiAudioMinutes(userId, -delta);
  }
}
