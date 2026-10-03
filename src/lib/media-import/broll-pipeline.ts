// Shared B-roll upload pipeline (PR-B, Task 9). Extracted from
// /api/videos/broll-window/upload/route.ts so the web route and the future MCP Media
// Import worker (Task 12) share one implementation of:
//   • type / size validation
//   • image (jpg/jpeg/png/webp ≤20MB) → Ken Burns motion clip (5s)
//   • video (mp4/mov/webm ≤200MB)     → Remotion-safe portrait re-encode
// The output is a locally-served `stocks/` mp4, exactly as before.
//
// Behaviour and HTTP responses of the web route are UNCHANGED by this move — see
// scripts/verify-broll-upload-admission.ts (validation precedes admission; admission
// precedes either ffmpeg path) and scripts/verify-upload-probe-whitelist.ts (route/
// pipeline source checks) plus scripts/verify-media-import-broll-pipeline.ts (new unit
// tests for this module).
//
// Security notes (this module runs ffmpeg on user-supplied bytes):
//   • Extension AND MIME are both checked against fixed allowlists BEFORE any ffmpeg
//     touches the file; a mismatch (ext says image, mime says video) → unsupported_type.
//   • The output filename is server-generated only (Date.now()+randomUUID) — no path
//     component is ever derived from the client filename, so a hostile name like
//     "../../etc/x" can't escape the stocks dir.
//   • Every ffprobe/ffmpeg run on the upload pins `-protocol_whitelist file` and an
//     allowlisted input demuxer (G24, src/lib/media-probe-args.ts), so a playlist
//     renamed to .mp4/.jpg can't make ffmpeg open other local files or URLs.
import path from "path";
import os from "os";
import fs from "fs";
import { randomUUID } from "crypto";
import {
  applyKenBurns,
  normalizeForRemotion,
  normalizedMarkerPath,
  isValidMp4Path,
  safeUnlink,
  KEN_BURNS_DURATION_SEC,
} from "@/lib/broll-asset-lib";
import { resolveSafeInputDemuxer } from "@/lib/media-probe-args";
import { ffprobeDimensions, ffprobeDurationSec } from "@/lib/upload-media-probe";

export type BrollUploadKind = "image" | "video";

export const BROLL_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
export const BROLL_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
// Same video list/mime mapping as /api/videos/upload-avatar's isAllowedAvatarVideo.
export const BROLL_VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
export const BROLL_VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export const MAX_BROLL_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_BROLL_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB

// ffprobeDimensions / ffprobeDurationSec live in src/lib/upload-media-probe.ts (shared
// with upload-avatar and the G24 test). ffprobeDimensions is the metadata-only bomb guard
// that bounds pixel dimensions BEFORE applyKenBurns / normalizeForRemotion decode anything.
export const MAX_BROLL_DIMENSION_PX = 4096;

export function brollFileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// Decide image vs video from the (client-supplied) extension + MIME. Requires the ext
// to be in an allowlist AND the MIME to either agree with it or be empty (some browsers
// send no type for e.g. .mov). An ext/MIME disagreement (ext=jpg, mime=video/mp4) falls
// through to null, so a mislabelled file can't be routed to the wrong ffmpeg path.
export function detectBrollKind(ext: string, mime: string): BrollUploadKind | null {
  const mimeOk = (allow: Set<string>) => mime === "" || allow.has(mime);
  if (BROLL_IMAGE_EXTS.has(ext) && mimeOk(BROLL_IMAGE_MIMES)) return "image";
  if (BROLL_VIDEO_EXTS.has(ext) && mimeOk(BROLL_VIDEO_MIMES)) return "video";
  return null;
}

export type BrollValidationError = { error: string; message: string; status: number };

export type BrollValidationResult =
  | { ok: true; kind: BrollUploadKind; ext: string }
  | { ok: false; error: BrollValidationError };

