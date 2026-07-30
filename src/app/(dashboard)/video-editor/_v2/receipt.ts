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
  /** Credits already removed from the available balance for provider/render work in flight. */
  reservedCredits?: number;
  /** Credits charged per render minute when the package cannot fund the whole job. */
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

export type ReceiptLineKind = "info" | "success" | "warn";
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
  /** Credits charged when the whole render falls back from minutes to credits. */
  overflowCredits: number;
  /** Hero credits estimated for this job: AI images + a credit-funded render. */
  totalEstimatedCredits: number;
  lines: ReceiptLine[];
}

function formatCredits(value: number): string {
  return value.toLocaleString("en-US");
}

/** Build the receipt model: computed numbers + the exact set of lines to render. */
export function buildReceipt(input: ReceiptInput): ReceiptModel {
  const {
    estSec, remainingMinutes, totalMinutes, usesAi, presetWeights,
    perImageCredits, creditBalance, reservedCredits = 0, minuteCreditRate, hasAvatar, exactDuration = false,
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
  // reserveMinutesOrCredits is deliberately all-or-nothing: when the remaining
  // package minutes cannot cover the whole render, it leaves those minutes
  // untouched and funds the whole render with credits.
  const overflowCredits = overflowMinutes > 0 ? estMinutes * minuteCreditRate : 0;
  // Support-ticket invariant: sufficiency must cover the whole job estimate, not
  // only AI images. Otherwise a user can have enough for every image but fail at
  // the later render-overflow reservation.
  const totalEstimatedCredits = estCredits + overflowCredits;

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
        ? `ภาพ AI: ${estCredits} เครดิต (${manualAiImageCount} ภาพ × ${perImageCredits} เครดิต) · ระบบกันเครดิตก่อนส่งแต่ละภาพ และคืนอัตโนมัติหากเจนไม่สำเร็จ`
        : `ภาพ AI (ประมาณ): ~${estCredits} เครดิต · ระบบกันเครดิตก่อนส่งแต่ละภาพ และคืนอัตโนมัติหากเจนไม่สำเร็จ`,
    });
  }

  // 3) Overflow warning — package minutes not enough (X > Y).
  if (overflowMinutes > 0) {
    lines.push({
      key: "overflow",
      // Running out of package minutes is not an error when Hero credits cover
      // the job. The combined balance status below owns success/error styling.
      kind: "info",
      text: `นาทีในแพ็กเกจเหลือ ${remainingMinutes} นาที ไม่พอสำหรับงาน ~${estMinutes} นาที — งานนี้จึงใช้ Hero credits ทั้งหมด ${overflowCredits} เครดิต (${minuteCreditRate} เครดิต/นาที) และจะไม่หักนาทีแพ็กเกจ`,
    });
  }

  // 4) Hero-credit summary — make the three different quota systems legible:
  //    package minutes above, Hero credits here, and HeyGen's own key below.
  //    The combined check includes BOTH AI-image and credit-funded render spend.
  if (creditBalance != null && totalEstimatedCredits > 0 && totalEstimatedCredits <= creditBalance) {
    const reserved = reservedCredits > 0
      ? ` · มี ${formatCredits(reservedCredits)} เครดิตกำลังกันไว้กับงานอื่น`
      : "";
    lines.push({
      key: "credits",
      kind: "success",
      text: `พร้อมสร้าง · Hero credits พร้อมใช้ ${formatCredits(creditBalance)}${reserved} · วงเงินประเมินสำหรับงานนี้ ${formatCredits(totalEstimatedCredits)} · หากใช้ตามประมาณการจะเหลือ ${formatCredits(creditBalance - totalEstimatedCredits)}`,
    });
  } else if (creditBalance != null && totalEstimatedCredits > creditBalance) {
    const deficit = totalEstimatedCredits - creditBalance;
    const recovery = usesAi
      ? insufficientCreditBehavior === "block"
        ? "เติมเครดิตหรือลดจำนวนภาพก่อนเริ่มงาน"
        : "เติมเครดิต หรือลดจำนวนภาพ/เลือกฟรีล้วนก่อนเริ่มงาน"
      : "เติมเครดิตหรือลดความยาวก่อนเริ่มงาน";
    lines.push({
      key: "insufficient",
      kind: "warn",
      text: `Hero credits ไม่พอ · พร้อมใช้ ${formatCredits(creditBalance)} · วงเงินประเมินสำหรับงานนี้ ${formatCredits(totalEstimatedCredits)} · ขาดประมาณ ${formatCredits(deficit)} — ${recovery}`,
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
      ? "ความยาวคลิปคำนวณจากไฟล์ที่อัปโหลดจริง · เมื่อระบบยืนยันว่าเจนภาพหรือคลิปล้มเหลว จะคืนเครดิตอัตโนมัติ"
      : "ตัวเลขเป็นประมาณการ — จำนวนภาพและยอดเรนเดอร์จริงคำนวณหลังสร้างเสียง · เมื่อระบบยืนยันว่าเจนภาพหรือคลิปล้มเหลว จะคืนเครดิตอัตโนมัติ",
  });

  return { estMinutes, estCredits, overflowMinutes, overflowCredits, totalEstimatedCredits, lines };
}
