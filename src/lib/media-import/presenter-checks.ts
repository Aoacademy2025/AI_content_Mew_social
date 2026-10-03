// Presenter clip checks — MCP Media Import only (PR-B, Task 9, G22).
//
// The web upload-avatar route (`/api/videos/upload-avatar/route.ts`) is NOT changed by
// this module (B6): the browser already runs portrait + duration checks before the
// upload there, and upload-avatar itself keeps its own ffprobe/type gate untouched.
//
// An MCP agent uploads or links a HeyGen-rendered presenter clip with no browser in
// front of it, so the same checks the browser would have run must happen server-side
// before the clip is accepted:
//   • type, via the same G24 ffprobe guard as every other upload route
//     (`-protocol_whitelist file` + a pinned demuxer, src/lib/media-probe-args.ts);
//   • portrait orientation (height > width) — mirrors
//     src/lib/video-orientation.ts's isPortraitVideoFile, server-side;
//   • a 4096px dimension cap, the same bomb guard as broll-pipeline.ts;
//   • the plan's duration cap, via the existing `audioDurationLimitViolation` (shared
//     with the TTS/transcribe/MCP duration gates — no new limit is invented here).
//
// This module never re-encodes the file and never touches its audio track (the
// presenter's narration must survive untouched) — it only validates, then moves the
// already-downloaded/uploaded file into the same directory upload-avatar serves from
// (`public/renders/`), under a fresh server-generated name.
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { resolveSafeInputDemuxer } from "@/lib/media-probe-args";
import { ffprobeDimensions, probeDurationMs } from "@/lib/upload-media-probe";
import { audioDurationLimitViolation, type AudioDurationLimitViolation } from "@/lib/plan-limits";
import { moveFile } from "@/lib/safe-download";

// Same extension/MIME allowlist as upload-avatar's isAllowedAvatarVideo.
export const PRESENTER_VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
export const PRESENTER_VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
export const MAX_PRESENTER_DIMENSION_PX = 4096;

export function isAllowedPresenterVideo(ext: string, mime: string): boolean {
  if (!PRESENTER_VIDEO_EXTS.has(ext)) return false;
  if (!mime) return true;
  return PRESENTER_VIDEO_MIMES.has(mime);
}

export type PresenterCheckErrorCode =
  | "unsupported_type"
  | "not_portrait"
  | "too_large_dimensions"
  | "duration_exceeded"
  | "probe_failed";

export type PresenterCheckError = {
  code: PresenterCheckErrorCode;
  message: string;
  durationViolation?: AudioDurationLimitViolation;
};

export type PresenterCheckResult =
  | { ok: true; durationMs: number; width: number; height: number }
  | { ok: false; error: PresenterCheckError };

// Validate an already-downloaded/uploaded file on disk. Does not move or delete it —
// callers (the Media Import worker, Task 12) own cleanup on failure.
export async function runPresenterChecks(params: {
  filePath: string;
  ext: string;
  plan: string;
}): Promise<PresenterCheckResult> {
  const { filePath, ext, plan } = params;

  const inputFormat = resolveSafeInputDemuxer(filePath, ext, "video");
  if (!inputFormat) {
    return {
      ok: false,
      error: { code: "unsupported_type", message: "รองรับเฉพาะไฟล์วิดีโอ mp4 / mov / webm" },
    };
  }

  const dims = ffprobeDimensions(filePath, inputFormat);
  if (!dims) {
    return { ok: false, error: { code: "probe_failed", message: "อ่านข้อมูลวิดีโอไม่สำเร็จ" } };
  }
  if (dims.width > MAX_PRESENTER_DIMENSION_PX || dims.height > MAX_PRESENTER_DIMENSION_PX) {
    return {
      ok: false,
      error: { code: "too_large_dimensions", message: "วิดีโอมีความละเอียดสูงเกินไป (สูงสุด 4096×4096)" },
    };
  }
  if (!(dims.height > dims.width)) {
    return { ok: false, error: { code: "not_portrait", message: "วิดีโอต้องเป็นแนวตั้ง (portrait) เท่านั้น" } };
  }

  const durationMs = await probeDurationMs(filePath, inputFormat);
  if (!durationMs || durationMs <= 0) {
    return { ok: false, error: { code: "probe_failed", message: "อ่านความยาววิดีโอไม่สำเร็จ" } };
  }

  const durationViolation = audioDurationLimitViolation(durationMs, plan);
  if (durationViolation) {
    return {
      ok: false,
      error: {
        code: "duration_exceeded",
        message: `${durationViolation.message} — ${durationViolation.userAction}`,
        durationViolation,
      },
    };
  }

  return { ok: true, durationMs, width: dims.width, height: dims.height };
}

/** Same directory upload-avatar.ts writes to and `/api/renders/<filename>` serves. */
export function presenterUploadDir(): string {
  return path.join(process.cwd(), "public", "renders");
}

export function presenterOutputFilename(ext: string): string {
  return `presenter-import-${Date.now()}-${randomUUID()}.${ext}`;
}

export type PresenterImportResult =
  | { ok: true; src: string; durationMs: number; width: number; height: number }
  | { ok: false; error: PresenterCheckError };

// Run the checks, then — only on success — move the file into upload-avatar's directory
// under a fresh server-generated name (moveFile: rename, or copy+unlink across
// filesystems, src/lib/safe-download.ts). The caller's temp file is gone either way: on
// success it has been moved; on failure it is left in place for the caller to remove.
export async function processPresenterImport(params: {
  tempFilePath: string;
  ext: string;
  plan: string;
}): Promise<PresenterImportResult> {
  const { tempFilePath, ext, plan } = params;
  const checked = await runPresenterChecks({ filePath: tempFilePath, ext, plan });
  if (!checked.ok) return checked;

  const dir = presenterUploadDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = presenterOutputFilename(ext);
  const outPath = path.join(dir, filename);
  moveFile(tempFilePath, outPath);

  return { ok: true, src: `/api/renders/${filename}`, durationMs: checked.durationMs, width: checked.width, height: checked.height };
}
