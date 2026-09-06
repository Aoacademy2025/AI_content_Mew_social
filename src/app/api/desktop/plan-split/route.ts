import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { tryConsumeDesktopPlanRate } from "@/lib/desktop/plan-rate-limit";
import { planSplitSegments } from "@/lib/desktop/plan-model";
import type { TranscriptSegment } from "@/lib/desktop/types";
import { KeyRequiredError } from "@/lib/gemini-key";

export const runtime = "nodejs";
export const maxDuration = 120;

function desktopError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ code, message, ...extra }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(body: unknown): { footageId: string; durationSec: number; transcript: TranscriptSegment[] } | string {
  if (!isRecord(body)) return "ต้องส่ง JSON ของคำขอแตกคลิป";
  const footageId = typeof body.footageId === "string" ? body.footageId.trim() : "";
  if (!footageId) return "ต้องระบุ footageId";
  const durationSec = typeof body.durationSec === "number" ? body.durationSec : NaN;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return "durationSec ต้องเป็นจำนวนวินาทีที่มากกว่า 0";
  if (!Array.isArray(body.transcript)) return "ต้องส่ง transcript เป็นอาร์เรย์ของเซ็กเมนต์";
  const transcript: TranscriptSegment[] = [];
  for (const item of body.transcript) {
    if (!isRecord(item) || typeof item.text !== "string") return "ทรานสคริปต์ไม่ถูกต้อง";
    if (typeof item.start !== "number" || typeof item.end !== "number") return "ทรานสคริปต์ต้องมี start และ end เป็นวินาที";
    transcript.push({ text: item.text, start: item.start, end: item.end });
  }
  return { footageId, durationSec, transcript };
}

export const POST = withDesktop(async (req, principal) => {
  const rate = tryConsumeDesktopPlanRate(principal.userId);
  if (!rate.allowed) {
    return desktopError(429, "RATE_LIMITED", rate.message ?? "วางแผนเวอร์ชันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return desktopError(400, "INVALID_REQUEST", "อ่าน JSON ไม่สำเร็จ — ส่งคำขอใหม่แล้วลองอีกครั้ง");
  }

  const parsed = parseRequest(body);
  if (typeof parsed === "string") {
    return desktopError(400, "INVALID_REQUEST", parsed);
  }

  try {
    const result = await planSplitSegments(principal.userId, principal.user, parsed);
    if (!result.ok) {
      if (result.error.kind === "quota") {
        return desktopError(402, "AI_TEXT_QUOTA", result.error.message, { remaining: result.error.remaining });
      }
      return desktopError(502, "PLAN_FAILED", "วางแผนแตกคลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
    return NextResponse.json({ segments: result.segments });
  } catch (error) {
    if (error instanceof KeyRequiredError) {
      return desktopError(409, "KEY_REQUIRED", "ตั้งค่าคีย์ AI ของระบบก่อนใช้วางแผนแตกคลิป");
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[desktop/plan-split] PLAN_FAILED", { detail: detail.slice(0, 200) });
    return desktopError(502, "PLAN_FAILED", "วางแผนแตกคลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
});
