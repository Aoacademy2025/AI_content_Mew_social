/**
 * Render Receipt (D5) — PURE decision logic (no hooks, no prisma, no fetch).
 *
 * Given the current project estimate + the user's minute/credit quota, decides WHICH
 * receipt lines show and computes the interpolated numbers (X minutes, N credits,
 * M overflow minutes). Kept pure so it is unit-testable (scripts/verify-render-receipt.ts)
 * and can't drift from the real charge model: it reuses `minutesFromSeconds` (server's
 * minute rounding) and `estimatePresetCredits` (the window planner's credit math).
 *
 * Copy is production-exact (task-5 brief); {placeholders} become the computed values.
 * Server behaviour is unchanged — this is a disclosure layer over the existing
 * overflow auto-spend (minute-credits.ts) and the post-render fireCreditReceipt toast.
 */

import { minutesFromSeconds } from "@/lib/minute-round";
import { planAutoMixSources } from "@/lib/automix-plan";
import { estimatePresetCredits } from "./estimate";

export interface ReceiptInput {
  /** Estimated clip length in seconds (estimateClipSecV2(script)). */
  estSec: number;
  /** Minute quota from /api/videos/usage → usage.minutes. null when unavailable. */
  remainingMinutes: number | null;
  totalMinutes: number | null;
  /** True when the b-roll config uses AI images (preset ≠ ฟรีล้วน / admin AI source). */
  usesAi: boolean;
  /** AutoMix weights {video,photo,ai} the render will use (drives the AI credit share). */
  presetWeights: { video: number; photo: number; ai: number };
  /** Credits per generated AI image for the selected kie model (creditCostFor). */
  perImageCredits: number;
  /** Credit balance from /api/credits/balance → total. null when unknown (still loading). */
  creditBalance: number | null;
  /** Credits charged per overflow minute (creditCostFor("minute") = 2). */
  minuteCreditRate: number;
  /** True when a HeyGen avatar is on (avatar mode ≠ none). */
  hasAvatar: boolean;
  /** True when estSec is an actual uploaded-media duration, not a script estimate. */
  exactDuration?: boolean;
  /** Hero AI Image blocks before generation; AutoMix may keep its stock fallback. */
  insufficientCreditBehavior?: "stock-fallback" | "block";
  /** Explicit B-roll count. When set, the backend plans exactly this many source slots. */
  targetClipCount?: number;
}

export type ReceiptLineKind = "info" | "warn";
export interface ReceiptLine {
  key: string;
  kind: ReceiptLineKind;
  text: string;
}

export interface ReceiptModel {
  /** X — estimated minutes this render will consume. */
  estMinutes: number;
  /** N — estimated AI image credits (0 when !usesAi). */
  estCredits: number;
  /** M — minutes over the package (0 when within package or quota unknown). */
  overflowMinutes: number;
  lines: ReceiptLine[];
}

/** Build the receipt model: computed numbers + the exact set of lines to render. */
export function buildReceipt(input: ReceiptInput): ReceiptModel {
  const {
    estSec, remainingMinutes, totalMinutes, usesAi, presetWeights,
    perImageCredits, creditBalance, minuteCreditRate, hasAvatar, exactDuration = false,
    insufficientCreditBehavior = "stock-fallback", targetClipCount = 0,
  } = input;

  const estMinutes = minutesFromSeconds(estSec);
  const manualPieceCount = Number.isFinite(targetClipCount) && targetClipCount > 0
    ? Math.min(60, Math.floor(targetClipCount))
    : 0;
  const manualAiImageCount = manualPieceCount > 0
    ? planAutoMixSources(manualPieceCount, presetWeights).filter((source) => source === "ai").length
    : null;
  const estCredits = usesAi
    ? manualAiImageCount != null
      ? manualAiImageCount * perImageCredits
      : estimatePresetCredits(estSec, presetWeights, perImageCredits)
    : 0;

  const haveMinuteQuota = remainingMinutes != null && totalMinutes != null;
  // M — only meaningful when we know the remaining package minutes.
  const overflowMinutes = haveMinuteQuota
    ? Math.max(0, estMinutes - remainingMinutes!)
    : 0;

  const lines: ReceiptLine[] = [];

  // 1) Minutes line — ALWAYS. Full copy when the package quota is known; graceful
  //    fallback (estimate only) when the usage endpoint didn't surface minutes.
  lines.push({
    key: "minutes",
    kind: "info",
    text: haveMinuteQuota
      ? `นาทีที่จะใช้${exactDuration ? "" : " (ประมาณ)"}: ${estMinutes} นาที — รวมในแพ็กเกจ (เหลือ ${remainingMinutes} จาก ${totalMinutes} นาที)`
      : `นาทีที่จะใช้${exactDuration ? "" : " (ประมาณ)"}: ${estMinutes} นาที — รวมในแพ็กเกจ`,
  });

  // 2) AI credit line — hidden when preset = ฟรีล้วน (no AI images).
  if (usesAi) {
    lines.push({
      key: "ai",
      kind: "info",
      text: manualAiImageCount != null
        ? `ภาพ AI: ${estCredits} เครดิต (${manualAiImageCount} ภาพ × ${perImageCredits} เครดิต) · หักเมื่อเจนสำเร็จ`
        : `ภาพ AI (ประมาณ): ~${estCredits} เครดิต · หักตามจำนวนที่เจนสำเร็จจริง`,
    });
  }

  // 3) Overflow warning — package minutes not enough (X > Y).
  if (overflowMinutes > 0) {
    lines.push({
      key: "overflow",
      kind: "warn",
      text: `นาทีในแพ็กเกจไม่พอ — ส่วนที่เกิน ~${overflowMinutes} นาที จะหักเครดิต ${overflowMinutes * minuteCreditRate} เครดิต (${minuteCreditRate} เครดิต/นาที)`,
    });
  }

  // 4) Insufficient-credit warning — the AI image estimate exceeds the balance
  //    (server then falls back to stock for the windows where credits run out).
  if (usesAi && creditBalance != null && estCredits > creditBalance) {
    lines.push({
      key: "insufficient",
      kind: "warn",
      text: insufficientCreditBehavior === "block"
        ? "เครดิตอาจไม่พอ — Hero AI Image จะไม่เริ่มงานจนกว่าเครดิตจะพอครบทุกฉาก"
        : "เครดิตอาจไม่พอ — ระบบจะใช้ภาพสต็อกแทนช่วงที่เครดิตหมด",
    });
  }

  // 5) Avatar line — HeyGen billed via the user's own key (no extra credits/minutes).
  if (hasAvatar) {
    lines.push({
      key: "avatar",
      kind: "info",
      text: "อวตาร HeyGen: คิดค่าใช้จ่ายผ่านคีย์ HeyGen ของคุณ (ไม่หักเครดิต/นาทีเพิ่ม)",
    });
  }

  // 6) Disclaimer — ALWAYS.
  lines.push({
    key: "disclaimer",
    kind: "info",
    text: exactDuration
      ? "ความยาวคลิปคำนวณจากไฟล์ที่อัปโหลดจริง"
      : "ตัวเลขเป็นประมาณการ — ยอดจริงคำนวณจากความยาวเสียงจริงหลังสร้างเสียง",
  });

  return { estMinutes, estCredits, overflowMinutes, lines };
}
