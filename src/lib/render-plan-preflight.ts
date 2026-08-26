/**
 * Plan preflight for a render — PURE decision logic (no hooks, no prisma, no fetch).
 *
 * Why this exists (#301, rescoped 2026-08-26 from prod data): plan entitlements were
 * only enforced INSIDE the pipeline. A FREE account could pick ElevenLabs, wait through
 * script → funding → TTS, and only then get a 403 from `/api/videos/tts` written into
 * `VideoJob.errorMessage`. Five of the twenty-four failures since 2026-08-23 were one
 * customer hitting that same wall five times in a row, because nothing upstream said no.
 *
 * Two different kinds of check live here and they are deliberately NOT symmetric:
 *
 * - `voiceProviderPlanViolation` is DETERMINISTIC (plan × provider) → callers block on it.
 *   It is the same rule `/api/videos/tts` already enforces, just applied before a job row
 *   exists, so it can only turn a late failure into an early, actionable refusal.
 * - `estimatedDurationPlanWarning` is an ESTIMATE → it only ever WARNS. A duration gate
 *   built on an estimator has already misfired in this codebase once (see the note on
 *   `estimateClipSecV2` in video-editor/_v2/estimate.ts, where the legacy ~2 chars/sec
 *   formula over-counted ~6×). The authoritative cap stays `audioDurationLimitViolation`,
 *   which runs on the real post-TTS duration.
 */

import { PLAN_LABEL, durationCapSecFor, nextPlanFor } from "@/lib/plan-limits";

export type PreflightVoiceProvider = "gemini" | "elevenlabs" | "omnivoice";

/** Providers a FREE account cannot use, and the name shown to the customer. */
const PAID_ONLY_VOICE_PROVIDERS: Partial<Record<PreflightVoiceProvider, string>> = {
  elevenlabs: "ElevenLabs",
};

export interface VoiceProviderPlanViolation {
  code: "voice_plan_required";
  provider: PreflightVoiceProvider;
  /** What went wrong. */
  message: string;
  /** What the customer can do about it — always paired with a CTA in the UI. */
  userAction: string;
  plan: string;
  neededPlan: "PRO" | "BUSINESS" | null;
}

/**
 * Deterministic: this voice provider is not available on this plan.
 * Returns null when the render may proceed.
 */
export function voiceProviderPlanViolation(
  voiceProvider: string | null | undefined,
  plan: string,
): VoiceProviderPlanViolation | null {
  const provider = (voiceProvider ?? "gemini") as PreflightVoiceProvider;
  const label = PAID_ONLY_VOICE_PROVIDERS[provider];
  if (!label) return null;
  if (plan !== "FREE") return null;
  return {
    code: "voice_plan_required",
    provider,
    message: `${label} ใช้ได้เฉพาะแผน Pro ขึ้นไป`,
    userAction: `อัปเกรดเป็น ${PLAN_LABEL.PRO} เพื่อใช้ ${label} หรือเลือกเสียง Gemini ที่ใช้ได้ทุกแผน`,
    plan,
    neededPlan: "PRO",
  };
}

export interface EstimatedDurationPlanWarning {
  code: "duration_estimate_over_plan";
  message: string;
  userAction: string;
  plan: string;
  neededPlan: "PRO" | "BUSINESS" | null;
  estimatedSec: number;
  capSec: number;
}

/**
 * The script LOOKS longer than the plan's per-clip cap. Advisory only — never block on
 * this; the exact duration is known after TTS and gated there.
 */
export function estimatedDurationPlanWarning(
  estimatedSec: number,
  plan: string,
): EstimatedDurationPlanWarning | null {
  if (!Number.isFinite(estimatedSec) || estimatedSec <= 0) return null;
  const capSec = durationCapSecFor(plan);
  if (estimatedSec <= capSec) return null;
  const neededPlan = nextPlanFor(plan);
  const planLabel = PLAN_LABEL[plan] ?? plan;
  return {
    code: "duration_estimate_over_plan",
    message: `สคริปต์นี้ยาวประมาณ ${(estimatedSec / 60).toFixed(1)} นาที เกินเพดานแผน ${planLabel} (${capSec / 60} นาที/คลิป)`,
    userAction: neededPlan
      ? `ตัดสคริปต์ให้สั้นลง หรืออัปเกรดเป็น ${PLAN_LABEL[neededPlan]} (สูงสุด ${durationCapSecFor(neededPlan) / 60} นาที/คลิป) — ถ้าเรนเดอร์ต่อ งานจะหยุดหลังสร้างเสียงเสร็จ`
      : "ตัดสคริปต์ให้สั้นลง — ถ้าเรนเดอร์ต่อ งานจะหยุดหลังสร้างเสียงเสร็จ",
    plan,
    neededPlan,
    estimatedSec,
    capSec,
  };
}
