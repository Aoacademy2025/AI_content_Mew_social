// kie-image-guards.ts — managed-kie image-generation cost guards (ADR 0002).
//
// When MANAGED_KIE=1 the server pays for every kie.ai createTask a non-admin
// paid user triggers (billed to their credits by fetch-stock). Credits bound the
// spend, but these guards additionally cap the BLAST RADIUS of a single user /
// single job so one client can't loop the server key or run one job that quietly
// generates hundreds of images before the credit balance catches up. Mirrors the
// managed-Gemini guards (ai-spend-limits / ai-text-limits / ai-input-caps).
//
// All three guards are only ever consulted on the managed non-admin-paid path
// (see fetch-stock). Flag off (MANAGED_KIE unset) they are never called, so
// BYOK/admin behavior is byte-identical.

// ── Access / metering decision (single source of truth) ──────────────────────

export interface KieImageAccess {
  /** Private-beta tester may reach the feature under the role/plan launch rules. */
  canUseKieImages: boolean;
  /** Internal paid (PRO/BUSINESS) users may reach managed kie image sources. */
  kiePaidUnlocked: boolean;
  /** Meter credits: only non-admin paid users on the managed key are charged.
   *  Admins and flag-off/BYOK are never charged. */
  chargeImages: boolean;
}

/**
 * Resolve whether a user may use kie image sources and whether their generations
 * are credit-metered. Non-testers are always denied, including admins and paid
 * subscribers. Inside the private beta, admins retain BYOK access while paid
 * non-admin testers require both managed launch flags.
 */
export function resolveKieImageAccess(opts: {
  managedKieOn: boolean;
  creditsLive: boolean;
  isAdmin: boolean;
  isPaidPlan: boolean;
  isInternalTester: boolean;
}): KieImageAccess {
  const kiePaidUnlocked = opts.isInternalTester && opts.managedKieOn && opts.creditsLive && opts.isPaidPlan;
  const canUseKieImages = opts.isInternalTester && (opts.isAdmin || kiePaidUnlocked);
  const chargeImages = kiePaidUnlocked && !opts.isAdmin;
  return { canUseKieImages, kiePaidUnlocked, chargeImages };
}

/**
 * Launch-state signal ONLY (both server flags on), independent of plan/admin —
 * lets the client distinguish "feature not launched yet" (เร็ว ๆ นี้) from
 * "launched but you haven't paid" (อัปเกรดเพื่อใช้ภาพ AI) when rendering locked
 * AI-image UI (Task 7 badge). Deliberately does NOT fold in the plan check (that
 * stays in resolveKieImageAccess) and does NOT reveal whether KIE_API_KEY is
 * configured — this is a presentation-only signal, not an access decision.
 */
export function managedKieLaunchOn(): boolean {
  return process.env.MANAGED_KIE === "1" && process.env.CREDITS_LIVE === "1";
}

/**
 * Whether the managed-key guardrails (per-job cap, hourly rate limit, prompt cap)
 * apply to this request. They apply to ANY generation that runs on the shared
 * server `KIE_API_KEY` — including admins (who are still UNCHARGED; only the caps
 * apply, mirroring the managed-Gemini precedent where the ceiling/rate guards bound
 * every managed-key call regardless of role). `usesManagedKey` = the resolved kie
 * token is the server env key (not a user's BYOK key). Flag-off / BYOK → false →
 * unguarded (byte-identical). Charged (non-admin paid) requests always run on the
 * managed key, so `chargeImages` implies guarding too.
 */
export function shouldGuardKieImages(opts: { usesManagedKey: boolean; chargeImages: boolean }): boolean {
  return opts.usesManagedKey || opts.chargeImages;
}

