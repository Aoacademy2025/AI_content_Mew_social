import type { HeyGenAvatarEngine } from "@/lib/heygen-avatar-engine";

export const HEYGEN_V3_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const HEYGEN_V3_MAX_AUDIO_DURATION_MS = 600_000;

const TOO_LONG_MESSAGE =
  "เสียงสำหรับ Avatar รุ่นนี้ต้องยาวไม่เกิน 10 นาที กรุณาเลือกช่วงต้น/ท้ายคลิปหรือใช้เสียงที่สั้นลง";
const TOO_LARGE_MESSAGE =
  "ไฟล์เสียงสำหรับ Avatar ใหญ่เกินขนาดที่ HeyGen รองรับ กรุณาใช้ไฟล์เสียงที่เล็กลง";

type V3Engine = Exclude<HeyGenAvatarEngine, "avatar_iii">;

export function parseFfmpegDurationMs(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

export class HeyGenV3RequestError extends Error {
  constructor(
    public readonly operation: "upload" | "create",
    public readonly status: number,
    public readonly providerCode?: string,
  ) {
    super(`HeyGen v3 ${operation} failed (${status})`);
    this.name = "HeyGenV3RequestError";
  }
}

export function validateHeyGenV3Audio(input: { durationMs: number; sizeBytes: number }): {
  code: "avatar_audio_too_long" | "avatar_audio_too_large";
  message: string;
} | null {
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > HEYGEN_V3_MAX_AUDIO_DURATION_MS) {
    return { code: "avatar_audio_too_long", message: TOO_LONG_MESSAGE };
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > HEYGEN_V3_MAX_AUDIO_BYTES) {
    return { code: "avatar_audio_too_large", message: TOO_LARGE_MESSAGE };
  }
  return null;
}

export function buildHeyGenV3VideoRequest(input: {
  avatarId: string;
  engine: V3Engine;
  audioAssetId: string;
}) {
  return {
    type: "avatar" as const,
    avatar_id: input.avatarId,
    audio_asset_id: input.audioAssetId,
    engine: { type: input.engine },
    resolution: "1080p" as const,
    aspect_ratio: "9:16" as const,
    output_format: "mp4" as const,
    background: { type: "color" as const, value: "#00FF00" },
    fit: "contain" as const,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerCode(value: unknown): string | undefined {
  const body = record(value);
  const error = record(body?.error);
  return typeof error?.code === "string"
    ? error.code.slice(0, 80)
    : typeof body?.code === "string"
      ? body.code.slice(0, 80)
      : undefined;
}

export async function submitHeyGenV3Avatar(input: {
  heygenKey: string;
  avatarId: string;
  engine: V3Engine;
  audioBytes: Uint8Array;
  durationMs: number;
  idempotencyKey: string;
  fetcher?: typeof fetch;
}): Promise<{ videoId: string; audioAssetId: string }> {
  const violation = validateHeyGenV3Audio({
    durationMs: input.durationMs,
    sizeBytes: input.audioBytes.byteLength,
  });
  if (violation) throw Object.assign(new Error(violation.message), violation);

  const fetcher = input.fetcher ?? fetch;
  const form = new FormData();
  const bytes = new Uint8Array(input.audioBytes);
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), "narration.mp3");
  let upload: Response;
  try {
    upload = await fetcher("https://api.heygen.com/v3/assets", {
      method: "POST",
      headers: { "X-Api-Key": input.heygenKey },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    // The paid create has not happened yet, so an upload transport failure is a
    // definitive pre-submission failure rather than an unknown paid outcome.
    throw new HeyGenV3RequestError("upload", 503);
  }
  const uploadBody: unknown = await upload.json().catch(() => null);
  const assetId = record(record(uploadBody)?.data)?.asset_id;
  if (!upload.ok || typeof assetId !== "string" || !assetId) {
    throw new HeyGenV3RequestError("upload", upload.status, providerCode(uploadBody));
  }

  const create = await fetcher("https://api.heygen.com/v3/videos", {
    method: "POST",
    headers: {
      "X-Api-Key": input.heygenKey,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify(buildHeyGenV3VideoRequest({
      avatarId: input.avatarId,
      engine: input.engine,
      audioAssetId: assetId,
    })),
    signal: AbortSignal.timeout(60_000),
  });
  const createBody: unknown = await create.json().catch(() => null);
  const videoId = record(record(createBody)?.data)?.video_id;
  if (!create.ok) {
    if (create.status === 409) throw new Error("HeyGen v3 create is already in progress");
    throw new HeyGenV3RequestError("create", create.status, providerCode(createBody));
  }
  // A successful create response without its provider ID may already have spent the
  // account's credits. Leave it unclassified so the caller parks it for manual recovery.
  if (typeof videoId !== "string" || !videoId) throw new Error("HeyGen v3 create outcome unknown");
  return { videoId, audioAssetId: assetId };
}
