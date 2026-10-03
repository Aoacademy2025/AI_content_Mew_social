import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs";
import { randomUUID } from "crypto";
import { getCurrentUser } from "@/lib/clerk-auth";
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
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import {
  brollUploadAdmission,
  brollUploadAdmissionMessage,
} from "@/lib/broll-upload-admission";

// POST /api/videos/broll-window/upload — Phase 2 "อัปโหลดเอง" tab (Task 8).
// User supplies their own media to replace one b-roll window:
//   • image (jpg/jpeg/png/webp ≤20MB) → Ken Burns motion clip (5s)
//   • video (mp4/mov/webm ≤200MB)     → Remotion-safe portrait re-encode
// The output is a locally-served `stocks/` mp4 the editor drops straight into the
// window's `bgVideos[]` entry. Internal AI testers receive the beta before the
// NEXT_PUBLIC_BROLL_WINDOW_EDIT public rollout, matching the sibling routes.
//
// Security notes (this route runs ffmpeg on user-supplied bytes):
//   • Extension AND MIME are both checked against fixed allowlists BEFORE any ffmpeg
//     touches the file; a mismatch (ext says image, mime says video) → 415.
//   • The output filename is server-generated only (Date.now()+randomUUID) — no path
//     component is ever derived from the client filename, so a hostile name like
//     "../../etc/x" can't escape the stocks dir.
//   • Size is capped by an early content-length precheck (DoS guard) + a per-type
//     file.size check, mirroring /api/videos/upload-avatar.
//   • Every ffprobe/ffmpeg run on the upload pins `-protocol_whitelist file` and an
//     allowlisted input demuxer (G24, src/lib/media-probe-args.ts), so a playlist
//     renamed to .mp4/.jpg can't make ffmpeg open other local files or URLs.

export const runtime = "nodejs";
export const maxDuration = 600; // 10 min — large video uploads legitimately take minutes to re-encode

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
// Same video list/mime mapping as /api/videos/upload-avatar's isAllowedAvatarVideo.
const VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_FORM_OVERHEAD_BYTES = 10 * 1024 * 1024; // multipart headers / form fields

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// Decide image vs video from the (client-supplied) extension + MIME. Requires the ext
// to be in an allowlist AND the MIME to either agree with it or be empty (some browsers
// send no type for e.g. .mov). An ext/MIME disagreement (ext=jpg, mime=video/mp4) falls
// through to null → 415, so a mislabelled file can't be routed to the wrong ffmpeg path.
function detectKind(ext: string, mime: string): "image" | "video" | null {
  const mimeOk = (allow: Set<string>) => mime === "" || allow.has(mime);
  if (IMAGE_EXTS.has(ext) && mimeOk(IMAGE_MIMES)) return "image";
  if (VIDEO_EXTS.has(ext) && mimeOk(VIDEO_MIMES)) return "video";
  return null;
}

// ffprobeDimensions / ffprobeDurationSec live in src/lib/upload-media-probe.ts (shared
// with upload-avatar and the G24 test). ffprobeDimensions is the metadata-only bomb guard
// that bounds pixel dimensions BEFORE applyKenBurns / normalizeForRemotion decode anything.
const MAX_DIMENSION_PX = 4096;

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