// Type/size checks only — no disk or ffmpeg access, same order as the original inline
// route code. Kept ahead of admission on purpose: a validation failure must never consume
// a user's upload admission slot (scripts/verify-broll-upload-admission.ts).
export function validateBrollUpload(file: File): BrollValidationResult {
  const ext = brollFileExt(file.name);
  const mime = file.type || "";
  const kind = detectBrollKind(ext, mime);
  if (!kind) {
    return {
      ok: false,
      error: {
        error: "unsupported_type",
        message: "รองรับเฉพาะรูป (jpg/png/webp) หรือวิดีโอ (mp4/mov/webm)",
        status: 415,
      },
    };
  }

  if (file.size <= 0) {
    return { ok: false, error: { error: "empty_file", message: "ไฟล์ว่างหรืออ่านไม่ได้", status: 400 } };
  }

  const maxBytes = kind === "image" ? MAX_BROLL_IMAGE_BYTES : MAX_BROLL_VIDEO_BYTES;
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: {
        error: "payload_too_large",
        message: kind === "image" ? "รูปใหญ่เกิน 20 MB" : "วิดีโอใหญ่เกิน 200 MB",
        status: 413,
      },
    };
  }

  return { ok: true, kind, ext };
}

// Stream a web File to disk (mirrors /api/videos/upload-avatar's pump loop) with
// backpressure — never buffers the whole file a second time in memory.
async function streamToFile(file: File, outPath: string): Promise<void> {
  const stream = fs.createWriteStream(outPath);
  const reader = file.stream().getReader();
  await new Promise<void>((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            stream.end();
            break;
          }
          if (!stream.write(value)) {
            await new Promise<void>((r) => stream.once("drain", r));
          }
        }
      } catch (error) {
        stream.destroy(error instanceof Error ? error : undefined);
        reject(error);
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    };
    void pump();
  });
}

export type BrollPipelineError = { error: string; message: string; status: number };
export type BrollPipelineSuccess = { src: string; clipDuration: number };
export type BrollPipelineResult =
  | { ok: true; value: BrollPipelineSuccess }
  | { ok: false; value: BrollPipelineError };

