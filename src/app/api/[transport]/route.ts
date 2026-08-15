import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { resolveMcpPrincipal, resolveMcpPrincipalByClerkId, mcpAccessAllowed, type McpPrincipal } from "@/lib/mcp/auth";
import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { recordToolCall, isInBandError } from "@/lib/mcp/audit";
import { SERVER_INSTRUCTIONS, missingKeyError, missingVoiceIdError } from "@/lib/mcp/onboarding";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { decryptKey } from "@/lib/key-crypto";
import { preflightElevenLabs, preflightStockProviders } from "@/lib/key-preflight";
import { checkHeygenReadiness, toHeygenBlockedResponse } from "@/lib/heygen-readiness";
import {
  getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoJobStatusTool, getVideoTool, downloadVideoTool,
} from "@/lib/mcp/tools";
import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createVideoJob,
  VIDEO_JOB_INFLIGHT_STATUSES,
} from "@/lib/mcp/video-job";
import { checkClipQuota } from "@/lib/usage-limits";
import { resolveAvatarRequest } from "@/lib/mcp/avatar-steps";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { pipelineCaller } from "@/lib/mcp/pipeline-client";
import { getVideoOptions } from "@/lib/mcp/video-options";
import { assertRenderEnqueueOpen, RenderDeployDrainError } from "@/lib/render-deploy-drain";
import { createVideoJobInputShape } from "@/lib/mcp/create-video-input";

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
    await recordToolCall({ userId, toolName, status: isInBandError(result) ? "error" : "ok", durationMs: Date.now() - started, requestJson: args });
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
      { title: "Get video/job status", description: "สถานะของ video job หรือ video 1 รายการ (รับ id ของ job หรือ video)", inputSchema: { id: z.string().min(1) } },
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
      { title: "Get video", description: "รายละเอียดวิดีโอ 1 รายการ", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("get_video", extra, async (p) => getVideoTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "download_video",
      { title: "Download video", description: "ลิงก์ดาวน์โหลดวิดีโอ (ถ้าเรนเดอร์เสร็จแล้ว)", inputSchema: { videoId: z.string().min(1) } },
      async (args, extra) => runTool("download_video", extra, async (p) => downloadVideoTool(p.userId, args.videoId), args),
    );

    server.registerTool(
      "get_video_options",
      { title: "Get video options", description: "ตัวเลือกจริงสำหรับสร้างวิดีโอ: เพลง/avatar/เสียง/โหมดซับ — ใช้ตอนไกด์ผู้ใช้", inputSchema: {} },
      async (_args, extra) => runTool("get_video_options", extra, async (p) => getVideoOptions(pipelineCaller(p.userId), p.user)),
    );

    server.registerTool(
      "create_video_job",
      {
        title: "Create video job",
        description: "สร้างวิดีโอ auto (เสียง + b-roll + ซับไทย) จากสคริปต์ แบบ async — คืน jobId แล้ว poll ด้วย get_video_status. ใส่ avatarMode (full/bookend/bookend-both) เพื่อเพิ่มพิธีกร AI (ต้องมี HeyGen key + avatarId)",
        inputSchema: createVideoJobInputShape,
      },
      async (args, extra) =>
        runTool("create_video_job", extra, async (p) => {
          const u = p.user;
          try {
            await assertRenderEnqueueOpen();
          } catch (error) {
            if (error instanceof RenderDeployDrainError) {
              return { error: "render_maintenance", retryable: true, message: "ระบบเรนเดอร์กำลังปรับปรุงชั่วคราว กรุณาลองใหม่" };
            }
            throw error;
          }
          const useEleven = args.voiceProvider === "elevenlabs" || (!args.voiceProvider && u.ttsProvider === "elevenlabs");
          if (useEleven && !u.elevenlabsKey) return missingKeyError("elevenlabs");
          if (useEleven && !args.voiceId && !u.elevenlabsVoiceId) return missingVoiceIdError();
          try { resolveGeminiKey(u); }
          catch (e) { if (e instanceof KeyRequiredError) return missingKeyError("gemini"); throw e; }
          if (!u.pexelsKey && !u.pixabayKey) return missingKeyError("broll");
          // Key VALIDITY preflight (Task 7, 2026-07-16 stability audit) — mirrors the
          // same guard in /api/videos/jobs (web). See @/lib/key-preflight for the
          // fail-open rationale (only a confirmed 401/403 blocks job creation).
          const [elevenBlock, stockPreflight] = await Promise.all([
            useEleven && u.elevenlabsKey
              ? preflightElevenLabs(decryptKey(u.elevenlabsKey))
              : Promise.resolve(null),
            preflightStockProviders({
              pexelsKey: u.pexelsKey ? decryptKey(u.pexelsKey) : null,
              pixabayKey: u.pixabayKey ? decryptKey(u.pixabayKey) : null,
            }),
          ]);
          const keyBlock = elevenBlock ?? stockPreflight.block;
          if (keyBlock) return { error: "invalid_key", missingKey: keyBlock.key, message: keyBlock.message };
          const avatar = resolveAvatarRequest(
            { avatarMode: args.avatarMode, avatarId: args.avatarId, avatarIntroSecs: args.avatarIntroSecs, avatarTailSecs: args.avatarTailSecs,
              avatarScale: args.avatarScale, avatarOffsetX: args.avatarOffsetX, avatarOffsetY: args.avatarOffsetY },
            u,
          );
          if (avatar.kind === "error") return avatar.payload;
          const heygenReadiness = avatar.kind === "ok" && u.heygenKey
            ? await checkHeygenReadiness({ apiKey: decryptKey(u.heygenKey) })
            : null;
          if (heygenReadiness?.kind === "blocked") {
            return toHeygenBlockedResponse(heygenReadiness).body;
          }
          const heygenWarning = heygenReadiness?.kind === "unknown" ? heygenReadiness.message : undefined;
          // Resolve the composite layout: caller-supplied wins; otherwise load the saved preset.
          const avatarLayout =
            avatar.kind === "ok"
              ? resolveAvatarLayout(
                  { avatarScale: args.avatarScale, avatarOffsetX: args.avatarOffsetX, avatarOffsetY: args.avatarOffsetY },
                  await getAvatarPreset(p.userId, avatar.avatarId),
                )
              : null;
          if (process.env.MINUTE_QUOTA !== "1") {
            const q = await checkClipQuota(p.userId);
            if (q && !q.allowed) return { error: "quota_exceeded", message: q.message };
          }
          // Throttle: cap in-flight jobs per user so a member can't flood the shared worker
          // queue (there is no global render queue). Adjustable.
          const inflight = await prisma.videoJob.count({ where: { userId: p.userId, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } });
          if (inflight >= 3) return { error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" };
          try {
            const job = await createVideoJob(
              p.userId,
              {
                script: args.script, title: args.title, voiceProvider: args.voiceProvider, voiceId: args.voiceId,
                ...(args.geminiVoiceName ? { geminiVoiceName: args.geminiVoiceName } : {}),
                ...(avatar.kind === "ok" && avatarLayout
                  ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs,
                      avatarScale: avatarLayout.scale, avatarOffsetX: avatarLayout.offsetX, avatarOffsetY: avatarLayout.offsetY }
                  : {}),
                ...(args.bgmFile ? { bgmFile: args.bgmFile, bgmVolume: args.bgmVolume } : {}),
                ...(args.subtitleMode ? { subtitleMode: args.subtitleMode } : {}),
                ...(args.subtitlePosition ? { subtitlePosition: args.subtitlePosition } : {}),
                ...(stockPreflight.providers.length ? { stockProviders: stockPreflight.providers } : {}),
              },
              args.idempotencyKey,
            );
            return { jobId: job.id, status: "queued", message: "งานเข้าคิวแล้ว", ...(heygenWarning ? { warning: heygenWarning } : {}),
              nextStep: avatar.kind === "ok"
                ? "มี avatar (เรนเดอร์ผ่าน HeyGen) — ใช้เวลานาน ~15–25 นาที. เช็คด้วย get_video_status ทุก ~2 นาที (อย่าถี่กว่านั้น)"
                : "เรนเดอร์ปกติ ~3–6 นาที; คลิปสคริปต์ยาวหรือซับโหมดถี่ (1–2 คำ ฉากเยอะ) อาจถึง ~15–20 นาที. เช็คด้วย get_video_status ทุก ~60–90 วินาที (อย่าถี่กว่านั้น)" };
          } catch (e) {
            if ((e as { code?: string })?.code === "P2002") return { error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" };
            throw e; // real DB error → runTool catch audits "error" + returns internal_error
          }
        }, args),
    );
  },
  { serverInfo: { name: "heroai", version: "0.1.0" }, capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  { basePath: "/api", maxDuration: 60, verboseLogs: process.env.NODE_ENV === "development" },
);

function principalAuthInfo(bearerToken: string, principal: McpPrincipal): AuthInfo {
  return {
    token: bearerToken,
    scopes: ["heroai:read"],
    clientId: principal.userId,
    extra: { userId: principal.userId, plan: principal.plan, effectivePlan: principal.effectivePlan, user: principal.user },
  };
}

// Accept EITHER a Personal Access Token (Claude Code / header-capable clients) OR a Clerk
// OAuth access token (Claude desktop app via the OAuth connector). Both resolve to the same
// McpPrincipal, so every tool + the runTool guard work unchanged regardless of how you authed.
const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  // 1. Personal Access Token
  const patPrincipal = await resolveMcpPrincipal(bearerToken);
  if (patPrincipal) return principalAuthInfo(bearerToken!, patPrincipal);

  // 2. Clerk OAuth access token (desktop app)
  try {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const verified = await verifyClerkToken(clerkAuth, bearerToken);
    if (verified) {
      const clerkUserId = (verified.extra as { userId?: string } | undefined)?.userId ?? verified.clientId;
      const principal = await resolveMcpPrincipalByClerkId(clerkUserId);
      if (principal) return principalAuthInfo(bearerToken!, principal);
    }
  } catch {
    // not a valid Clerk OAuth token → fall through to 401
  }
  return undefined;
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