export async function POST(req: Request) {
  const user = await getCurrentUser();
  const publicEnabled = process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1";
  if (!user) return NextResponse.json({ error: publicEnabled ? "Unauthorized" : "not_enabled" }, { status: publicEnabled ? 401 : 404 });
  if (!isInternalAiBetaEnabledFor(user, publicEnabled)) {
    return NextResponse.json({ error: "not_enabled" }, { status: 404 });
  }

  // FREE-plan gate, same as upload-avatar (paid feature).
  if (user.plan === "FREE") {
    return NextResponse.json(
      { error: "plan_required", message: "อัปโหลดสื่อของคุณเองใช้ได้เฉพาะแผน Pro ขึ้นไป" },
      { status: 403 },
    );
  }

  // Early DoS guard: reject before formData buffers the body. Uses the larger (video)
  // cap since we don't yet know the file type; the per-type file.size check below
  // enforces the tighter 20 MB image limit after we know what was uploaded.
  const contentLength = Number(req.headers.get("content-length"));
  const safeContentLength = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  if (safeContentLength != null && safeContentLength > MAX_VIDEO_BYTES + MAX_FORM_OVERHEAD_BYTES) {
    return NextResponse.json({ error: "payload_too_large", message: "ไฟล์ใหญ่เกินกำหนด" }, { status: 413 });
  }

  // formData() parses the multipart body and throws on malformed input (bad boundary,
  // truncated stream, etc). Catch it explicitly so a hostile/broken body still gets the
  // route's standard Thai JSON error shape instead of falling through to Next's generic
  // framework error page (mirrors how /api/videos/upload-avatar wraps its whole handler).
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e) {
    console.error("[broll-window/upload] formData parse failed:", e);
    return NextResponse.json(
      { error: "invalid_body", message: "ข้อมูลฟอร์มไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง" },
      { status: 400 },
    );
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file_required", message: "กรุณาเลือกไฟล์" }, { status: 400 });
  }

  const ext = fileExt(file.name);
  const mime = file.type || "";
  const kind = detectKind(ext, mime);
  if (!kind) {
    return NextResponse.json(
      { error: "unsupported_type", message: "รองรับเฉพาะรูป (jpg/png/webp) หรือวิดีโอ (mp4/mov/webm)" },
      { status: 415 },
    );
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: "empty_file", message: "ไฟล์ว่างหรืออ่านไม่ได้" }, { status: 400 });
  }

  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size > maxBytes) {
    return NextResponse.json(
      {
        error: "payload_too_large",
        message: kind === "image" ? "รูปใหญ่เกิน 20 MB" : "วิดีโอใหญ่เกิน 200 MB",
      },
      { status: 413 },
    );
  }

  // Validation failures above do not consume admission or hourly budget. Acquire only
  // when the request is ready to start disk/ffprobe/ffmpeg work; this also prevents one
  // user from running two expensive upload conversions at the same time.
  const admission = brollUploadAdmission.tryAcquire(user.id);
  if (!admission.ok) {
    return NextResponse.json(
      {
        error: admission.reason === "busy" ? "upload_busy" : "rate_limited",
        message: brollUploadAdmissionMessage(admission),
      },
      {
        status: 429,
        headers: { "Retry-After": String(admission.retryAfterSec) },
      },
    );
  }
  admission.lease.commit();

  const stocksDir = path.join(process.cwd(), "stocks");

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
        return NextResponse.json({ error: "empty_file", message: "ไฟล์ว่างหรืออ่านไม่ได้" }, { status: 400 });
      }

      // Metadata-only probe BEFORE Ken Burns ever decodes the file — bounds pixel
      // dimensions so a small-byte-size decompression bomb can't force a multi-GB decode.
      // The same pinned demuxer is used for the probe and the Ken Burns decode.
      const inputFormat = resolveSafeInputDemuxer(tempInput, ext, "image");
      const imgDims = inputFormat ? ffprobeDimensions(tempInput, inputFormat) : null;
      if (!inputFormat || !imgDims || imgDims.width > MAX_DIMENSION_PX || imgDims.height > MAX_DIMENSION_PX) {
        safeUnlink(tempInput);
        return NextResponse.json(
          { error: "unsupported_type", message: "ไฟล์มีความละเอียดสูงเกินไป (สูงสุด 4096×4096)" },
          { status: 415 },
        );
      }

      // Still image → 5s vertical Ken Burns motion clip (throws if ffmpeg output is bad).
      await applyKenBurns(tempInput, outPath, KEN_BURNS_DURATION_SEC, { inputFormat });
      if (!isValidMp4Path(outPath)) {
        safeUnlink(outPath);
        return NextResponse.json({ error: "process_failed", message: "แปลงรูปเป็นวิดีโอไม่สำเร็จ" }, { status: 502 });
      }

      return NextResponse.json({ src: `/api/stocks/${outFile}`, clipDuration: KEN_BURNS_DURATION_SEC });
    }

    // kind === "video": stream to the stocks output path, then re-encode Remotion-safe.
    // 9:16 handling is intentionally identical to every stock/AI b-roll clip:
    // normalizeForRemotion scales into a 1080×1920 box and the renderer applies
    // objectFit:"cover" (ShortVideoComposition) — there is no separate crop-to-fill step
    // anywhere in the pipeline (see task-8 report for why the brief's "cropToPortrait"
    // premise doesn't match the codebase).
    await streamToFile(file, outPath);
    if (!isValidMp4Path(outPath)) {
      safeUnlink(outPath);
      return NextResponse.json({ error: "empty_file", message: "ไฟล์วิดีโอว่างหรืออ่านไม่ได้" }, { status: 400 });
    }

    // Metadata-only probe BEFORE normalizeForRemotion decodes the file — same bomb guard
    // as the image path. normalizeForRemotion also runs behind the process-wide normalize
    // semaphore shared with all b-roll processing, so an oversized decode here would stall
    // every other user's b-roll, not just this request.
    const inputFormat = resolveSafeInputDemuxer(outPath, ext, "video");
    const vidDims = inputFormat ? ffprobeDimensions(outPath, inputFormat) : null;
    if (!inputFormat || !vidDims || vidDims.width > MAX_DIMENSION_PX || vidDims.height > MAX_DIMENSION_PX) {
      safeUnlink(outPath);
      return NextResponse.json(
        { error: "unsupported_type", message: "ไฟล์มีความละเอียดสูงเกินไป (สูงสุด 4096×4096)" },
        { status: 415 },
      );
    }

    const normalizeResult = await normalizeForRemotion(outPath, { inputFormat });
    if (normalizeResult.status === "failed") {
      safeUnlink(outPath);
      safeUnlink(normalizedMarkerPath(outPath));
      return NextResponse.json({ error: "normalize_failed", message: "แปลงไฟล์วิดีโอไม่สำเร็จ" }, { status: 502 });
    }

    // outPath now holds our own libx264 mp4 (normalizeForRemotion swapped it in).
    const clipDuration = ffprobeDurationSec(outPath, "mov");
    if (!clipDuration || clipDuration <= 0) {
      // Encoded fine but we couldn't measure it — fail closed rather than hand back a
      // clip the editor can't safely trim. Output name is random (no cache reuse), so
      // drop the unusable file instead of leaving an orphan in stocks/.
      safeUnlink(outPath);
      safeUnlink(normalizedMarkerPath(outPath));
      return NextResponse.json({ error: "probe_failed", message: "อ่านความยาววิดีโอไม่สำเร็จ" }, { status: 502 });
    }

    return NextResponse.json({ src: `/api/stocks/${outFile}`, clipDuration });
  } catch (e) {
    safeUnlink(outPath);
    safeUnlink(normalizedMarkerPath(outPath));
    console.error("[broll-window/upload] failed:", e);
    return NextResponse.json({ error: "upload_failed", message: "อัปโหลดสื่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" }, { status: 500 });
  } finally {
    if (tempInput) safeUnlink(tempInput);
    admission.lease.release();
  }
}
