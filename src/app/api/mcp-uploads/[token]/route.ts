import { prisma } from "@/lib/prisma";
import { mcpAccessAllowed, principalFromUser } from "@/lib/mcp/auth";
import { mcpEditorProjectEnabledFor } from "@/lib/mcp/chain-export";
import { admissionRefusal } from "@/lib/mcp/media-import-tools";
import {
  UPLOAD_KIND_MAX_BYTES,
  UPLOAD_TOKEN_TTL_MS,
  admitUpload,
  failMediaImport,
  findUsableUploadToken,
  markUploadStaged,
  type UploadKind,
} from "@/lib/media-import/imports";
import {
  removeStagedUpload,
  stageUploadBody,
  stagedContainerFor,
  stagingHasRoomFor,
} from "@/lib/media-import/upload-staging";

/**
 * PUT /api/mcp-uploads/<token> — the single-use Media Import upload link (Task 11, G26,
 * ADR 0065). The link token is the only credential: no Clerk session, no PAT. That is why
 * this path is excluded from the proxy matcher (src/proxy.ts) — when the proxy runs, Next
 * buffers the whole body to clone it before this handler starts, so the byte cap could not
 * abort anything.
 *
 * Flow: token → still usable (unused, < 15 min) → user still PRO/BUSINESS + beta → declared
 * size within the kind's cap → admission (consume link + create MediaImport, atomically,
 * re-checking the G25 caps, the user's byte budgets and staging share, the global staging
 * budget, and the free-disk floor (statfs) for this upload plus every one still in flight) →
 * stream the body to the private staging file with the cap (the declared size, else the kind's
 * cap) enforced while reading → bytes must be the link's kind (sniffed, never Content-Type) →
 * MediaImport "pending" with the staged byte count for the import lane (Task 12). Every refusal
 * before admission keeps the link, including a database that is momentarily unavailable (503
 * `server_busy`). An upload that declares its Content-Length reserves only that many bytes, so
 * a burst of small files is not counted at the kind's cap.
 *
 * Never logs the token or the URL (A13); nginx logs this location with a redacted format and
 * Sentry scrubs the path segment (src/lib/sentry-config.ts).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Failure = { error: string; code: string; message: string; next: string; retryAfterSeconds?: number };

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, code: string, message: string, next: string, retryAfterSeconds?: number): Response {
  const body: Failure = retryAfterSeconds !== undefined ? { error: code, code, message, next, retryAfterSeconds } : { error: code, code, message, next };
  return reply(status, body);
}

const NEW_LINK_NEXT = "เรียก create_upload_url เพื่อขอลิงก์ใหม่ แล้วอัปโหลดอีกครั้ง";

/** One reply for unknown, malformed, used, expired and no-longer-entitled links. */
function linkInvalid(): Response {
  return failure(404, "upload_link_invalid", "ลิงก์อัปโหลดนี้ใช้ไม่ได้ (ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว)", NEW_LINK_NEXT);
}

const SIZE_LABEL: Record<UploadKind, string> = { image: "20 MB", video: "200 MB", presenter: "500 MB" };
const ACCEPTS: Record<UploadKind, string> = { image: "jpg, png หรือ webp", video: "mp4, mov หรือ webm", presenter: "mp4, mov หรือ webm" };

const SAME_LINK_RETRY = "ลิงก์ยังใช้ได้จนหมดอายุ — รอสักครู่ (ประมาณ 30 วินาที) แล้ว PUT ไฟล์เดิมด้วยลิงก์เดิมอีกครั้ง";

/** The database could not answer before anything was admitted: nothing changed, link kept. */
function serverBusy(): Response {
  return failure(503, "server_busy", "ระบบไม่ว่างชั่วคราว ยังรับไฟล์ไม่ได้ในตอนนี้", SAME_LINK_RETRY);
}

/** Staging space is short (disk floor or the global budget): nothing changed, link kept. */
function storageBusy(): Response {
  return failure(503, "storage_busy", "พื้นที่รับไฟล์ของระบบเต็มชั่วคราว", `${SAME_LINK_RETRY} (ถ้ายังไม่ได้ ให้รอไม่กี่นาที)`);
}

/** Over the cap while streaming: the link was consumed, so a new one is needed. */
function tooLarge(kind: UploadKind): Response {
  return failure(413, "file_too_large", `ไฟล์ใหญ่เกิน ${SIZE_LABEL[kind]}`, `ลดขนาดไฟล์ให้ไม่เกิน ${SIZE_LABEL[kind]} แล้ว${NEW_LINK_NEXT}`);
}

/** Over the cap by the declared Content-Length: nothing was read and the link is kept (N3). */
function declaredTooLarge(kind: UploadKind): Response {
  return failure(
    413,
    "file_too_large",
    `ไฟล์ใหญ่เกิน ${SIZE_LABEL[kind]}`,
    `ลดขนาดไฟล์ให้ไม่เกิน ${SIZE_LABEL[kind]} แล้ว PUT ไฟล์ใหม่ด้วยลิงก์เดิมอีกครั้ง (ลิงก์นี้ยังใช้ได้จนหมดอายุ)`,
  );
}

