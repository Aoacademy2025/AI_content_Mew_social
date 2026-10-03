import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import {
  brollUploadAdmission,
  brollUploadAdmissionMessage,
} from "@/lib/broll-upload-admission";
import {
  validateBrollUpload,
  runBrollPipeline,
  MAX_BROLL_VIDEO_BYTES,
} from "@/lib/media-import/broll-pipeline";

// POST /api/videos/broll-window/upload — Phase 2 "อัปโหลดเอง" tab (Task 8).
// User supplies their own media to replace one b-roll window:
//   • image (jpg/jpeg/png/webp ≤20MB) → Ken Burns motion clip (5s)
//   • video (mp4/mov/webm ≤200MB)     → Remotion-safe portrait re-encode
// The output is a locally-served `stocks/` mp4 the editor drops straight into the
// window's `bgVideos[]` entry. Internal AI testers receive the beta before the
// NEXT_PUBLIC_BROLL_WINDOW_EDIT public rollout, matching the sibling routes.
//
// Task 9 (PR-B, 2026-10-03): the type/size validation and the post-temp-file processing
// (ffprobe guard, 4096px bomb guard, Ken Burns / normalizeForRemotion, server-named
// output) moved to src/lib/media-import/broll-pipeline.ts so the future MCP Media Import
// worker can reuse the same pipeline. This route's own behaviour and HTTP responses are
// unchanged — see scripts/verify-broll-upload-admission.ts and
// scripts/verify-upload-probe-whitelist.ts.
//
// Security notes (this route's pipeline runs ffmpeg on user-supplied bytes):
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

const MAX_FORM_OVERHEAD_BYTES = 10 * 1024 * 1024; // multipart headers / form fields

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
  if (safeContentLength != null && safeContentLength > MAX_BROLL_VIDEO_BYTES + MAX_FORM_OVERHEAD_BYTES) {
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

  const validated = validateBrollUpload(file);
  if (!validated.ok) {
    return NextResponse.json(
      { error: validated.error.error, message: validated.error.message },
      { status: validated.error.status },
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

  try {
    const result = await runBrollPipeline({ file, kind: validated.kind, ext: validated.ext, stocksDir });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.value.error, message: result.value.message },
        { status: result.value.status },
      );
    }
    return NextResponse.json(result.value);
  } finally {
    admission.lease.release();
  }
}
