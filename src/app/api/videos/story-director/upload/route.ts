import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import {
  brollUploadAdmission,
  brollUploadAdmissionMessage,
} from "@/lib/broll-upload-admission";
import {
  MAX_BROLL_VIDEO_BYTES,
  runBrollPipeline,
  validateBrollUpload,
} from "@/lib/media-import/broll-pipeline";

/**
 * POST /api/videos/story-director/upload
 *
 * Uploads a user video clip or photo for Step 1 "AI ผู้กำกับฟุตเทจ (Story Director)":
 *   - Enforces identical MIME/ext validation, Pro-plan check, G24 demuxer pinning,
 *     4096px bomb guard, and per-user upload admission as `/api/videos/broll-window/upload`.
 *   - Passes `preserveAudio: true` so real clip audio (Q&A, cheers, reactions) survives
 *     normalization AND ~20fps iPhone Live-Photo clips are smoothly frame-blended to 30fps!
 */
export const runtime = "nodejs";
export const maxDuration = 600;

const MAX_FORM_OVERHEAD_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.plan === "FREE") {
    return NextResponse.json(
      { error: "plan_required", message: "อัปโหลดฟุตเทจส่วนตัวใช้ได้เฉพาะแผน Pro ขึ้นไป" },
      { status: 403 },
    );
  }

  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BROLL_VIDEO_BYTES + MAX_FORM_OVERHEAD_BYTES) {
    return NextResponse.json({ error: "payload_too_large", message: "ไฟล์ใหญ่เกินกำหนด" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
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
    const result = await runBrollPipeline({
      file,
      kind: validated.kind,
      ext: validated.ext,
      stocksDir,
      preserveAudio: true,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.value.error, message: result.value.message },
        { status: result.value.status },
      );
    }

    const row = await prisma.mediaImport.create({
      data: {
        userId: user.id,
        source: "upload",
        purpose: validated.kind === "image" ? "broll_image" : "broll_video",
        status: "ready",
        resultSrc: result.value.src,
        durationMs: Math.round(result.value.clipDuration * 1000),
        bytes: file.size,
        deadlineAt: new Date(),
      },
    });

    return NextResponse.json({
      importId: row.id,
      filename: file.name.slice(0, 120),
      ...result.value,
    });
  } finally {
    admission.lease.release();
  }
}