export async function PUT(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  const now = new Date();

  let link: Awaited<ReturnType<typeof findUsableUploadToken>>;
  let entitled: boolean;
  try {
    link = await findUsableUploadToken(token, now);
    if (!link) return linkInvalid();
    // Bound to its user: that user must still be allowed to use the feature right now.
    const user = await prisma.user.findUnique({ where: { id: link.userId } });
    entitled = !!user && mcpAccessAllowed(principalFromUser(user).effectivePlan) && mcpEditorProjectEnabledFor(user);
  } catch (error) {
    console.error("[mcp-uploads] database unavailable before admission:", error instanceof Error ? error.name : "unknown");
    return serverBusy();
  }
  if (!entitled) return linkInvalid();
  const kind = link.kind as UploadKind;
  const maxBytes = UPLOAD_KIND_MAX_BYTES[kind];

  // Honest clients declare the size: refuse over-cap before reading a byte (link kept). A valid
  // declared size is what this upload reserves against the byte budgets, and the most it may send.
  const declared = request.headers.get("content-length")?.trim() ?? null;
  const declaredBytes = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
  if (declaredBytes !== undefined && declaredBytes > maxBytes) return declaredTooLarge(kind);
  if (!request.body) return failure(400, "empty_file", "ไม่มีไฟล์ใน body ของคำขอ", "ส่งไบต์ของไฟล์เป็น body ของ HTTP PUT (ไม่ใช่ multipart) ด้วยลิงก์เดิม");

  // Free-disk floor, checked inside the admission transaction so it counts every upload still
  // streaming in (fails closed when statfs cannot answer).
  const diskRoomFor = (bytes: number): boolean => {
    try {
      return stagingHasRoomFor(bytes);
    } catch (error) {
      console.error("[mcp-uploads] staging space check failed:", error instanceof Error ? error.name : "unknown");
      return false;
    }
  };

  let admitted: Awaited<ReturnType<typeof admitUpload>>;
  try {
    admitted = await admitUpload(link, now, { declaredBytes: declaredBytes || undefined, diskRoomFor });
  } catch (error) {
    // The admission transaction rolled back: the link is still unused.
    console.error("[mcp-uploads] database unavailable at admission:", error instanceof Error ? error.name : "unknown");
    return serverBusy();
  }
  if (!admitted.ok) {
    if (admitted.code === "upload_link_invalid") return linkInvalid();
    if (admitted.code === "storage_busy") return storageBusy();
    const refusal = admissionRefusal(admitted.code, undefined, admitted.retryAfterSeconds);
    // A wait that outlives this link (15 min from issue) needs a new link afterwards.
    const linkSecondsLeft = Math.floor((link.issuedAt.getTime() + UPLOAD_TOKEN_TTL_MS - now.getTime()) / 1000);
    const next = admitted.retryAfterSeconds !== undefined && admitted.retryAfterSeconds >= linkSecondsLeft
      ? `${refusal.next} — ลิงก์นี้จะหมดอายุก่อน ให้เรียก create_upload_url ขอลิงก์ใหม่เมื่อครบเวลา`
      : "รอให้ไฟล์ที่กำลังนำเข้าเสร็จหรือรอสักพัก (ดู retryAfterSeconds) แล้ว PUT ด้วยลิงก์เดิมอีกครั้ง (ลิงก์ยังใช้ได้จนหมดอายุ)";
    return failure(429, refusal.code, refusal.message, next, admitted.retryAfterSeconds);
  }
  const { importId } = admitted;

  try {
    const staged = await stageUploadBody(request.body, importId, admitted.maxBytes);
    if (!staged.ok) {
      if (staged.reason === "too_large") {
        await failMediaImport(importId, "file_too_large");
        return tooLarge(kind);
      }
      if (staged.reason === "empty") {
        await failMediaImport(importId, "empty_file");
        return failure(400, "empty_file", "ไฟล์ว่าง", NEW_LINK_NEXT);
      }
      await failMediaImport(importId, "upload_incomplete");
      return failure(400, "upload_incomplete", "อัปโหลดไม่ครบ (การเชื่อมต่อขาดระหว่างส่ง)", NEW_LINK_NEXT);
    }

    if (!stagedContainerFor(importId, kind)) {
      removeStagedUpload(importId);
      await failMediaImport(importId, "unsupported_media");
      return failure(415, "unsupported_media", `ชนิดไฟล์ไม่ตรงกับลิงก์นี้ — รับเฉพาะ ${ACCEPTS[kind]}`, `ขอลิงก์ใหม่ด้วย create_upload_url ให้ kind ตรงกับไฟล์ แล้วอัปโหลดอีกครั้ง`);
    }

    if (!(await markUploadStaged(importId, staged.bytes))) {
      removeStagedUpload(importId);
      return failure(409, "upload_incomplete", "อัปโหลดนานเกินกำหนด ไฟล์นี้ถูกยกเลิกแล้ว", NEW_LINK_NEXT);
    }
    return reply(202, {
      ok: true,
      uploadId: importId,
      status: "pending",
      next: "อัปโหลดสำเร็จ ระบบกำลังตรวจและเตรียมไฟล์ — ใช้ uploadId นี้กับเครื่องมือที่รับไฟล์ได้เลย",
    });
  } catch (error) {
    removeStagedUpload(importId);
    await failMediaImport(importId, "upload_failed").catch(() => undefined);
    console.error("[mcp-uploads] upload failed:", error instanceof Error ? error.name : "unknown");
    return failure(500, "upload_failed", "อัปโหลดไม่สำเร็จ เกิดข้อผิดพลาดภายใน", NEW_LINK_NEXT);
  }
}
