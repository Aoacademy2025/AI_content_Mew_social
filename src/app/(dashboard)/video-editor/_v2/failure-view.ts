/**
 * Render-failure view (Task 5 section C + fast-follow fix) — PURE classification logic
 * (no hooks, no JSX). Kept separate from EditorV2Shell.tsx's "use client" FailedView so
 * it is directly unit-testable (scripts/verify-hero-image-disclosure.ts), mirroring how
 * receipt.ts carries RenderReceiptDialog.tsx's decision logic.
 *
 * The pipeline forwards fetch-stock's JSON `code` verbatim onto VideoJob.errorCode via
 * mcp/orchestrator.ts's pipelineFailureDetails(), so job.errorCode IS that exact string
 * on the normal path — classification matches it EXACTLY, never substring-matches
 * combined code+message text: a prefixed code like OMNIVOICE_PROVIDER_RATE_LIMITED
 * (Hero Voice TTS throttle — a completely different failure, set in
 * hero-voice-generation.server.ts:333) contains "RATE_LIMITED" as a substring and would
 * otherwise wrongly classify a voice failure as the image-generation rate cap.
 * The Thai text fallback stays ONLY for insufficient-credits, covering the one edge path
 * that could carry the message without the code; RATE_LIMITED has no such safe marker.
 */

export type FailureKind = "heygen-quota" | "insufficient-credits" | "rate-limited" | "generic";

export interface FailureJobLike {
  errorCode: string | null;
  errorMessage: string | null;
  errorProvider: string | null;
}

const INSUFFICIENT_CREDITS_CODE = "INSUFFICIENT_CREDITS";
const INSUFFICIENT_CREDITS_TEXT_MARKER = /เครดิตไม่พอ/;
const RATE_LIMITED_CODE = "RATE_LIMITED";

export function classifyFailure(job: FailureJobLike): FailureKind {
  if (job.errorProvider === "heygen" && job.errorCode === "quota") return "heygen-quota";
  const isInsufficientCredits = job.errorCode === INSUFFICIENT_CREDITS_CODE
    || INSUFFICIENT_CREDITS_TEXT_MARKER.test(job.errorMessage ?? "");
  if (isInsufficientCredits) return "insufficient-credits";
  if (job.errorCode === RATE_LIMITED_CODE) return "rate-limited";
  return "generic";
}

export interface FailureViewCopy {
  heading: string;
  body: string;
}

/** exportMode swaps only the generic heading (ส่งออก vs เรนเดอร์); every other copy is fixed. */
export function failureViewCopy(kind: FailureKind, job: FailureJobLike, exportMode: boolean): FailureViewCopy {
  if (kind === "insufficient-credits") {
    return {
      heading: "เครดิต AI ไม่พอ",
      body: "งานนี้ต้องใช้เครดิตมากกว่าที่มีอยู่ ระบบไม่หักเครดิตส่วนที่ไม่สำเร็จ — เติมเครดิตหรือลดจำนวนรูปแล้วลองใหม่",
    };
  }
  if (kind === "rate-limited") {
    return {
      heading: "ถึงเพดานการเจนรูปชั่วคราว",
      // Rate-limit copy is dynamic (retry-after seconds) — always the server's own message.
      body: job.errorMessage ?? "เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง",
    };
  }
  return {
    heading: exportMode ? "ส่งออกไม่สำเร็จ" : "เรนเดอร์ไม่สำเร็จ",
    body: job.errorMessage ?? "เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง",
  };
}
