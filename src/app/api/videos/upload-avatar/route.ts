import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const maxDuration = 600; // 10 min — supports large green-screen video uploads

const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_FORM_OVERHEAD_BYTES = 10 * 1024 * 1024; // multipart headers / form fields

type UploadErrorCode =
  | "unauthorized"
  | "plan_required"
  | "payload_too_large"
  | "file_required"
  | "unsupported_type"
  | "empty_file"
  | "disk_full"
  | "write_failed"
  | "unknown";

function jsonError(status: number, code: UploadErrorCode, error: string) {
  return NextResponse.json({ error, code }, { status });
}

function fileExt(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isAllowedAvatarVideo(file: File, ext: string) {
  if (!["mp4", "mov", "webm"].includes(ext)) return false;
  if (!file.type) return true;
  return ["video/mp4", "video/quicktime", "video/webm"].includes(file.type);
}

async function recordAvatarUploadTelemetry(
  userId: string | null,
  input: {
    status: "success" | "error";
    code?: UploadErrorCode;
    httpStatus?: number;
    durationMs: number;
    sizeBytes?: number;
    contentLengthBytes?: number | null;
    ext?: string;
    mime?: string;
  },
) {
  await recordTelemetryEvent(userId, {
    name: input.status === "success" ? "avatar_upload_completed" : "avatar_upload_failed",
    category: input.status === "success" ? "pipeline" : "error",
    source: "server",
    step: "avatar_upload",
    status: input.status,
    durationMs: input.durationMs,
    value: input.sizeBytes,
    properties: {
      code: input.code,
      httpStatus: input.httpStatus,
      sizeMb: input.sizeBytes == null ? undefined : Math.round((input.sizeBytes / 1024 / 1024) * 10) / 10,
      contentLengthMb: input.contentLengthBytes == null ? undefined : Math.round((input.contentLengthBytes / 1024 / 1024) * 10) / 10,
      ext: input.ext,
      mime: input.mime,
    },
  }).catch(() => {});
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let outPath: string | null = null;
  let ext = "";
  let mime = "";
  let sizeBytes = 0;
  const contentLengthBytes = Number(req.headers.get("content-length"));
  const safeContentLength = Number.isFinite(contentLengthBytes) && contentLengthBytes > 0 ? contentLengthBytes : null;

  try {
    const authUser = await getCurrentUser();
    if (!authUser) return jsonError(401, "unauthorized", "Unauthorized");
    userId = authUser.id;

    const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
    if (dbUser?.plan === "FREE") {
      await recordAvatarUploadTelemetry(userId, {
        status: "error",
        code: "plan_required",
        httpStatus: 403,
        durationMs: Date.now() - startedAt,
        contentLengthBytes: safeContentLength,
      });
      return jsonError(403, "plan_required", "Avatar ใช้ได้เฉพาะแผน Pro ขึ้นไป");
    }

    if (safeContentLength != null && safeContentLength > MAX_SIZE_BYTES + MAX_FORM_OVERHEAD_BYTES) {
      await recordAvatarUploadTelemetry(userId, {
        status: "error",
        code: "payload_too_large",
        httpStatus: 413,
        durationMs: Date.now() - startedAt,
        contentLengthBytes: safeContentLength,
      });
      return jsonError(413, "payload_too_large", "ไฟล์ใหญ่เกิน 2 GB");
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      await recordAvatarUploadTelemetry(userId, {
        status: "error",
        code: "file_required",
        httpStatus: 400,
        durationMs: Date.now() - startedAt,
        contentLengthBytes: safeContentLength,
      });
      return jsonError(400, "file_required", "file required");
    }

    ext = fileExt(file.name) || "mp4";
    mime = file.type || "";
    sizeBytes = file.size;
    if (!isAllowedAvatarVideo(file, ext)) {
      await recordAvatarUploadTelemetry(userId, {
        status: "error",
        code: "unsupported_type",
        httpStatus: 400,
        durationMs: Date.now() - startedAt,
        sizeBytes,
        contentLengthBytes: safeContentLength,
        ext,
        mime,
      });
      return jsonError(400, "unsupported_type", "รองรับเฉพาะ mp4 / mov / webm");
    }

    if (sizeBytes <= 0) {
      await recordAvatarUploadTelemetry(userId, {
        status: "error",
        code: "empty_file",
        httpStatus: 400,
        durationMs: Date.now() - startedAt,
        sizeBytes,
        contentLengthBytes: safeContentLength,
        ext,
        mime,
      });
      return jsonError(400, "empty_file", "ไฟล์วิดีโอว่างหรืออ่านไม่ได้");
    }

    if (sizeBytes > MAX_SIZE_BYTES) {
      await recordAvatarUploadTelemetry(userId, {
        status: "error",
        code: "payload_too_large",
        httpStatus: 413,
        durationMs: Date.now() - startedAt,
        sizeBytes,
        contentLengthBytes: safeContentLength,
        ext,
        mime,
      });
      return jsonError(413, "payload_too_large", "ไฟล์ใหญ่เกิน 2 GB");
    }

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    const filename = `avatar-upload-${Date.now()}-${randomUUID()}.${ext}`;
    outPath = path.join(rendersDir, filename);

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
          try { reader.releaseLock(); } catch {}
        }
      };
      void pump();
    });

    const writtenBytes = fs.statSync(outPath).size;
    if (writtenBytes <= 0) throw new Error("empty output file");

    await recordAvatarUploadTelemetry(userId, {
      status: "success",
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      sizeBytes: writtenBytes,
      contentLengthBytes: safeContentLength,
      ext,
      mime,
    });

    return NextResponse.json({ url: `/api/renders/${filename}` });
  } catch (error) {
    if (outPath) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    }
    const nodeError = error as NodeJS.ErrnoException;
    const isDiskFull = nodeError?.code === "ENOSPC";
    const code: UploadErrorCode = isDiskFull ? "disk_full" : "write_failed";
    const status = isDiskFull ? 507 : 500;
    console.error("[upload-avatar] failed", {
      userId,
      code,
      ext,
      mime,
      sizeBytes,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    await recordAvatarUploadTelemetry(userId, {
      status: "error",
      code,
      httpStatus: status,
      durationMs: Date.now() - startedAt,
      sizeBytes,
      contentLengthBytes: safeContentLength,
      ext,
      mime,
    });
    return jsonError(
      status,
      code,
      isDiskFull
        ? "พื้นที่จัดเก็บบนเซิร์ฟเวอร์ไม่พอสำหรับอัปโหลดไฟล์นี้"
        : "อัปโหลด Avatar ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    );
  }
}
