import type { AiImageStyle } from "@/lib/ai-image-policy";
import {
  normalizeBrollVisualStyle,
  type BrollVisualStyle,
} from "@/lib/broll-preferences";
import { planHeroAiWindowGeneration } from "@/lib/hero-ai-broll";

const VIDEO_JOB_ID = /^[A-Za-z0-9_-]{8,120}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type HeroBrollWindowRequest = {
  requestId: string;
  videoJobId: string;
  sceneIndex: number;
  durationSec: number;
  kenBurnsDurationSec: number;
  idempotencyKey: string;
};

export type HeroBrollWindowRequestResult =
  | { ok: true; value: HeroBrollWindowRequest }
  | { ok: false; error: string; message: string };

export function heroImageStyleForBrollWindow(raw: unknown): AiImageStyle {
  switch (normalizeBrollVisualStyle(raw)) {
    case "cinematic": return "cinematic";
    case "surreal": return "illustration";
    case "business":
    case "tech":
    case "minimal": return "editorial";
    case "documentary":
    case "lifestyle":
    default: return "photoreal";
  }
}

/** Validate the browser contract before ownership checks or credit reservation. */
export function parseHeroBrollWindowRequest(body: unknown): HeroBrollWindowRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_body", message: "ข้อมูลคำขอไม่ถูกต้อง" };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) {
    return { ok: false, error: "invalid_request_id", message: "ไม่พบรหัสยืนยันคำขอ กรุณาลองใหม่" };
  }
  if (typeof raw.videoJobId !== "string" || !VIDEO_JOB_ID.test(raw.videoJobId)) {
    return { ok: false, error: "invalid_video_job", message: "ไม่พบวิดีโอต้นฉบับ" };
  }
  if (!Number.isInteger(raw.sceneIndex) || Number(raw.sceneIndex) < 0 || Number(raw.sceneIndex) > 10_000) {
    return { ok: false, error: "invalid_scene", message: "ตำแหน่ง B-roll ไม่ถูกต้อง" };
  }
  if (typeof raw.durationSec !== "number" || !Number.isFinite(raw.durationSec) || raw.durationSec <= 0) {
    return { ok: false, error: "invalid_duration", message: "ระยะเวลา B-roll ไม่ถูกต้อง" };
  }
  const sceneIndex = Number(raw.sceneIndex);
  const durationSec = Math.min(600, raw.durationSec);
  const kenBurnsDurationSec = planHeroAiWindowGeneration(
    [`scene-${sceneIndex}`],
    [durationSec],
  )[0].kenBurnsDurationSec;
  return {
    ok: true,
    value: {
      requestId: raw.requestId,
      videoJobId: raw.videoJobId,
      sceneIndex,
      durationSec,
      kenBurnsDurationSec,
      idempotencyKey: `broll-window:${raw.videoJobId}:scene:${sceneIndex}:request:${raw.requestId}`,
    },
  };
}
