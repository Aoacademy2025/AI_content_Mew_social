import { RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import { requestVideoJob } from "@/lib/mcp/video-budget.server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { resolveMcpPrincipal, resolveMcpPrincipalByClerkId, mcpAccessAllowed, type McpPrincipal } from "@/lib/mcp/auth";
import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { recordToolCall, isInBandError, auditErrorSummary, auditExceptionSummary } from "@/lib/mcp/audit";
import { isDatabaseBusyError } from "@/lib/prisma-errors";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/onboarding";

import { getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoJobStatusTool, getVideoTool, downloadVideoTool } from "@/lib/mcp/tools";
import type { User, VideoStatus } from "@prisma/client";

import { getRequestPrincipal, runWithRequestPrincipalSlot, setRequestPrincipal } from "@/lib/mcp/request-principal";

import { registerEditTools } from "@/lib/mcp/edit-tools";
import { registerMediaImportTools } from "@/lib/mcp/media-import-tools";
import { registerPreviewFrameTool } from "@/lib/mcp/preview-frame";
import { isMcpImageReply, mcpImageReplyContent } from "@/lib/mcp/tool-reply";
import { cancelMcpVideoJob } from "@/lib/mcp/video-job-cancel";
import { withClientDisconnectGuard } from "@/lib/mcp/transport-disconnect";

import { pipelineCaller } from "@/lib/mcp/pipeline-client";
import { getVideoOptions } from "@/lib/mcp/video-options";

import { listActiveBrandProfilesForMcp } from "@/lib/brand-profile-library.server";

import { prepareVideoQuote, getVideoQuote } from "@/lib/mcp/video-quote.server";
import { createVideoJobInputShape, prepareVideoJobInputShape } from "@/lib/mcp/create-video-input";

export const runtime = "nodejs";

const UPSELL =
  "ฟีเจอร์ MCP ใช้ได้เฉพาะแผน PRO หรือ BUSINESS — แผนปัจจุบันยังเข้าถึงไม่ได้ อัปเกรดที่ studio.heroaiengine.com/pricing";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

type Extra = { authInfo?: AuthInfo };
function principalFrom(extra: Extra) {
  const e = (extra.authInfo?.extra ?? {}) as { userId?: string; effectivePlan?: string; user?: User; userAgent?: string | null };
  return { userId: e.userId, effectivePlan: e.effectivePlan, user: e.user, userAgent: e.userAgent ?? null };
}

const UPGRADE_NEXT = "อัปเกรดเป็นแผน PRO หรือ BUSINESS ที่ studio.heroaiengine.com/pricing แล้วลองใหม่";

/** A beta-gate refusal is an access decision: audited like the plan guard's (`denied`). */
function auditStatusOf(result: unknown): "ok" | "denied" | "error" {
  if ((result as { error?: unknown } | null)?.error === "feature_not_enabled") return "denied";
  return isInBandError(result) ? "error" : "ok";
}

// Per-tool guard (PRO/BUSINESS) + audit wrapper. `opts.next` (T6 Agent-neutral tools only)
// makes the guard's own refusals full G14 envelopes; existing tools keep their reply shape.
async function runTool(
  toolName: string,
  extra: Extra,
  fn: (p: { userId: string; user: User }) => Promise<unknown>,
  args?: unknown,
  opts?: { next: string },
) {
  const started = Date.now();
  const { userId, effectivePlan, user, userAgent } = principalFrom(extra);
  if (!userId || !user || !effectivePlan || !mcpAccessAllowed(effectivePlan)) {
    await recordToolCall({ userId, toolName, status: "denied", durationMs: Date.now() - started, requestJson: args, userAgent, responseJson: { error: "plan_required" } });
    return text(opts
      ? { error: "plan_required", code: "plan_required", message: UPSELL, next: UPGRADE_NEXT }
      : { error: "plan_required", message: UPSELL });
  }
  try {
    const result = await fn({ userId, user });
    const status = auditStatusOf(result);
    await recordToolCall({ userId, toolName, status, durationMs: Date.now() - started, requestJson: args, userAgent, responseJson: status === "ok" ? null : auditErrorSummary(result) });
    // W4: get_preview_frame answers with an image block + one text line.
    return isMcpImageReply(result) ? mcpImageReplyContent(result) : text(result);
  } catch (err) {
    await recordToolCall({ userId, toolName, status: "error", durationMs: Date.now() - started, requestJson: args, userAgent, responseJson: auditExceptionSummary(err) });
    // Prod evidence 2026-10-12: SQLite writer-lock stalls (busy_timeout steps, this
    // process's own transaction-queue timeout, a pooled-connection socket timeout)
    // surfaced as a generic internal_error 30-60s after the agent's call. Reply
    // in-band as database_busy instead, so the agent can wait and retry the SAME
    // tool rather than assuming the whole account is broken. Honest: a tool may
    // have partly written before this exception, so the copy never claims nothing
    // happened — it points at get_edit_state to check.
    if (isDatabaseBusyError(err)) {
      const message = "ระบบมีงานเข้าพร้อมกันเยอะ คำสั่งนี้ยังไม่สำเร็จ";
      const next = "รอประมาณ 10 วินาทีแล้วเรียกเครื่องมือเดิมอีกครั้ง — ถ้าเป็นคำสั่งแก้ไข ให้เรียก get_edit_state ก่อนเพื่อดูว่าการแก้ถูกบันทึกไปแล้วหรือยัง";
      return text(opts
        ? { error: "database_busy", code: "database_busy", message, retryAfterSeconds: 10, next }
        : { error: "database_busy", message, retryAfterSeconds: 10 });
    }
    const message = "เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง";
    return text(opts
      ? { error: "internal_error", code: "internal_error", message, next: opts.next }
      : { error: "internal_error", message });
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_current_user",
      { title: "Get current user", description: "บัญชี/แผน/โควตา/คีย์ที่ตั้งค่าไว้ของผู้ใช้ปัจจุบัน", inputSchema: {} },
      async (_args, extra) => runTool("get_current_user", extra, async (p) => getCurrentUserTool(p.user)),
    );

    server.registerTool(
      "list_my_videos",
      {
        title: "List my videos",
        description: "รายการวิดีโอของผู้ใช้ (ใหม่สุดก่อน) — แต่ละรายการมี jobId (หรือ null) และ editable: ถ้าอยากแก้คลิปเก่าต่อในแชทใหม่ ให้ใช้ jobId นี้กับ get_edit_state ได้เฉพาะตอน editable เป็น true เท่านั้น",
        inputSchema: {
          limit: z.number().int().min(1).max(100).default(20),
          status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]).optional(),
        },
      },
      async (args, extra) =>
        runTool("list_my_videos", extra, async (p) => listMyVideosTool(p.userId, { limit: args.limit, status: args.status as VideoStatus | undefined }), args),
    );

    server.registerTool(
      "get_video_status",
      { title: "Get video/job status", description: "สถานะของ video job หรือ video 1 รายการ (รับ id ของ job หรือ video) ถ้ามี warnings/subtitleQa ให้แจ้งผู้ใช้; ถ้ามี editorUrl ให้ส่งลิงก์ \"กดลิงก์นี้เพื่อแก้ต่อในเว็บได้\"; ถ้า failed ให้อธิบายตาม userAction และ refunded/refundPending.", inputSchema: { id: z.string().min(1) } },
      async (args, extra) =>
        runTool("get_video_status", extra, async (p) => {
          const job = await getVideoJobStatusTool(p.userId, args.id);
          if (job) return job;
          const v = await getVideoStatusTool(p.userId, args.id);
          if (!v.found) return { kind: "none" as const, found: false as const, id: args.id };
          return { kind: "video" as const, ...v };
        }, args),
    );

    server.registerTool(
      "get_video",
      { title: "Get video", description: "รายละเอียดวิดีโอ 1 รายการ — มี jobId (หรือ null) และ editable: ถ้าอยากแก้คลิปนี้ต่อในแชทใหม่ ให้ใช้ jobId นี้กับ get_edit_state ได้เฉพาะตอน editable เป็น true เท่านั้น", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("get_video", extra, async (p) => getVideoTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "download_video",
      { title: "Download video", description: "ลิงก์ดาวน์โหลดวิดีโอ (ถ้าเรนเดอร์เสร็จแล้ว)", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("download_video", extra, async (p) => downloadVideoTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "get_video_options",
      { title: "Get video options", description: "ตัวเลือกจริงสำหรับสร้างวิดีโอ: เพลง/avatar/เสียง/B-roll/โหมดซับ — ใช้ตอนไกด์ผู้ใช้", inputSchema: {} },
      async (_args, extra) => runTool("get_video_options", extra, async (p) =>
        getVideoOptions(pipelineCaller(p.userId), p.user, await listActiveBrandProfilesForMcp(p.userId))),
    );

    server.registerTool(
      "prepare_video_job",
      {
        title: "Prepare video spending quote",
        description: "ถามผู้ใช้ก่อนว่าจะใช้ stock, hero-ai-image, automix หรือ external แล้วประเมินวงเงินโดยไม่สร้างงานหรือหักเครดิต ส่ง confirmationUrl ให้เจ้าของบัญชียืนยันใน Studio; agent ยืนยันแทนไม่ได้. คลิปพิธีกรต้องนำเข้าสำเร็จผ่าน create_upload_url(kind: presenter) และ PUT ก่อนส่ง clipUploadId",
        inputSchema: prepareVideoJobInputShape,
      },
      async (args, extra) => runTool("prepare_video_job", extra, async (p) => prepareVideoQuote(p.user, args), { brollSource: args.brollSource, hasScript: Boolean(args.script), hasPresenter: Boolean(args.clipUrl || args.clipUploadId) }, { next: "ตรวจข้อมูลแล้วเรียก prepare_video_job ใหม่" }),
    );
    server.registerTool(
      "get_video_quote",
      { title: "Get video quote status", description: "อ่านสถานะใบยืนยันของบัญชีนี้ ไม่อนุมัติและไม่เริ่มงาน; เมื่อ approved ให้เรียก create_video_job ด้วย quoteId เดิม", inputSchema: { quoteId: z.string().min(1).max(64) } },
      async (args, extra) => runTool("get_video_quote", extra, async (p) => getVideoQuote(p.userId, args.quoteId), args, { next: "ใช้ quoteId ของบัญชีนี้ หรือเรียก prepare_video_job ใหม่" }),
    );

    server.registerTool(
      "create_video_job",
      {
        title: "Create video job",
        description: "สร้างวิดีโอจากงานที่เจ้าของบัญชีอนุมัติ: เรียก prepare_video_job โดยเลือก brollSource = stock | hero-ai-image | automix | external ส่ง confirmationUrl ให้เจ้าของบัญชียืนยันใน Studio แล้วเรียก create_video_job ด้วย quoteId เดิมเพื่อเริ่มงาน จากนั้น poll get_video_status. ไม่เริ่มงานหรือจองค่าใช้จ่ายก่อนอนุมัติ. คลิปพิธีกรต้องนำเข้าด้วย create_upload_url kind presenter และตรวจให้พร้อมก่อน prepare_video_job ด้วย clipUploadId; clipUrl ต้องผ่านการนำเข้าและตรวจสอบก่อนเสนอวงเงิน. external ไม่ใช้เครดิตสร้างภาพ แต่ต้องนำเข้าสื่อให้ครบช่วงที่กำหนดก่อน export_video. แจ้ง warnings และเพดานค่าใช้จ่ายให้ผู้ใช้ทราบ.",
        inputSchema: createVideoJobInputShape,
      },
      async (args, extra) =>
        runTool("create_video_job", extra, async (p) => {
          try {
            return await requestVideoJob(p.user, args);
          } catch (error) {
            if (error instanceof RenderDeployDrainError) {
              return {
                error: "render_maintenance", code: "render_maintenance", retryable: true,
                message: RENDER_MAINTENANCE_CUSTOMER_MESSAGE,
                next: "รอสักครู่แล้วเรียก create_video_job อีกครั้งด้วย quoteId เดิม",
              };
            }
            throw error;
          }
        }, args),
    );

    server.registerTool(
      "cancel_video_job",
      {
        title: "Cancel video job",
        description: "ยกเลิกงานวิดีโอที่ยังไม่เสร็จ (ใส่ jobId ที่ได้จาก create_video_job). ยกเลิกหลังเรนเดอร์หลักเสร็จ ส่วนที่เสร็จแล้วยังถูกคิดตามปกติ; ค่า HeyGen คืนไม่ได้.",
        inputSchema: { id: z.string().min(1) },
      },
      async (args, extra) =>
        runTool("cancel_video_job", extra, async (p) => {
          const result = await cancelMcpVideoJob(p.userId, args.id);
          if (result.kind === "not_cancelable") {
            return { error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" };
          }
          return { ok: true, settlementPending: result.settlementPending };
        }, args),
    );

    // T6 (ADR 0064): the MCP edit-before-export tools, registered per request for the
    // principal verifyToken resolved (beta-gated: absent from tools/list otherwise).
    // T11 (ADR 0065): create_upload_url, same gate.
    registerEditTools(server, getRequestPrincipal(), runTool);
    registerMediaImportTools(server, getRequestPrincipal(), runTool);
    // W4: get_preview_frame (observation only, ADR 0066), same gate.
    registerPreviewFrameTool(server, getRequestPrincipal(), runTool);
  },
  { serverInfo: { name: "heroai", version: "0.2.0" }, capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  { basePath: "/api", maxDuration: 60, verboseLogs: process.env.NODE_ENV === "development" },
);

function principalAuthInfo(bearerToken: string, principal: McpPrincipal, userAgent: string | null): AuthInfo {
  return {
    token: bearerToken,
    scopes: ["heroai:read"],
    clientId: principal.userId,
    extra: { userId: principal.userId, plan: principal.plan, effectivePlan: principal.effectivePlan, user: principal.user, userAgent },
  };
}

// Accept EITHER a Personal Access Token (Claude Code / header-capable clients) OR a Clerk
// OAuth access token (Claude desktop app via the OAuth connector). Both resolve to the same
// McpPrincipal, so every tool + the runTool guard work unchanged regardless of how you authed.
//
// T7: carry the client's User-Agent header through to the audit (recordToolCall, via
// AuthInfo.extra → principalFrom → runTool). Spike result (task-7.md): mcp-handler's
// streamable-HTTP transport builds a brand new McpServer per HTTP POST (this route has no
// `sessionIdGenerator`, so it is fully stateless), and the SDK only populates
// `Server.getClientVersion()` (the MCP `clientInfo` name/version from the "initialize"
// JSON-RPC method) on the one request that IS that initialize call — never on the separate
// `tools/call` request a tool handler runs inside. There is no persisted session to read it
// back from at that point, so clientInfo is not available here; user-agent is, on every
// request, straight off the Request the SDK already hands verifyToken. The header is
// untrusted input — recordToolCall/sanitizeUserAgent strips control characters and caps
// length before it is ever stored.
const verifyToken = async (req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  const userAgent = req.headers.get("user-agent");

  // 1. Personal Access Token
  const patPrincipal = await resolveMcpPrincipal(bearerToken);
  if (patPrincipal) {
    // Hand the verified principal to the per-request server factory (request-principal.ts).
    setRequestPrincipal(patPrincipal);
    return principalAuthInfo(bearerToken!, patPrincipal, userAgent);
  }

  // 2. Clerk OAuth access token (desktop app)
  try {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const verified = await verifyClerkToken(clerkAuth, bearerToken);
    if (verified) {
      const clerkUserId = (verified.extra as { userId?: string } | undefined)?.userId ?? verified.clientId;
      const principal = await resolveMcpPrincipalByClerkId(clerkUserId);
      if (principal) {
        setRequestPrincipal(principal);
        return principalAuthInfo(bearerToken!, principal, userAgent);
      }
    }
  } catch {
    // not a valid Clerk OAuth token → fall through to 401
  }
  return undefined;
};

// HERO-70: a client that hangs up mid-request must not become an unhandledRejection
// (mcp-handler runs each request detached). Inside auth, so an unauthenticated request is
// still refused before its body is read. See transport-disconnect.ts.
const authHandler = withMcpAuth(withClientDisconnectGuard(handler), verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
});

// T6: every request runs inside its own principal slot, so the server factory sees exactly
// the principal verifyToken resolved for THIS request (request-principal.ts).
function routeHandler(req: Request): Promise<Response> {
  return runWithRequestPrincipalSlot(() => authHandler(req));
}

export { routeHandler as GET, routeHandler as POST, routeHandler as DELETE };
