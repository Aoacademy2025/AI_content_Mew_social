import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { tryConsumeDesktopPlanRate } from "@/lib/desktop/plan-rate-limit";
import { planCombineVersions } from "@/lib/desktop/plan-model";
import type { PlanVersionsRequest, TalkingInput, TranscriptSegment, VersionPlan } from "@/lib/desktop/types";
import { KeyRequiredError } from "@/lib/gemini-key";

export const runtime = "nodejs";
export const maxDuration = 120;

function desktopError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ code, message, ...extra }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSegments(value: unknown): TranscriptSegment[] | null {
  if (!Array.isArray(value)) return null;
  const out: TranscriptSegment[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string") return null;
    if (typeof item.start !== "number" || typeof item.end !== "number") return null;
    out.push({ text: item.text, start: item.start, end: item.end });
  }
  return out;
}

function parseTalking(value: unknown): TalkingInput[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: TalkingInput[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.footageId !== "string" || !item.footageId.trim()) return null;
    if (typeof item.durationSec !== "number" || !Number.isFinite(item.durationSec) || item.durationSec <= 0) return null;
    const transcript = parseSegments(item.transcript);
    if (!transcript) return null;
    out.push({ footageId: item.footageId.trim(), durationSec: item.durationSec, transcript });
  }
  return out;
}

function parseExisting(value: unknown): VersionPlan[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: VersionPlan[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.sequence) || !item.sequence.every((id) => typeof id === "string")) continue;
    if (typeof item.headline !== "string" || typeof item.caption !== "string") continue;
    out.push({
      index: typeof item.index === "number" ? item.index : out.length,
      sequence: item.sequence,
      overlays: [],
      headline: item.headline,
      caption: item.caption,
      distinctness: item.distinctness === "สูง" || item.distinctness === "กลาง" || item.distinctness === "ต่ำ"
        ? item.distinctness
        : "กลาง",
      rationale: typeof item.rationale === "string" ? item.rationale : "",
    });
  }
  return out;
}

function parseRequest(body: unknown): PlanVersionsRequest | string {
  if (!isRecord(body)) return "ต้องส่ง JSON ของคำขอวางแผนเวอร์ชัน";
  const product = isRecord(body.product) ? body.product : null;
  if (!product || typeof product.name !== "string") return "ต้องระบุสินค้า (product.name)";
  const talking = parseTalking(body.talking);
  if (!talking) return "ต้องส่ง talking เป็นฟุตพูดอย่างน้อย 1 คลิปพร้อมทรานสคริปต์";
  if (!Array.isArray(body.productFootage)) return "ต้องส่ง productFootage เป็นอาร์เรย์";
  const productFootage: { footageId: string; durationSec: number }[] = [];
  for (const item of body.productFootage) {
    if (!isRecord(item) || typeof item.footageId !== "string") return "productFootage ไม่ถูกต้อง";
    if (typeof item.durationSec !== "number" || !Number.isFinite(item.durationSec)) return "productFootage.durationSec ไม่ถูกต้อง";
    productFootage.push({ footageId: item.footageId, durationSec: item.durationSec });
  }
  const style = body.style;
  if (style !== "sunrise" && style !== "ocean" && style !== "mono") return "style ต้องเป็น sunrise, ocean หรือ mono";
  const n = typeof body.n === "number" && Number.isFinite(body.n) ? body.n : NaN;
  if (!Number.isFinite(n)) return "n ต้องเป็นจำนวนเวอร์ชันที่ต้องการ";
  const savedHeadlines = Array.isArray(product.savedHeadlines)
    ? product.savedHeadlines.filter((h): h is string => typeof h === "string")
    : [];
  return {
    product: {
      name: product.name,
      description: typeof product.description === "string" ? product.description : "",
      savedHeadlines,
    },
    talking,
    productFootage,
    n,
    style,
    existing: parseExisting(body.existing),
    regenerateIndex: typeof body.regenerateIndex === "number" ? body.regenerateIndex : undefined,
  };
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
    const result = await planCombineVersions(principal.userId, principal.user, parsed);
    if (!result.ok) {
      if (result.error.kind === "quota") {
        return desktopError(402, "AI_TEXT_QUOTA", result.error.message, { remaining: result.error.remaining });
      }
      if (result.error.kind === "no_set") {
        return desktopError(409, "NO_DISTINCT_SET", "ไม่มีชุดฟุตพูดที่ต่างจากเวอร์ชันที่มีอยู่ — ถ่ายฟุตพูดเพิ่มหรือลดจำนวนเวอร์ชัน");
      }
      if (result.error.kind === "invalid") {
        return desktopError(422, "PLAN_INVALID", "AI ส่งแผนที่ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง");
      }
      return desktopError(502, "PLAN_FAILED", "วางแผนเวอร์ชันไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    }
    return NextResponse.json({
      maxVersions: result.maxVersions,
      ...(result.clampedReason ? { clampedReason: result.clampedReason } : {}),
      versions: result.versions,
    });
  } catch (error) {
    if (error instanceof KeyRequiredError) {
      return desktopError(409, "KEY_REQUIRED", "ตั้งค่าคีย์ AI ของระบบก่อนใช้วางแผนเวอร์ชัน");
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[desktop/plan-versions] PLAN_FAILED", { detail: detail.slice(0, 200) });
    return desktopError(502, "PLAN_FAILED", "วางแผนเวอร์ชันไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
});
