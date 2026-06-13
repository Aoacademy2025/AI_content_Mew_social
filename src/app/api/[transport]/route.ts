import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { resolveMcpPrincipal, mcpAccessAllowed } from "@/lib/mcp/auth";
import { recordToolCall } from "@/lib/mcp/audit";
import {
  getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoTool, downloadVideoTool,
} from "@/lib/mcp/tools";
import type { User, VideoStatus } from "@prisma/client";

export const runtime = "nodejs";

const UPSELL =
  "ฟีเจอร์ MCP ใช้ได้เฉพาะแผน PRO หรือ BUSINESS — แผนปัจจุบันยังเข้าถึงไม่ได้ อัปเกรดที่ studio.heroaiengine.com/pricing";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

type Extra = { authInfo?: AuthInfo };
function principalFrom(extra: Extra) {
  const e = (extra.authInfo?.extra ?? {}) as { userId?: string; effectivePlan?: string; user?: User };
  return { userId: e.userId, effectivePlan: e.effectivePlan, user: e.user };
}

// Per-tool guard (PRO/BUSINESS) + audit wrapper.
async function runTool(
  toolName: string,
  extra: Extra,
  fn: (p: { userId: string; user: User }) => Promise<unknown>,
  args?: unknown,
) {
  const started = Date.now();
  const { userId, effectivePlan, user } = principalFrom(extra);
  if (!userId || !user || !effectivePlan || !mcpAccessAllowed(effectivePlan)) {
    await recordToolCall({ userId, toolName, status: "denied", durationMs: Date.now() - started, requestJson: args });
    return text({ error: "plan_required", message: UPSELL });
  }
  try {
    const result = await fn({ userId, user });
    await recordToolCall({ userId, toolName, status: "ok", durationMs: Date.now() - started, requestJson: args });
    return text(result);
  } catch {
    await recordToolCall({ userId, toolName, status: "error", durationMs: Date.now() - started, requestJson: args });
    return text({ error: "internal_error", message: "เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง" });
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
        description: "รายการวิดีโอของผู้ใช้ (ใหม่สุดก่อน)",
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
      { title: "Get video status", description: "สถานะของวิดีโอ 1 รายการ", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("get_video_status", extra, async (p) => getVideoStatusTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "get_video",
      { title: "Get video", description: "รายละเอียดวิดีโอ 1 รายการ", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("get_video", extra, async (p) => getVideoTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "download_video",
      { title: "Download video", description: "ลิงก์ดาวน์โหลดวิดีโอ (ถ้าเรนเดอร์เสร็จแล้ว)", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("download_video", extra, async (p) => downloadVideoTool(p.userId, args.videoId), args),
    );
  },
  { serverInfo: { name: "heroai", version: "0.1.0" }, capabilities: { tools: {} } },
  { basePath: "/api", maxDuration: 60, verboseLogs: process.env.NODE_ENV === "development" },
);

// Bearer PAT → principal stored in authInfo.extra (consumed by runTool).
const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  const principal = await resolveMcpPrincipal(bearerToken);
  if (!principal) return undefined; // invalid/revoked/expired → 401
  return {
    token: bearerToken!,
    scopes: ["heroai:read"],
    clientId: principal.userId,
    extra: { userId: principal.userId, plan: principal.plan, effectivePlan: principal.effectivePlan, user: principal.user },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
