import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { resolveMcpPrincipal, resolveMcpPrincipalByClerkId, mcpAccessAllowed, type McpPrincipal } from "@/lib/mcp/auth";
import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { recordToolCall, isInBandError, auditErrorSummary, auditExceptionSummary } from "@/lib/mcp/audit";
import { SERVER_INSTRUCTIONS, missingKeyError, missingVoiceIdError } from "@/lib/mcp/onboarding";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { decryptKey } from "@/lib/key-crypto";
import { preflightElevenLabs, preflightStockProviders, stockVideoProvidersMayBeUsed } from "@/lib/key-preflight";
import { checkHeygenReadiness, toHeygenBlockedResponse } from "@/lib/heygen-readiness";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import { resolveGeminiVoiceStyle } from "@/lib/gemini-voice-styles";
import {
  getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoJobStatusTool, getVideoTool, downloadVideoTool,
} from "@/lib/mcp/tools";
import type { User, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "@/lib/mcp/video-job";
import { createMcpVideoJob, McpHoldNotEnabledError, mcpEditorProjectEnabledFor } from "@/lib/mcp/chain-export";
import { getRequestPrincipal, runWithRequestPrincipalSlot, setRequestPrincipal } from "@/lib/mcp/request-principal";
import { featureNotEnabledEnvelope } from "@/lib/mcp/tool-gating";
import { registerEditTools } from "@/lib/mcp/edit-tools";
import { registerMediaImportTools } from "@/lib/mcp/media-import-tools";
import { cancelMcpVideoJob } from "@/lib/mcp/video-job-cancel";
import { withClientDisconnectGuard } from "@/lib/mcp/transport-disconnect";
import {
  AI_AUDIO_CEILING_FLOOR_MIN,
  aiAudioCeilingRefusal,
  managedAudioCeilingApplies,
  voiceProviderPlanViolation,
} from "@/lib/render-plan-preflight";
import { canFundAiAudioOverflowFromWallet, checkAiAudioCeiling } from "@/lib/ai-spend-limits";
import { checkClipQuota } from "@/lib/usage-limits";
import { resolveAvatarRequest } from "@/lib/mcp/avatar-steps";
import { getHeyGenOwnAvatars } from "@/lib/heygen-own-avatars";
import {
  HEYGEN_ENGINE_INCOMPATIBLE_MESSAGE,
  HEYGEN_ENGINE_UNKNOWN_MESSAGE,
  heygenLookEngineCompatibility,
} from "@/lib/heygen-avatar-engine";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { pipelineCaller } from "@/lib/mcp/pipeline-client";
import { getVideoOptions } from "@/lib/mcp/video-options";
import { resolveMcpSubtitleDesign, brandSubtitleStyleMissingWarning } from "@/lib/mcp/orchestrator-steps";
import { resolveMcpBrandSubtitleStyle, listActiveBrandProfilesForMcp } from "@/lib/brand-profile-library.server";
import type { SubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { assertRenderEnqueueOpen, RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import { createVideoJobInputShape } from "@/lib/mcp/create-video-input";
import {
  abandonClipImport,
  clipFieldsRequested,
  duplicateClipJobReply,
  parseClipJobArgs,
  settleClipImportJobSafely,
  startClipImport,
  type StartedClipImport,
} from "@/lib/mcp/clip-video-job";
import { mcpBrollJobFields, mcpBrollSource } from "@/lib/mcp/broll-source";
import { mcpBrollCreateRefusal } from "@/lib/mcp/broll-source.server";
import { estimateClipSecV2 } from "@/app/(dashboard)/video-editor/_v2/estimate";
import { avatarFullDurationViolation } from "@/lib/avatar-duration";

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
    return text(result);
  } catch (err) {
    await recordToolCall({ userId, toolName, status: "error", durationMs: Date.now() - started, requestJson: args, userAgent, responseJson: auditExceptionSummary(err) });
    const message = "เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง";
    return text(opts
      ? { error: "internal_error", code: "internal_error", message, next: opts.next }
      : { error: "internal_error", message });
  }
}

const EXPORT_MODE_NEXT = "เรียก create_video_job อีกครั้งโดยไม่ระบุ exportMode (วิดีโอจะส่งออกอัตโนมัติ)";
const CLIP_FIELDS_NEXT = "เรียก create_video_job อีกครั้งพร้อม script โดยไม่ระบุ clipUrl / clipUploadId / cutawayLayout";

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
      { title: "Get video options", description: "ตัวเลือกจริงสำหรับสร้างวิดีโอ: เพลง/avatar/เสียง/B-roll/โหมดซับ — ใช้ตอนไกด์ผู้ใช้", inputSchema: {} },
      async (_args, extra) => runTool("get_video_options", extra, async (p) =>
        getVideoOptions(pipelineCaller(p.userId), p.user, await listActiveBrandProfilesForMcp(p.userId))),
    );

    server.registerTool(
      "create_video_job",
      {
        title: "Create video job",
        description: "สร้างวิดีโอ auto (เสียง + b-roll + ซับไทย) จากสคริปต์ แบบ async — คืน jobId แล้ว poll ด้วย get_video_status. brollSource = stock (วิดีโอสต็อกฟรี, ค่าเริ่มต้น) | hero-ai-image | automix. ใส่ avatarMode (full/bookend/bookend-both) เพื่อเพิ่มพิธีกร AI (ต้องมี HeyGen key + avatarId) แจ้งผู้ใช้ทุกข้อใน warnings. แบรนด์ (brandProfileId) มีผลกับสไตล์ซับเท่านั้น. มีคลิปพิธีกรแนวตั้งอยู่แล้ว (เช่น ทำจาก HeyGen): ส่ง clipUrl (ลิงก์ https สาธารณะ) หรือ clipUploadId (จาก create_upload_url kind presenter) แทน script — ระบบนำเข้าคลิปก่อน (status queued) แล้วทำซับจากเสียงในคลิปและสลับ B-roll; cutawayLayout fillYourself = ไม่ใส่ B-roll อัตโนมัติ (ใส่เองด้วย replace_broll_window). นำเข้าไม่สำเร็จ = งาน failed พร้อม errorCode และไม่ตัดโควต้า.",
        inputSchema: createVideoJobInputShape,
      },
      async (args, extra) =>
        runTool("create_video_job", extra, async (p) => {
          const u = p.user;
          // T6 (ADR 0064, G2): exportMode is beta-gated; refused before any preflight or write.
          // T14 (G2): so are the presenter-clip fields (clipUrl / clipUploadId / cutawayLayout).
          const clipRequested = clipFieldsRequested(args);
          if ((args.exportMode !== undefined || clipRequested) && !mcpEditorProjectEnabledFor(u)) {
            return featureNotEnabledEnvelope(clipRequested ? CLIP_FIELDS_NEXT : EXPORT_MODE_NEXT);
          }
          // T14: server-side either/or rules (the schema stays flat, G13). clip === null is the
          // plain script job, exactly as before; a script-less call needs a clip.
          const clipArgs = parseClipJobArgs(args);
          if (!clipArgs.ok) return clipArgs.failure;
          const clip = clipArgs.clip;
          // T14-A2: a clip retry with a used idempotencyKey answers with the existing job before
          // any cap or import — a retry never queues a second import (the plain path is unchanged).
          if (clip && args.idempotencyKey !== undefined) {
            const duplicate = await duplicateClipJobReply(p.userId, args.idempotencyKey);
            if (duplicate) return duplicate;
          }
          const fillYourself = clip?.cutawayLayout === "fillYourself";
          const hold = args.exportMode === "hold";
          try {
            await assertRenderEnqueueOpen();
          } catch (error) {
            if (error instanceof RenderDeployDrainError) {
              return { error: "render_maintenance", retryable: true, message: RENDER_MAINTENANCE_CUSTOMER_MESSAGE };
            }
            throw error;
          }
          const fullAvatarDurationViolation = avatarFullDurationViolation({
            mode: args.avatarMode,
            durationSec: estimateClipSecV2(args.script ?? ""),
          });
          if (fullAvatarDurationViolation) {
            return {
              error: fullAvatarDurationViolation.code,
              message: fullAvatarDurationViolation.message,
              userAction: fullAvatarDurationViolation.userAction,
              maxDurationSec: fullAvatarDurationViolation.maxDurationSec,
              estimatedDurationSec: fullAvatarDurationViolation.durationSec,
            };
          }
          // A clip job speaks with the clip's own audio: no TTS, so no voice gates (T14).
          const useEleven = !clip && (args.voiceProvider === "elevenlabs" || (!args.voiceProvider && u.ttsProvider === "elevenlabs"));
          // Same plan gate the web create path runs (#301) — refuse before the job row
          // exists instead of letting the pipeline die at the TTS step with no CTA.
          const voicePlan = useEleven ? voiceProviderPlanViolation("elevenlabs", u.plan) : null;
          if (voicePlan) {
            return {
              error: voicePlan.code,
              message: `${voicePlan.message} — ${voicePlan.userAction}`,
              neededPlan: voicePlan.neededPlan,
            };
          }
          if (useEleven && !u.elevenlabsKey) return missingKeyError("elevenlabs");
          if (useEleven && !args.voiceId && !u.elevenlabsVoiceId) return missingVoiceIdError();
          let geminiKeyMode: "managed" | "byok" = "byok";
          try { geminiKeyMode = resolveGeminiKey(u).mode; }
          catch (e) { if (e instanceof KeyRequiredError) return missingKeyError("gemini"); throw e; }
          // Same AI-audio ceiling gate the web create path runs (HERO-25). MCP has no
          // toast to read an error out of, so an in-pipeline 429 is even less visible
          // here than it is in the editor.
          // MCP exposes only gemini and elevenlabs (createVideoJobInputShape), so there is
          // no Hero Voice branch to write here.
          if (!clip && managedAudioCeilingApplies(useEleven ? "elevenlabs" : "gemini", geminiKeyMode)) {
            const audioCeiling = await checkAiAudioCeiling(u.id, { enforce: true });
            const walletCanFundOverflow = audioCeiling.remaining < AI_AUDIO_CEILING_FLOOR_MIN
              ? await canFundAiAudioOverflowFromWallet(u.id)
              : false;
            const audioRefusal = aiAudioCeilingRefusal(audioCeiling, u.plan, { walletCanFundOverflow });
            if (audioRefusal) {
              return {
                error: audioRefusal.code,
                message: `${audioRefusal.message} — ${audioRefusal.userAction}`,
                neededPlan: audioRefusal.neededPlan,
              };
            }
          }
          const brollSource = mcpBrollSource(args.brollSource);
          const brollFields = mcpBrollJobFields(brollSource);
          // T14 fillYourself: every window stays with the presenter (auto B-roll off, HERO-44's
          // stockSource "none"), so no stock key and no B-roll source gate apply.
          const needsStockKey = !fillYourself && stockVideoProvidersMayBeUsed({
            stockSource: brollFields.stockSource ?? "stock",
            autoMixProviders: brollFields.autoMixProviders,
          });
          if (needsStockKey && !u.pexelsKey && !u.pixabayKey) return missingKeyError("broll");
          const brollRefusal = fillYourself ? null : await mcpBrollCreateRefusal(u, brollSource);
          if (brollRefusal) return brollRefusal;
          // Key VALIDITY preflight (Task 7, 2026-07-16 stability audit) — mirrors the
          // same guard in /api/videos/jobs (web). See @/lib/key-preflight for the
          // fail-open rationale (only a confirmed 401/403 blocks job creation).
          const [elevenBlock, stockPreflight] = await Promise.all([
            useEleven && u.elevenlabsKey
              ? preflightElevenLabs(decryptKey(u.elevenlabsKey))
              : Promise.resolve(null),
            needsStockKey
              ? preflightStockProviders({
                  pexelsKey: u.pexelsKey ? decryptKey(u.pexelsKey) : null,
                  pixabayKey: u.pixabayKey ? decryptKey(u.pixabayKey) : null,
                })
              : Promise.resolve({ block: null, providers: [] as const }),
          ]);
          const keyBlock = elevenBlock ?? stockPreflight.block;
          if (keyBlock) return { error: "invalid_key", missingKey: keyBlock.key, message: keyBlock.message };
          const avatar = resolveAvatarRequest(
            { avatarMode: args.avatarMode, avatarId: args.avatarId, avatarEngine: args.avatarEngine, avatarIntroSecs: args.avatarIntroSecs, avatarTailSecs: args.avatarTailSecs,
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
          if (avatar.kind === "ok" && u.heygenKey) {
            let compatibility: ReturnType<typeof heygenLookEngineCompatibility> = "unknown";
            try {
              const own = await getHeyGenOwnAvatars(p.userId, decryptKey(u.heygenKey), { refresh: true });
              compatibility = heygenLookEngineCompatibility(own.avatars, avatar.avatarId, avatar.avatarEngine);
            } catch {
              // Capability must be fresh and explicit. A catalog timeout therefore
              // refuses this pre-create request with the owned retry copy.
            }
            if (compatibility === "unknown") {
              return { error: "avatar_engine_unknown", message: HEYGEN_ENGINE_UNKNOWN_MESSAGE };
            }
            if (compatibility === "incompatible") {
              return { error: "avatar_engine_incompatible", message: HEYGEN_ENGINE_INCOMPATIBLE_MESSAGE };
            }
          }
          const heygenWarning = heygenReadiness?.kind === "unknown" ? heygenReadiness.message : undefined;
          // Gate like web (jobs/route.ts:585-589): same function, same env var. A denied
          // non-neutral request is never dropped silently — it falls back to neutral and
          // the caller is told why (#T5, recon.md §E — MCP used to drop this unconditionally).
          const geminiVoiceStyleGateOpen = isInternalAiBetaEnabledFor(u, process.env.GEMINI_TTS_38_PUBLIC === "1");
          const geminiVoiceStyle = geminiVoiceStyleGateOpen
            ? resolveGeminiVoiceStyle(args.geminiVoiceStyle).id
            : "neutral";
          // Every create-time finding lands here; T4 appends more with one line each.
          const warnings: string[] = [];
          if (heygenWarning) warnings.push(heygenWarning);
          if (!clip && !geminiVoiceStyleGateOpen && args.geminiVoiceStyle && args.geminiVoiceStyle !== "neutral") {
            warnings.push("โหมดสไตล์เสียง Gemini (geminiVoiceStyle) ยังไม่เปิดใช้งานสำหรับบัญชีนี้ ใช้เสียงปกติ (neutral) แทน");
          }
          if (clip) {
            const ignored = (["script", "voiceProvider", "voiceId", "geminiVoiceName", "geminiVoiceStyle"] as const)
              .filter((key) => args[key] !== undefined);
            if (ignored.length) {
              warnings.push(`งานจากคลิปพิธีกรใช้เสียงและคำพูดในคลิปเอง จึงไม่ใช้ ${ignored.join(", ")} ที่ส่งมา`);
            }
            if (fillYourself && args.brollSource !== undefined) {
              warnings.push("cutawayLayout \"fillYourself\" ไม่ใส่ B-roll อัตโนมัติ จึงไม่ใช้ brollSource ที่ส่งมา — ใส่ B-roll เองด้วย replace_broll_window");
            }
          }
          // T4: Brand Subtitle Style — owner-checked, active-only (resolveMcpBrandSubtitleStyle).
          // A foreign or inactive brandProfileId refuses identically (never reveals which it was).
          // Without an explicit id: one active brand auto-picks; more than one only warns (never
          // guesses which). This affects the subtitle look only — never voice, visuals or logo.
          let brandSubtitleStyle: SubtitleStylePresetConfig | null = null;
          // T7 Part B: the brand lookup that actually resolved (explicit id or the
          // single-brand auto pick), kept only to decide whether the "brand has no
          // subtitle style" warning fires. null when no brand was looked up at all.
          let resolvedBrandLookup: { found: boolean; style?: SubtitleStylePresetConfig | null } | null = null;
          if (args.brandProfileId) {
            const brandLookup = await resolveMcpBrandSubtitleStyle(p.userId, args.brandProfileId);
            if (!brandLookup.found) {
              return { error: "brand_not_found", message: "ไม่พบแบรนด์นี้ หรือยังใช้ไม่ได้ในขณะนี้" };
            }
            brandSubtitleStyle = brandLookup.style;
            resolvedBrandLookup = brandLookup;
          } else {
            const activeBrands = await listActiveBrandProfilesForMcp(p.userId);
            if (activeBrands.length === 1) {
              const soleBrandLookup = await resolveMcpBrandSubtitleStyle(p.userId, activeBrands[0].brandProfileId);
              brandSubtitleStyle = soleBrandLookup.found ? soleBrandLookup.style : null;
              resolvedBrandLookup = soleBrandLookup;
            } else if (activeBrands.length > 1) {
              warnings.push(`มีแบรนด์ให้เลือก ${activeBrands.length} แบรนด์ — ระบุ brandProfileId เพื่อใช้สไตล์ซับของแบรนด์`);
            }
          }
          const missingBrandStyleWarning = brandSubtitleStyleMissingWarning(resolvedBrandLookup);
          if (missingBrandStyleWarning) warnings.push(missingBrandStyleWarning);
          // Resolution order: explicit MCP args → Brand Subtitle Style → DEFAULT_V2_SUB.
          // Persisted into job inputJson below so the orchestrator cuts cards once for the
          // real size and the burned overlay matches it (T4 Global Constraints).
          const { design: resolvedSubtitleDesign, cardLen: resolvedSubtitleCardLen } = resolveMcpSubtitleDesign(
            {
              subtitleSize: args.subtitleSize,
              subtitleStyle: args.subtitleStyle,
              subtitleColor: args.subtitleColor,
              subtitleAccentColor: args.subtitleAccentColor,
              subtitlePosition: args.subtitlePosition,
              subtitleMode: args.subtitleMode,
            },
            brandSubtitleStyle,
          );
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
          // T14: queue the presenter import (or find the caller's own upload) last, so a refusal
          // above never leaves an import behind. Nothing is reserved here (G5).
          let clipImport: StartedClipImport | null = null;
          if (clip) {
            const started = await startClipImport(p.userId, clip.source);
            if (!started.ok) return started.failure;
            clipImport = started.started;
          }
          try {
            // T8 (ADR 0063): with the MCP Editor Project flag on for this user, this also
            // opens an Agent-created Project and marks the job for the server-chained export.
            // Flag off = the exact PR-A createVideoJob call.
            const created = await createMcpVideoJob(
              p.user,
              clip && clipImport
                // T14 (A10, G28): an upload-mode job parked until the import is ready; it carries
                // only the import id — input.clipUrl is set later from the import's own output.
                ? {
                    script: "", title: args.title, mode: "upload", clipImportId: clipImport.importId,
                    cutawayLayout: clip.cutawayLayout,
                    ...(args.bgmFile ? { bgmFile: args.bgmFile, bgmVolume: args.bgmVolume } : {}),
                    ...(args.subtitleMode ? { subtitleMode: args.subtitleMode } : {}),
                    ...(args.subtitlePosition ? { subtitlePosition: args.subtitlePosition } : {}),
                    subtitleDesign: resolvedSubtitleDesign,
                    subtitleCardLen: resolvedSubtitleCardLen,
                    ...(fillYourself ? { stockSource: "none" } : brollFields),
                    ...(stockPreflight.providers.length ? { stockProviders: stockPreflight.providers } : {}),
                  }
                : {
                script: args.script, title: args.title, voiceProvider: args.voiceProvider, voiceId: args.voiceId,
                ...(args.geminiVoiceName ? { geminiVoiceName: args.geminiVoiceName } : {}),
                ...(geminiVoiceStyle !== "neutral" ? { geminiVoiceStyle } : {}),
                ...(avatar.kind === "ok" && avatarLayout
                  ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarEngine: avatar.avatarEngine, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs,
                      avatarScale: avatarLayout.scale, avatarOffsetX: avatarLayout.offsetX, avatarOffsetY: avatarLayout.offsetY }
                  : {}),
                ...(args.bgmFile ? { bgmFile: args.bgmFile, bgmVolume: args.bgmVolume } : {}),
                ...(args.subtitleMode ? { subtitleMode: args.subtitleMode } : {}),
                ...(args.subtitlePosition ? { subtitlePosition: args.subtitlePosition } : {}),
                subtitleDesign: resolvedSubtitleDesign,
                subtitleCardLen: resolvedSubtitleCardLen,
                ...brollFields,
                ...(stockPreflight.providers.length ? { stockProviders: stockPreflight.providers } : {}),
              },
              args.idempotencyKey,
              { title: args.title, ...(hold ? { hold: true } : {}), ...(clip ? { waitingImport: true } : {}) },
            );
            // `mcp-chain:` keys belong to the server's chained export — same answer as a reuse.
            if (created.kind === "reserved_key") {
              await abandonClipImport(clipImport);
              return { error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" };
            }
            const job = created.job;
            if (clip) {
              // An upload that is already ready starts at once; otherwise the job waits (no slot).
              await settleClipImportJobSafely(job.id, p.userId);
              return { jobId: job.id, status: "queued",
                message: "รับคลิปแล้ว — กำลังนำเข้าคลิปพิธีกร เมื่อพร้อมงานจะเข้าคิวสร้างวิดีโอเอง",
                ...(warnings.length ? { warning: warnings[0], warnings } : {}),
                nextStep: "นำเข้าคลิปก่อน (สถานะ queued, currentStep \"import\") แล้วจึงสร้างวิดีโอ ~3–6 นาที. เช็คด้วย get_video_status ทุก ~60–90 วินาที (อย่าถี่กว่านั้น). ถ้านำเข้าไม่สำเร็จ งานจะ failed พร้อม errorCode และไม่ตัดโควต้า",
                cutawayLayout: clip.cutawayLayout,
                ...(hold
                  ? {
                      exportMode: "hold",
                      next: fillYourself
                        ? "poll get_video_status จนได้ status \"held\" แล้วใส่ B-roll เองทีละช่วงด้วย replace_broll_window (ดู windows จาก get_edit_state) แล้วจึงเรียก export_video(jobId)"
                        : "poll get_video_status จนได้ status \"held\" แล้วเรียก get_edit_state(jobId) เพื่อตรวจ/แก้ แล้วจึงเรียก export_video(jobId)",
                    }
                  : {}) };
            }
            return { jobId: job.id, status: "queued", message: "งานเข้าคิวแล้ว",
              ...(warnings.length ? { warning: warnings[0], warnings } : {}),
              nextStep: avatar.kind === "ok"
                ? "มี avatar (เรนเดอร์ผ่าน HeyGen) — ใช้เวลานาน ~15–25 นาที. เช็คด้วย get_video_status ทุก ~2 นาที (อย่าถี่กว่านั้น)"
                : "เรนเดอร์ปกติ ~3–6 นาที; คลิปสคริปต์ยาวหรือซับโหมดถี่ (1–2 คำ ฉากเยอะ) อาจถึง ~15–20 นาที. เช็คด้วย get_video_status ทุก ~60–90 วินาที (อย่าถี่กว่านั้น)",
              ...(hold
                ? {
                    exportMode: "hold",
                    next: "poll get_video_status จนได้ status \"held\" แล้วเรียก get_edit_state(jobId) เพื่อตรวจ/แก้ซับ แล้วจึงเรียก export_video(jobId)",
                  }
                : {}) };
          } catch (e) {
            // T14: the job was not created — stop a url import this call queued.
            await abandonClipImport(clipImport);
            if (e instanceof McpHoldNotEnabledError) return featureNotEnabledEnvelope(clip ? CLIP_FIELDS_NEXT : EXPORT_MODE_NEXT);
            if ((e as { code?: string })?.code === "P2002") return { error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" };
            throw e; // real DB error → runTool catch audits "error" + returns internal_error
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