/** Why AI images were skipped mid-job, surfaced to the client so the UI can explain
 *  the missing images. "provider" = the image provider was unavailable (open circuit,
 *  cost guard, or a systemic failure that stopped the batch) — nothing was charged.
 *  "unauthorized" = this request may not mint paid images against the video at all (not
 *  from the render pipeline, or a foreign/terminal videoJobId — see
 *  hero-image-namespace.ts); nothing was charged and an identical retry won't help. */
export type AiSkipReason = "credits" | "rate" | "cap" | "provider" | "unauthorized" | null;

/**
 * Merge the direct kie-image path's PRE-LOOP cap-clamp signal with any reason a
 * guard set DURING the generation loop, for the response only.
 *
 * INVARIANT (why this exists): the pre-loop clamp of the requested count down to
 * KIE_MAX_IMAGES_PER_JOB must NOT be written into the shared in-loop
 * `aiSkippedReason` — the loop gate bails every item once that field is set, which
 * would make the clamped batch generate 0 images. So the clamp is tracked in a
 * separate `capClampHit` boolean and merged in here, AFTER the loop, and only when
 * no in-loop guard already set a more specific reason (credits/rate/cap).
 */
export function mergeCapClampReason(inLoopReason: AiSkipReason, capClampHit: boolean): AiSkipReason {
  return inLoopReason ?? (capClampHit ? "cap" : null);
}

const DEFAULT_MAX_IMAGES_PER_JOB = 20;
const DEFAULT_RATE_PER_HOUR = 60;

/** Max AI images a single fetch-stock job may generate (env KIE_MAX_IMAGES_PER_JOB,
 *  default 20). Windows beyond this fall back to stock. */
export function kieMaxImagesPerJob(): number {
  const raw = Number(process.env.KIE_MAX_IMAGES_PER_JOB);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_IMAGES_PER_JOB;
}

/** Per-user kie createTask rate ceiling, images/hour (env KIE_IMAGE_RATE_PER_HOUR,
 *  default 60). */
export function kieImageRatePerHour(): number {
  const raw = Number(process.env.KIE_IMAGE_RATE_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RATE_PER_HOUR;
}

// ── Input cap ────────────────────────────────────────────────────────────────

/** Hard cap on the prompt length sent to kie (defensive; buildKieImagePrompt is
 *  already bounded well under this). */
export const KIE_PROMPT_MAX_CHARS = 2000;

/** Truncate a kie image prompt to KIE_PROMPT_MAX_CHARS. Applied only on the
 *  managed charge path so flag-off/BYOK prompts are untouched. */
export function capKiePrompt(prompt: string): string {
  if (typeof prompt !== "string") return "";
  return prompt.length > KIE_PROMPT_MAX_CHARS ? prompt.slice(0, KIE_PROMPT_MAX_CHARS) : prompt;
}

// ── Per-user sliding-window rate limiter (in-process, single box) ─────────────
//
// The managed-Gemini L2b broad rate-limit was deferred (docs 2026-06-28), so
// there is no shared DB-backed limiter to reuse; this is a minimal in-process
// sliding window in the same spirit. NOTE: state is per Node process — under a
// multi-instance PM2 cluster the effective ceiling is (instances × limit). The
// hard cost bound remains the credit spend + per-job cap; this is burst/loop
// hardening, so a coarse per-process window is acceptable (matches the deferred
// L2b's "single-box" assumption).

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const hits = new Map<string, number[]>();

/**
 * Try to consume one rate slot for `userId`. Returns true if allowed (and records
 * the hit), false if the user has already made `kieImageRatePerHour()` createTask
 * calls in the trailing hour. Synchronous + atomic within the event loop (no await
 * between check and record) so concurrent callers can't both slip past the ceiling.
 */
export function tryConsumeKieImageRate(userId: string, now: number = Date.now()): boolean {
  const limit = kieImageRatePerHour();
  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(userId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit) {
    hits.set(userId, recent);
    return false;
  }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

/** Test-only: clear the in-process rate window (used by verify scripts). */
export function __resetKieImageRateForTest(): void {
  hits.clear();
}
