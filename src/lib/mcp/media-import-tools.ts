import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGatedTool, type GatingPrincipal } from "@/lib/mcp/tool-gating";
import { editToolFailure, type EditToolRunner } from "@/lib/mcp/edit-tools";
import { mcpPublicOrigin } from "@/lib/mcp/tools";
import {
  UPLOAD_KINDS,
  UPLOAD_KIND_MAX_BYTES,
  UPLOAD_TOKEN_TTL_MS,
  issueUploadToken,
  type UploadKind,
} from "@/lib/media-import/imports";
import { admissionRefusal } from "@/lib/mcp/media-import-copy";

// The PUT route imports the admission copy from here (Task 11); it lives in media-import-copy.ts.
export { admissionRefusal };

/**
 * Task 11 (PR-B, G26, ADR 0065): `create_upload_url` — a single-use, 15-minute `PUT` link for
 * an agent that has a file but no public URL for it. Agent-neutral (G13/G14): one flat string
 * enum input, every refusal `{ error, code, message (Thai), next }`. Beta-gated through
 * `registerGatedTool`, like the PR-A edit tools.
 */

export const MCP_MEDIA_IMPORT_TOOL_NAMES = ["create_upload_url"] as const;

export const createUploadUrlInputShape = {
  kind: z.enum(UPLOAD_KINDS).describe(
    "ชนิดไฟล์: image = รูป B-roll (jpg/png/webp ≤ 20 MB), video = วิดีโอ B-roll (mp4/mov/webm ≤ 200 MB), presenter = คลิปพิธีกรแนวตั้ง (mp4/mov/webm ≤ 500 MB)",
  ),
} satisfies z.ZodRawShape;

const ACCEPTS: Record<UploadKind, string> = {
  image: "jpg, png, webp",
  video: "mp4, mov, webm",
  presenter: "mp4, mov, webm (แนวตั้ง)",
};

const USE_NEXT: Record<UploadKind, string> = {
  image: "ส่ง uploadId ให้ replace_broll_window",
  video: "ส่ง uploadId ให้ replace_broll_window",
  presenter: "ส่ง uploadId เป็น clipUploadId ของ create_video_job",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin upload links are issued on: the configured public origin only (MCP_PUBLIC_ORIGIN /
 * NEXT_PUBLIC_APP_URL — never anything from the incoming request), and only when it is https.
 * The token rides in the path, so a cleartext link would expose a live credential on the wire
 * and in the port-80 log. Sole exception: a loopback http origin outside production, so local
 * development can exercise the tool (such a link never leaves the machine).
 */
function uploadLinkOrigin(): URL | null {
  let origin: URL;
  try {
    origin = new URL(mcpPublicOrigin());
  } catch {
    return null;
  }
  if (origin.protocol === "https:") return origin;
  if (origin.protocol === "http:" && process.env.NODE_ENV !== "production" && LOOPBACK_HOSTS.has(origin.hostname)) return origin;
  return null;
}

const UPLOAD_UNAVAILABLE = editToolFailure(
  "upload_unavailable",
  "ตอนนี้ระบบยังสร้างลิงก์อัปโหลดที่ปลอดภัยไม่ได้",
  "ส่งลิงก์สาธารณะ (https) ของไฟล์แทน หรือแจ้งทีมงานให้ตรวจการตั้งค่า",
);

export async function createUploadUrlTool(userId: string, args: { kind: UploadKind }) {
  // Checked before issuing, so a misconfigured origin never mints (or counts) a link.
  const origin = uploadLinkOrigin();
  if (!origin) {
    console.error("[mcp-uploads] public origin is not https; upload links are disabled");
    return UPLOAD_UNAVAILABLE;
  }
  const issued = await issueUploadToken(userId, args.kind);
  if (!issued.ok) return admissionRefusal(issued.code, undefined, issued.retryAfterSeconds);
  const uploadUrl = new URL(`/api/mcp-uploads/${issued.token}`, origin);
  return {
    uploadId: issued.importId,
    uploadUrl: uploadUrl.toString(),
    method: "PUT",
    kind: issued.kind,
    accepts: ACCEPTS[issued.kind],
    maxBytes: UPLOAD_KIND_MAX_BYTES[issued.kind],
    expiresAt: issued.expiresAt.toISOString(),
    next: `อัปโหลดไฟล์ด้วย HTTP PUT ไปที่ uploadUrl ภายใน ${UPLOAD_TOKEN_TTL_MS / 60_000} นาที — ส่งไบต์ของไฟล์เป็น body ตรงๆ (ไม่ใช่ multipart) ลิงก์ใช้ได้ครั้งเดียว จากนั้น${USE_NEXT[issued.kind]}`,
  };
}

const GATE_NEXT = "ส่งลิงก์สาธารณะ (https) ของไฟล์แทน หรือใช้ create_video_job / get_video_status ตามปกติ";
const RUN_NEXT = "ลองเรียก create_upload_url อีกครั้ง";

/** Registers the Media Import tools for this request's principal (beta-gated, G1). */
export function registerMediaImportTools(server: McpServer, principal: GatingPrincipal, runTool: EditToolRunner): void {
  registerGatedTool(
    server,
    principal,
    "create_upload_url",
    {
      title: "Create upload URL",
      description:
        "ขอลิงก์อัปโหลดไฟล์แบบใช้ครั้งเดียว (หมดอายุใน 15 นาที) สำหรับไฟล์ที่ไม่มีลิงก์สาธารณะ: อัปโหลดด้วย HTTP PUT (body = ไบต์ของไฟล์) แล้วใช้ uploadId ที่ได้กับเครื่องมือที่รับไฟล์. ถ้ามีลิงก์ https สาธารณะอยู่แล้ว ส่งลิงก์นั้นได้เลยไม่ต้องใช้เครื่องมือนี้.",
      inputSchema: createUploadUrlInputShape,
    },
    async (args, extra) =>
      runTool("create_upload_url", extra, (p) => createUploadUrlTool(p.userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
}