// Everything after validation + admission: server-named output, the G24 ffprobe guard,
// the 4096px bomb guard, and Ken Burns / normalizeForRemotion. Caller owns admission
// acquire/release; this function owns tempInput/outPath cleanup on every exit path.
export async function runBrollPipeline(params: {
  file: File;
  kind: BrollUploadKind;
  ext: string;
  stocksDir: string;
}): Promise<BrollPipelineResult> {
  const { file, kind, ext, stocksDir } = params;

  // Output name is 100% server-generated — the client filename never contributes a path
  // component. The `/api/stocks/[filename]` route only serves flat basenames, so this
  // stays inside the stocks dir.
  const outFile = `broll-upload-${Date.now()}-${randomUUID()}.mp4`;
  const outPath = path.join(stocksDir, outFile);

  // Only images use a scratch temp input (Ken Burns reads it, writes a fresh mp4). Videos
  // stream straight to the stocks output path and are normalized in place (like /select).
  let tempInput: string | null = null;

  try {
    fs.mkdirSync(stocksDir, { recursive: true });
    if (kind === "image") {
      tempInput = path.join(os.tmpdir(), `broll-upload-input-${Date.now()}-${randomUUID()}.${ext}`);
      await streamToFile(file, tempInput);
      if (!fs.existsSync(tempInput) || fs.statSync(tempInput).size <= 0) {
        return { ok: false, value: { error: "empty_file", message: "ไฟล์ว่างหรืออ่านไม่ได้", status: 400 } };
      }

      // Metadata-only probe BEFORE Ken Burns ever decodes the file — bounds pixel
      // dimensions so a small-byte-size decompression bomb can't force a multi-GB decode.
      // The same pinned demuxer is used for the probe and the Ken Burns decode.
      const inputFormat = resolveSafeInputDemuxer(tempInput, ext, "image");
      const imgDims = inputFormat ? ffprobeDimensions(tempInput, inputFormat) : null;
      if (!inputFormat || !imgDims || imgDims.width > MAX_BROLL_DIMENSION_PX || imgDims.height > MAX_BROLL_DIMENSION_PX) {
        safeUnlink(tempInput);
        return {
          ok: false,
          value: { error: "unsupported_type", message: "ไฟล์มีความละเอียดสูงเกินไป (สูงสุด 4096×4096)", status: 415 },
        };
      }

      // Still image → 5s vertical Ken Burns motion clip (throws if ffmpeg output is bad).
      await applyKenBurns(tempInput, outPath, KEN_BURNS_DURATION_SEC, { inputFormat });
      if (!isValidMp4Path(outPath)) {
        safeUnlink(outPath);
        return { ok: false, value: { error: "process_failed", message: "แปลงรูปเป็นวิดีโอไม่สำเร็จ", status: 502 } };
      }

      return { ok: true, value: { src: `/api/stocks/${outFile}`, clipDuration: KEN_BURNS_DURATION_SEC } };
    }

    // kind === "video": stream to the stocks output path, then re-encode Remotion-safe.
    // 9:16 handling is intentionally identical to every stock/AI b-roll clip:
    // normalizeForRemotion scales into a 1080×1920 box and the renderer applies
    // objectFit:"cover" (ShortVideoComposition) — there is no separate crop-to-fill step
    // anywhere in the pipeline.
    await streamToFile(file, outPath);
    if (!isValidMp4Path(outPath)) {
      safeUnlink(outPath);
      return { ok: false, value: { error: "empty_file", message: "ไฟล์วิดีโอว่างหรืออ่านไม่ได้", status: 400 } };
    }

    // Metadata-only probe BEFORE normalizeForRemotion decodes the file — same bomb guard
    // as the image path. normalizeForRemotion also runs behind the process-wide normalize
    // semaphore shared with all b-roll processing, so an oversized decode here would stall
    // every other user's b-roll, not just this request.
    const inputFormat = resolveSafeInputDemuxer(outPath, ext, "video");
    const vidDims = inputFormat ? ffprobeDimensions(outPath, inputFormat) : null;
    if (!inputFormat || !vidDims || vidDims.width > MAX_BROLL_DIMENSION_PX || vidDims.height > MAX_BROLL_DIMENSION_PX) {
      safeUnlink(outPath);
      return {
        ok: false,
        value: { error: "unsupported_type", message: "ไฟล์มีความละเอียดสูงเกินไป (สูงสุด 4096×4096)", status: 415 },
      };
    }

    const normalizeResult = await normalizeForRemotion(outPath, { inputFormat });
    if (normalizeResult.status === "failed") {
      safeUnlink(outPath);
      safeUnlink(normalizedMarkerPath(outPath));
      return { ok: false, value: { error: "normalize_failed", message: "แปลงไฟล์วิดีโอไม่สำเร็จ", status: 502 } };
    }

    // outPath now holds our own libx264 mp4 (normalizeForRemotion swapped it in).
    const clipDuration = ffprobeDurationSec(outPath, "mov");
    if (!clipDuration || clipDuration <= 0) {
      // Encoded fine but we couldn't measure it — fail closed rather than hand back a
      // clip the editor can't safely trim. Output name is random (no cache reuse), so
      // drop the unusable file instead of leaving an orphan in stocks/.
      safeUnlink(outPath);
      safeUnlink(normalizedMarkerPath(outPath));
      return { ok: false, value: { error: "probe_failed", message: "อ่านความยาววิดีโอไม่สำเร็จ", status: 502 } };
    }

    return { ok: true, value: { src: `/api/stocks/${outFile}`, clipDuration } };
  } catch (e) {
    safeUnlink(outPath);
    safeUnlink(normalizedMarkerPath(outPath));
    console.error("[broll-pipeline] failed:", e);
    return {
      ok: false,
      value: { error: "upload_failed", message: "อัปโหลดสื่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", status: 500 },
    };
  } finally {
    if (tempInput) safeUnlink(tempInput);
  }
}
