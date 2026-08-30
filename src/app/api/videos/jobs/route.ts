import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import {
  createVideoJob,
  parseVideoJobOutput,
  VideoJobFundingError,
  VIDEO_JOB_INFLIGHT_STATUSES,
} from "@/lib/mcp/video-job";
import { minutesFromSeconds } from "@/lib/minute-limits";
import { estimateClipSecV2 } from "@/app/(dashboard)/video-editor/_v2/estimate";
import { avatarFullDurationViolation } from "@/lib/avatar-duration";
import { checkClipQuota } from "@/lib/usage-limits";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { decryptKey } from "@/lib/key-crypto";
import {
  preflightElevenLabs,
  preflightStockProviders,
  stockVideoProvidersMayBeUsed,
  type PreflightBlock,
  type StockProvider,
} from "@/lib/key-preflight";
import { checkHeygenReadiness, toHeygenBlockedResponse } from "@/lib/heygen-readiness";
import { resolveAvatarRequest } from "@/lib/mcp/avatar-steps";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { resolveKieImageAccess } from "@/lib/kie-image-guards";
import { parseAutoMixWeights } from "@/lib/automix-weights";
import { parseAutoMixReceiptImageCeiling } from "@/lib/automix-plan";
import { normalizeBrollRegionPreference, normalizeBrollVisualStyle } from "@/lib/broll-preferences";
import {
  assertCurrentEditorExportSource,
  assertEditorProjectOwner,
} from "@/lib/editor-projects";
import { validateWindowEdits } from "@/lib/broll-rerender";
import { BrandAssetError } from "@/lib/brand-assets.server";
import { BrandProfileLibraryError } from "@/lib/brand-profile-library.server";
import { createDurableExportWithStagedLogo } from "@/lib/logo-export.server";
import { createEditorExportSnapshot } from "@/lib/editor-export-snapshot";
import {
  fingerprintVideoJobRequest,
  legacyVideoJobKeyPrefix,
  resolveLegacyVideoJobAttemptKey,
  videoJobOperationKind,
} from "@/lib/video-job-idempotency";
import { assertRenderEnqueueOpen, RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import {
  checkOmniVoiceReady,
  isOmniVoiceUserAllowed,
  isValidOmniVoiceId,
  OmniVoiceConfigError,
  omnivoiceConfig,
  type OmniVoiceBackend,
} from "@/lib/omnivoice";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import { voiceProviderPlanViolation } from "@/lib/render-plan-preflight";
import { prepareHeroVoiceSpeech } from "@/lib/hero-voice-speech";
import {
  HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE,
  HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE,
  resolveHeroAiImageAccess,
  isInternalAiBetaEnabledFor,
  isInternalAiTester,
} from "@/lib/internal-ai-access";
import { AI_IMAGE_MODELS } from "@/lib/ai-image-policy";
import { QUOTA_EXCEEDED_CODE, quotaUpgradeUserAction } from "@/lib/quota-error";
import { describeImageOffer } from "@/lib/image-generation-provider.server";
import { isHeroRunpodRoute, usesCustomRunpodEndpoint } from "@/lib/hero-image-route-policy";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import { normalizeHeadlineHook } from "@/lib/headline-hook";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import {
  prepareProjectVisualPin,
  prepareProjectVisualSnapshotAwaitingPreflight,
  prepareUploadProjectVisualSnapshot,
  projectHasPersistedVisualPin,
  ProjectLookError,
} from "@/lib/project-look.server";
import { contentPreflightSourceHash, type NarrativeSourceKind } from "@/lib/content-preflight.server";
import {
  sceneContentPolicyFromPreference,
} from "@/lib/scene-content-policy";
import {
  prepareBrandVisualJobAcceptance,
  resolveBrandVisualRenderAccess,
} from "@/lib/brand-visual-job-acceptance.server";
import { ensureFirstClipProjectSpine, resolveFirstClipPath } from "@/lib/first-clip-path.server";
import { requiresFirstClipScript } from "@/lib/first-clip-path";
import { resolveManagedStockAccess } from "@/lib/managed-stock.server";

// POST /api/videos/jobs — Editor v2 background render (ADR 0001).
// Creates a VideoJob in PREVIEW MODE: the shared orchestrator runs the full generation
// pipeline server-side (TTS → captions → b-roll → base render → avatar composite) and
// STOPS BEFORE burn, persisting captions/config in outputJson v2 so the editor resumes
// at the subtitle phase. Processed by the same mcp-video-worker as MCP jobs.
//
// Mirrors the MCP create_video_job guards (keys, quota, in-flight cap) but with WEB
// rules: no PRO gate — FREE users render within their clip quota exactly like the
// legacy editor. Charging: the base render reserves the clip/minutes (orchestrator
// skips its burn-refund in preview mode), web burn later charges nothing extra
// (ChargedClip once-per-video, same as today's web flow).

type Body = {
  mode?: unknown; clipUrl?: unknown;
  script?: unknown; voiceProvider?: unknown; voiceId?: unknown; geminiVoiceName?: unknown; omniVoiceId?: unknown;
  avatarMode?: unknown; avatarId?: unknown; avatarIntroSecs?: unknown; avatarTailSecs?: unknown;
  bgmFile?: unknown; bgmVolume?: unknown; stockSource?: unknown;
  targetClipCount?: unknown; kieModel?: unknown; autoMixProviders?: unknown; autoMixWeights?: unknown;
  maxAiImages?: unknown;
  contentPreflightId?: unknown; narrativeSourceKind?: unknown;
  imageEngine?: unknown; imageModel?: unknown;
  brollRegionPreference?: unknown; brollVisualStyle?: unknown; sceneContentPolicy?: unknown;
  subtitleMode?: unknown; subtitlePosition?: unknown; idempotencyKey?: unknown; projectId?: unknown;
  confirmedMeteredMinutes?: unknown;
  // Phase 2 free per-window re-render (mode: "broll-rerender")
  sourceJobId?: unknown; windowEdits?: unknown;
  // Editor v2 durable export (mode: "export")
  subtitleOverlayConfig?: unknown; exportSceneCount?: unknown; editorSnapshot?: unknown;
};

// b-roll sources the v2 UI may request. kie-image / auto-mix = Beta, ADMIN only —
// gate SERVER-SIDE (the UI disables the cards, but that's not security).
const STOCK_SOURCES = new Set(["stock", "kie-image", "auto-mix"]);

const SUB_MODES = new Set(["sentence", "1", "2", "3", "4"]);
const SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const AVATAR_MODES = new Set(["none", "full", "bookend", "bookend-both"]);
// Best-effort only: bundles served before 2026-07-16 have NO code reading `warning` /
// `reloadRecommended` from this response, so a genuinely stale tab shows nothing. The real
// mitigation for stale clients is the legacy attempt-key rotation below (a terminal attempt
// never pins the tab to a dead job), not this payload.
const LEGACY_CLIENT_WARNING = "หน้าเว็บนี้เป็นเวอร์ชันเก่า งานถูกส่งแล้ว กรุณารีเฟรชหน้าก่อนสั่งงานครั้งถัดไป";

/** Read at call time, not module load — a pm2 restart with --update-env must take effect. */
function creditsLiveNow(): boolean {
  return process.env.CREDITS_LIVE === "1";
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() && v.length <= max ? v : undefined;
}
function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

async function replayIdempotentVideoJob(
  userId: string,
  idempotencyKey: string,
  idempotencyFingerprint: string,
  legacyClient = false,
) {
  const existing = await prisma.videoJob.findFirst({
    where: { userId, idempotencyKey },
    select: {
      id: true,
      status: true,
      idempotencyKey: true,
      idempotencyFingerprint: true,
    },
  });
  if (!existing) return null;
  if (
    !existing.idempotencyFingerprint
    || existing.idempotencyFingerprint !== idempotencyFingerprint
  ) {
    return NextResponse.json(
      {
        error: "idempotency_conflict",
        message: "idempotencyKey นี้ถูกใช้กับคำขออื่นแล้ว",
      },
      { status: 409 },
    );
  }
  return NextResponse.json({
    jobId: existing.id,
    status: existing.status,
    idempotencyKey: existing.idempotencyKey,
    idempotencyFingerprint: existing.idempotencyFingerprint,
    idempotentReplay: true,
    ...(legacyClient
      ? {
          legacyClient: true,
          reloadRecommended: true,
          warning: LEGACY_CLIENT_WARNING,
        }
      : {}),
  });
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const [heroAiImageAccess, brandVisualAccess] = await Promise.all([
      resolveHeroAiImageAccess(user),
      resolveBrandVisualAccess(user),
    ]);

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const hasIdempotencyKey = Object.prototype.hasOwnProperty.call(body, "idempotencyKey");
    const requestedIdempotencyKey = str(body.idempotencyKey, 120);
    if (hasIdempotencyKey && !requestedIdempotencyKey) {
      return NextResponse.json(
        { error: "idempotency_key_required", message: "ไม่พบรหัสยืนยันคำขอ กรุณาลองใหม่" },
        { status: 400 },
      );
    }
    const operation = videoJobOperationKind(body as Record<string, unknown>);
    const idempotencyFingerprint = await fingerprintVideoJobRequest(
      operation,
      body as Record<string, unknown>,
    );
    const legacyClient = !hasIdempotencyKey;
    // Legacy mode (client ไม่ได้ส่งคีย์เอง): เลือก "ช่อง attempt" ก่อนแตะอะไรที่ mutable.
    // แท็บเก่าไม่มีคีย์ของตัวเองให้หมุน ถ้าใช้คีย์เดียวตลอดกาล การกดสั่งซ้ำด้วย config เดิม
    // จะได้ job ใบเดิมที่พังไปแล้วคืนตลอด → หมุนเป็น :r2, :r3 เมื่อใบล่าสุด terminal และพ้น window.
    // อ่านอย่างเดียว + deterministic ต่อสถานะ DB จึงยัง dedupe ทั้ง retry เร็ว ๆ และสองแท็บพร้อมกัน
    // (แพ้ unique → P2002 → re-query คีย์เดิมแล้ว replay ด้านล่าง).
    const idempotencyKey = requestedIdempotencyKey ?? resolveLegacyVideoJobAttemptKey(
      idempotencyFingerprint,
      await prisma.videoJob.findMany({
        where: {
          userId: user.id,
          idempotencyKey: { startsWith: legacyVideoJobKeyPrefix(idempotencyFingerprint) },
        },
        select: { idempotencyKey: true, status: true, createdAt: true },
      }),
    );
    const replay = await replayIdempotentVideoJob(
      user.id,
      idempotencyKey,
      idempotencyFingerprint,
      legacyClient,
    );
    if (replay) return replay;
    await assertRenderEnqueueOpen();

    // ── Phase 2: free per-window b-roll re-render (mode: "broll-rerender") ─────────
    // Reuses the source job's TTS + avatar and only swaps b-roll windows → NOTHING new is
    // fetched or charged, so this SKIPS the API-key guards and the clip-quota reserve. It KEEPS
    // auth (above), the in-flight cap of 3, and idempotency. The render route's server-trusted
    // `rerenderOf` skip (not any client flag) is what makes the render itself free; here we only
    // validate shape + ownership up-front and enqueue. The orchestrator re-checks authoritatively.
    if (body.mode === "broll-rerender") {
      const sourceJobId = str(body.sourceJobId, 120);
      if (!sourceJobId) return NextResponse.json({ error: "invalid_source", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 400 });
      const editsRes = validateWindowEdits(body.windowEdits);
      if ("error" in editsRes) return NextResponse.json({ error: "invalid_edits", message: editsRes.error }, { status: 400 });

      const srcJob = await prisma.videoJob.findUnique({
        where: { id: sourceJobId },
        select: {
          userId: true,
          status: true,
          projectId: true,
          contentPreflightId: true,
          projectVisualContextJson: true,
          brandVisualAcceptanceJson: true,
        },
      });
      if (!srcJob || srcJob.userId !== user.id) return NextResponse.json({ error: "source_not_found", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 404 });
      if (srcJob.status !== "done") return NextResponse.json({ error: "source_not_ready", message: "วิดีโอต้นฉบับยังไม่พร้อม (ยังเรนเดอร์ไม่เสร็จ)" }, { status: 400 });
      const brandVisualSceneEdit = Boolean(
        srcJob.projectId && srcJob.contentPreflightId && srcJob.projectVisualContextJson,
      );
      if (
        !brandVisualSceneEdit
        && !isInternalAiBetaEnabledFor(user, process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1")
      ) {
        return NextResponse.json({ error: "not_enabled" }, { status: 404 });
      }

      const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } });
      if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

      try {
        // Inherit the SOURCE job's projectId (server-trusted — never body.projectId) so the
        // new job re-links the EditorProject on finish (finishJob sets activeJobId only when
        // job.projectId is set); otherwise reopening the project reverts to the pre-edit video.
        // srcJob.userId === user.id is already verified above, so this preserves the IDOR guard.
        const job = await createVideoJob(
          user.id,
          { mode: "broll-rerender", previewMode: true, sourceJobId, windowEdits: editsRes },
          idempotencyKey,
          {
            projectId: srcJob.projectId,
            idempotencyFingerprint,
            projectVisualPin: srcJob.projectVisualContextJson ? {
              contentPreflightId: srcJob.contentPreflightId,
              projectVisualContextJson: srcJob.projectVisualContextJson,
            } : null,
            brandVisualAcceptanceJson: srcJob.brandVisualAcceptanceJson,
          },
        );
        return NextResponse.json({
          jobId: job.id,
          status: "queued",
          idempotencyKey,
          idempotencyFingerprint,
          ...(legacyClient
            ? {
                legacyClient: true,
                reloadRecommended: true,
                warning: LEGACY_CLIENT_WARNING,
              }
            : {}),
        });
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") {
          return (await replayIdempotentVideoJob(user.id, idempotencyKey, idempotencyFingerprint, legacyClient))
            ?? NextResponse.json(
              { error: "idempotency_conflict", message: "idempotencyKey นี้ถูกใช้แล้ว" },
              { status: 409 },
            );
        }
        throw e;
      }
    }

    // ── Durable export (mode: "export") ──────────────────────────────────────
    // The browser submits the burn config plus a compact native editor snapshot. The route
    // validates it and joins it to server-owned preview metadata before the worker owns the
    // long burn + Gallery save + project transition.
    if (body.mode === "export") {
      const sourceJobId = str(body.sourceJobId, 120);
      if (!sourceJobId) return NextResponse.json({ error: "invalid_source", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 400 });
      if (!body.subtitleOverlayConfig || typeof body.subtitleOverlayConfig !== "object" || Array.isArray(body.subtitleOverlayConfig)) {
        return NextResponse.json({ error: "invalid_export", message: "ข้อมูลซับสำหรับส่งออกไม่ถูกต้อง" }, { status: 400 });
      }
      const rawLogoOverlay = (body.subtitleOverlayConfig as Record<string, unknown>).logoOverlay;
      const subtitleOverlayConfig: Record<string, unknown> = { ...body.subtitleOverlayConfig };
      delete subtitleOverlayConfig.logoOverlay;

      const srcJob = await prisma.videoJob.findUnique({
        where: { id: sourceJobId },
        select: {
          userId: true,
          status: true,
          outputJson: true,
          projectId: true,
          contentPreflightId: true,
          projectVisualContextJson: true,
        },
      });
      if (!srcJob || srcJob.userId !== user.id) return NextResponse.json({ error: "source_not_found", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 404 });
      if (srcJob.status !== "done") return NextResponse.json({ error: "source_not_ready", message: "วิดีโอต้นฉบับยังไม่พร้อม" }, { status: 400 });
      if (!srcJob.projectId) return NextResponse.json({ error: "project_required", message: "โปรเจกต์นี้ยังไม่พร้อมสำหรับส่งออกแบบทำงานเบื้องหลัง" }, { status: 400 });
      const sourceProjectId = srcJob.projectId;
      await assertCurrentEditorExportSource(user.id, sourceProjectId, sourceJobId);
      const parsed = parseVideoJobOutput(srcJob.outputJson);
      if (!parsed?.preview) return NextResponse.json({ error: "source_not_exportable", message: "วิดีโอต้นฉบับไม่มีข้อมูลสำหรับแก้ซับ/ส่งออก" }, { status: 400 });
      const editSnapshot = body.editorSnapshot === undefined
        ? undefined
        : createEditorExportSnapshot({
            draft: body.editorSnapshot,
            sourcePreview: parsed.preview,
            videoUrl: subtitleOverlayConfig.videoUrl,
          });
      if (body.editorSnapshot !== undefined && !editSnapshot) {
        return NextResponse.json({ error: "invalid_editor_snapshot", message: "ข้อมูลสถานะล่าสุดของหน้าตัดต่อไม่ถูกต้อง" }, { status: 400 });
      }

      const rawHeadlineHook = subtitleOverlayConfig.headlineHook;
      if (rawHeadlineHook !== undefined) {
        const overlayDurationFrames = Number(subtitleOverlayConfig.durationInFrames);
        const overlayDurationMs = Number.isFinite(overlayDurationFrames) && overlayDurationFrames > 0
          ? (overlayDurationFrames / 30) * 1_000
          : 0;
        const headlineHook = normalizeHeadlineHook(
          rawHeadlineHook,
          Math.max(parsed.preview.audioDurationMs, overlayDurationMs),
        );
        if (!headlineHook) {
          return NextResponse.json({ error: "invalid_headline_hook", message: "ข้อมูลพาดหัวเปิดคลิปไม่ถูกต้อง" }, { status: 400 });
        }
        if (headlineHook.enabled) subtitleOverlayConfig.headlineHook = headlineHook;
        else delete subtitleOverlayConfig.headlineHook;
      }

      const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } });
      if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

      try {
        const job = await createDurableExportWithStagedLogo({
          staging: {
            userId: user.id,
            plan: user.plan,
            brandVisualAllowed: brandVisualAccess.canUse
              || await projectHasPersistedVisualPin({ userId: user.id, projectId: sourceProjectId }),
            projectId: sourceProjectId,
            rawLogoOverlay: rawLogoOverlay,
          },
          createDurableJob: async (trustedLogo) => {
            if (trustedLogo) subtitleOverlayConfig.logoOverlay = trustedLogo;
            return createVideoJob(
              user.id,
              {
                mode: "export",
                sourceJobId,
                subtitleOverlayConfig,
                ...(editSnapshot ? { editSnapshot } : {}),
                exportScript: str(body.script, 20000),
                exportSceneCount: num(body.exportSceneCount, 1, 1000),
              },
              idempotencyKey,
              {
                projectId: sourceProjectId,
                type: "export",
                idempotencyFingerprint,
                projectVisualPin: srcJob.projectVisualContextJson
                  ? {
                      contentPreflightId: srcJob.contentPreflightId,
                      projectVisualContextJson: srcJob.projectVisualContextJson,
                    }
                  : null,
              },
            );
          },
          afterDurableJobCreated: async (durableJob) => {
            await prisma.editorProject.updateMany({
              where: { id: sourceProjectId, userId: user.id },
              data: { activeExportJobId: durableJob.id, status: "exporting", lastOpenedAt: new Date() },
            });
          },
        });
        return NextResponse.json({
          jobId: job.id,
          status: "queued",
          idempotencyKey,
          idempotencyFingerprint,
          ...(legacyClient
            ? {
                legacyClient: true,
                reloadRecommended: true,
                warning: LEGACY_CLIENT_WARNING,
              }
            : {}),
        });
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") {
          return (await replayIdempotentVideoJob(user.id, idempotencyKey, idempotencyFingerprint, legacyClient))
            ?? NextResponse.json(
              { error: "idempotency_conflict", message: "idempotencyKey นี้ถูกใช้แล้ว" },
              { status: 409 },
            );
        }
        throw e;
      }
    }

    const projectId = typeof body.projectId === "string" && body.projectId.trim()
      ? await assertEditorProjectOwner(user.id, body.projectId.trim())
      : null;
    const firstClip = await resolveFirstClipPath({ id: user.id, email: user.email, role: user.role });
    const onFirstClipPath = firstClip.onPath;
    if (onFirstClipPath && !projectId) {
      return NextResponse.json(
        { error: "project_required", message: "คลิปแรกต้องมีโปรเจกต์ก่อนสร้าง" },
        { status: 400 },
      );
    }

    // โหมดอัปคลิปเอง (cutaway) — gate ด้วย flag เดียวกับปุ่มใน UI (flip พร้อม EDITOR_V2 วัน launch)
    const uploadMode = body.mode === "upload";
    const clipUrl = uploadMode ? str(body.clipUrl, 500) : undefined;
    if (uploadMode) {
      if (process.env.NEXT_PUBLIC_CLIP_CUTAWAY !== "1") {
        return NextResponse.json({ error: "not_enabled", message: "โหมดใช้คลิปที่ถ่ายเองยังไม่เปิดใช้งาน" }, { status: 403 });
      }
      // รับเฉพาะไฟล์ที่อัปโหลดเข้าระบบเราเอง (จาก /api/videos/upload-avatar) — กัน SSRF
      if (!clipUrl || !(clipUrl.startsWith("/api/") || clipUrl.startsWith("/renders/") || clipUrl.startsWith("/uploads/"))) {
        return NextResponse.json({ error: "invalid_clip", message: "อัปโหลดคลิปก่อนเรนเดอร์" }, { status: 400 });
      }
    }

    const script = typeof body.script === "string" ? body.script.trim() : "";
    if (!uploadMode && (!script || script.length > 20000)) {
      return NextResponse.json({ error: "invalid_script", message: "สคริปต์ว่างหรือยาวเกิน 20,000 ตัวอักษร" }, { status: 400 });
    }
    const estimatedScriptDurationSec = uploadMode ? 0 : estimateClipSecV2(script);
    const avatarModeRaw = !uploadMode && typeof body.avatarMode === "string" && AVATAR_MODES.has(body.avatarMode)
      ? body.avatarMode
      : undefined;
    const fullAvatarDurationViolation = avatarFullDurationViolation({
      mode: avatarModeRaw,
      durationSec: estimatedScriptDurationSec,
    });
    if (fullAvatarDurationViolation) {
      return NextResponse.json({
        error: fullAvatarDurationViolation.code,
        message: fullAvatarDurationViolation.message,
        userAction: fullAvatarDurationViolation.userAction,
        maxDurationSec: fullAvatarDurationViolation.maxDurationSec,
        estimatedDurationSec: fullAvatarDurationViolation.durationSec,
      }, { status: 400 });
    }
    if (requiresFirstClipScript(firstClip) && uploadMode) {
      return NextResponse.json(
        { error: "first_clip_script_required", message: "คลิปแรกใช้สคริปต์ ไม่ใช่คลิปที่ถ่ายเอง" },
        { status: 400 },
      );
    }
    if (onFirstClipPath && projectId) {
      try {
        await ensureFirstClipProjectSpine({ userId: user.id, projectId });
      } catch (error) {
        if (error instanceof BrandProfileLibraryError) {
          return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
        }
        throw error;
      }
    }
    const receiptMinutes = Number(body.confirmedMeteredMinutes);
    const hasConfirmedReceipt = Number.isInteger(receiptMinutes) && receiptMinutes > 0;
    if (process.env.CREDITS_LIVE === "1" && !hasConfirmedReceipt) {
      return NextResponse.json(
        { error: "render_receipt_required", message: "กรุณายืนยันสรุปนาทีและเครดิตก่อนเรนเดอร์" },
        { status: 400 },
      );
    }
    const serverEstimatedMinutes = uploadMode
      ? (hasConfirmedReceipt ? receiptMinutes : 1)
      : minutesFromSeconds(estimatedScriptDurationSec);
    if (!uploadMode && hasConfirmedReceipt && receiptMinutes !== serverEstimatedMinutes) {
      return NextResponse.json(
        { error: "render_receipt_changed", message: "ประมาณการคลิปเปลี่ยนแล้ว กรุณาตรวจและยืนยันอีกครั้ง" },
        { status: 409 },
      );
    }
    const meteredMinutes = hasConfirmedReceipt ? serverEstimatedMinutes : Math.max(1, serverEstimatedMinutes);

    const voiceProvider = body.voiceProvider === "elevenlabs"
      ? "elevenlabs"
      : body.voiceProvider === "omnivoice"
        ? "omnivoice"
        : body.voiceProvider === "gemini"
          ? "gemini"
          : undefined;
    const voiceId = str(body.voiceId, 120);
    const geminiVoiceName = str(body.geminiVoiceName, 60);
    const omniVoiceId = str(body.omniVoiceId, 64);
    let voiceBackend: OmniVoiceBackend | undefined;
    let requestedSource = typeof body.stockSource === "string" && STOCK_SOURCES.has(body.stockSource) ? body.stockSource : "stock";
    let requestedImageEngine = body.imageEngine === "runpod" ? "runpod" : undefined;
    let requestedImageModel = str(body.imageModel, 60);
    // Conversion Trial sample clip spends the 8-image Hero AI Image allowance.
    // GRANT/paid First-Clip Path keeps the caller's stock/AI choice (#267).
    if (firstClip.reason === "conversion_trial" && !uploadMode) {
      requestedSource = "kie-image";
      requestedImageEngine = "runpod";
      requestedImageModel = requestedImageModel || "z-image-turbo";
    }

    if (!uploadMode && voiceProvider === "omnivoice") {
      if (!isOmniVoiceUserAllowed(user)) {
        return NextResponse.json({ error: "not_enabled", message: "Hero Voice ยังไม่เปิดใช้งานสำหรับบัญชีนี้" }, { status: 403 });
      }
      let config: ReturnType<typeof omnivoiceConfig>;
      try {
        config = omnivoiceConfig();
        voiceBackend = config.backend;
      } catch (error) {
        if (error instanceof OmniVoiceConfigError) {
          return NextResponse.json({
            error: "omnivoice_unavailable",
            message: "Hero Voice ยังไม่พร้อมใช้งาน กรุณาสลับเป็น Gemini หรือ ElevenLabs",
          }, { status: 503 });
        }
        throw error;
      }
      if (!await checkOmniVoiceReady(config)) {
        return NextResponse.json({
          error: "omnivoice_unavailable",
          message: "Hero Voice ยังไม่พร้อมรับงาน กรุณาลองใหม่ภายหลังหรือสลับเป็น Gemini/ElevenLabs",
        }, { status: 503 });
      }
      const planScriptCap = omnivoiceScriptCharCapForPlan(user.plan);
      if (script.length > planScriptCap) {
        return NextResponse.json({
          error: "omnivoice_script_too_long",
          message: `สคริปต์ Hero Voice ยาวเกินแพ็กเกจ ${user.plan} กรุณาย่อให้ไม่เกินประมาณ ${planScriptCap.toLocaleString("th-TH")} ตัวอักษร`,
          maxChars: planScriptCap,
        }, { status: 413 });
      }
      if (!omniVoiceId || !isValidOmniVoiceId(omniVoiceId)) {
        return NextResponse.json({ error: "missing_voice_id", message: "กรุณาเลือกเสียง Hero Voice" }, { status: 400 });
      }
      const blockingSpeechRisks = prepareHeroVoiceSpeech(script).risks.filter(
        (risk) => risk.severity === "block",
      );
      if (blockingSpeechRisks.length > 0) {
        return NextResponse.json({
          error: "omnivoice_speech_token_unsupported",
          message: "Hero Voice พบสัญลักษณ์ที่ยังไม่มีคำอ่านภาษาไทย กรุณาเขียนสัญลักษณ์นั้นเป็นคำแล้วลองใหม่",
          riskCategories: blockingSpeechRisks.map((risk) => risk.code),
        }, { status: 422 });
      }
    }

    // Key guards — same checks as MCP create_video_job, same wording surface (web shows toasts)
    // upload mode ไม่ใช้ TTS → ข้าม guard ฝั่งเสียง (Gemini ยังจำเป็น: transcribe/keywords)
    const useEleven = !uploadMode && (voiceProvider === "elevenlabs" || (!voiceProvider && user.ttsProvider === "elevenlabs"));
    // Plan gate BEFORE the job row exists (#301). `/api/videos/tts` already refuses a
    // FREE account, but only once the pipeline reaches the TTS step — the customer has
    // waited, minutes are reserved, and the refusal lands in VideoJob.errorMessage with
    // no CTA. Same rule, applied here, turns that into an actionable 403.
    const voicePlanViolation = useEleven
      ? voiceProviderPlanViolation("elevenlabs", user.plan)
      : null;
    if (voicePlanViolation) {
      return NextResponse.json({
        error: voicePlanViolation.code,
        // The editor toast renders `message` only (apiErrorMessage in useV2Job), so the
        // way out has to live in it — `userAction` stays for structured consumers.
        message: `${voicePlanViolation.message} — ${voicePlanViolation.userAction}`,
        userAction: voicePlanViolation.userAction,
        neededPlan: voicePlanViolation.neededPlan,
      }, { status: 403 });
    }
    if (useEleven && !user.elevenlabsKey) {
      return NextResponse.json({ error: "missing_key", missingKey: "elevenlabs", message: "ต้องใส่ ElevenLabs API key ก่อน (Settings → API Keys)" }, { status: 400 });
    }
    if (useEleven && !voiceId && !user.elevenlabsVoiceId) {
      return NextResponse.json({ error: "missing_voice_id", message: "ต้องระบุ ElevenLabs Voice ID" }, { status: 400 });
    }
    try { resolveGeminiKey(user); }
    catch (e) {
      if (e instanceof KeyRequiredError) return NextResponse.json({ error: "missing_key", missingKey: "gemini", message: "ต้องใส่ Gemini API key ก่อน (Settings → API Keys)" }, { status: 400 });
      throw e;
    }
    // Managed stock key (#297, ADR 0025 + Amendment 2026-08-26) — flag-gated
    // exception to the BYOK gate. MANAGED_STOCK unset/0 → resolveManagedStockAccess
    // short-circuits to { eligible: false } with ZERO DB work, so this block is the
    // pre-#297 400 exactly. Flag ON → ANY account with no stock key of its own —
    // FREE, trial, PRO, BUSINESS, coupon/grant, bundle — searches on the team key
    // instead of being stopped here, so a PAID keyless account no longer 400s.
    // Only an own key (BYOK wins), a suspension, or a missing server key still refuses.
    if (requestedSource !== "kie-image" && !user.pexelsKey && !user.pixabayKey) {
      const managedStock = await resolveManagedStockAccess(user, {
        hasOwnPexelsKey: false,
        hasOwnPixabayKey: false,
      });
      if (!managedStock.eligible) {
        return NextResponse.json({ error: "missing_key", missingKey: "broll", message: "ต้องใส่ Pexels หรือ Pixabay key อย่างน้อย 1 ตัวสำหรับ B-roll" }, { status: 400 });
      }
    }

    // ElevenLabs VALIDITY preflight (Task 7, 2026-07-16 stability audit) — see the
    // combined preflight block below (after stockSource is resolved) for the full
    // rationale and the Pexels half, which needs stockSource to gate correctly.
    const preflightChecks: Promise<PreflightBlock | null>[] = [];
    if (useEleven && user.elevenlabsKey) preflightChecks.push(preflightElevenLabs(decryptKey(user.elevenlabsKey)));

    // Avatar (optional) — same resolver as MCP; layout falls back to the saved preset.
    // upload mode = ไม่มีอวตารตามดีไซน์
    const avatar = resolveAvatarRequest(
      {
        avatarMode: avatarModeRaw as "none" | "full" | "bookend" | "bookend-both" | undefined,
        avatarId: str(body.avatarId, 120),
        avatarIntroSecs: num(body.avatarIntroSecs, 1, 30),
        avatarTailSecs: num(body.avatarTailSecs, 1, 30),
      },
      user,
    );
    if (avatar.kind === "error") return NextResponse.json(avatar.payload, { status: 400 });
    const avatarLayout = avatar.kind === "ok"
      ? resolveAvatarLayout({}, await getAvatarPreset(user.id, avatar.avatarId))
      : null;
    const heygenReadiness = avatar.kind === "ok" && user.heygenKey
      ? await checkHeygenReadiness({ apiKey: decryptKey(user.heygenKey) })
      : null;
    if (heygenReadiness?.kind === "blocked") {
      const blocked = toHeygenBlockedResponse(heygenReadiness);
      return NextResponse.json(blocked.body, { status: blocked.status });
    }
    const heygenWarning = heygenReadiness?.kind === "unknown" ? heygenReadiness.message : undefined;

    // Minute metering replaces the legacy clip-count cap. Keeping both would strand
    // Purchased Credits after FREE's old two-clip limit even though the wallet can
    // fund more <=2-minute renders.
    if (process.env.MINUTE_QUOTA !== "1") {
      const q = await checkClipQuota(user.id);
      if (q && !q.allowed) {
        // Same envelope fields the render route sends (message + userAction + canBuyCredits),
        // so the editor's quota parser shows one upgrade path regardless of which route refused.
        return NextResponse.json(
          {
            error: QUOTA_EXCEEDED_CODE,
            message: q.message,
            userAction: quotaUpgradeUserAction(false),
            canBuyCredits: false,
          },
          { status: 403 },
        );
      }
    }
    const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } });
    if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

    // B-roll source: "stock" remains public. AI images and AutoMix are a private
    // team beta; the same server policy is checked again inside fetch-stock.
    const useHeroRunpodImage = requestedSource === "kie-image" && requestedImageEngine === "runpod";
    const isAdmin = user.role === "ADMIN";
    const { canUseKieImages } = resolveKieImageAccess({
      managedKieOn: process.env.MANAGED_KIE === "1",
      creditsLive: process.env.CREDITS_LIVE === "1",
      isAdmin,
      isPaidPlan: user.plan === "PRO" || user.plan === "BUSINESS",
      isInternalTester: isInternalAiTester(user),
    });
    const autoMixProviders = requestedSource === "auto-mix" && Array.isArray(body.autoMixProviders)
      ? (body.autoMixProviders.filter((x) => typeof x === "string" && x.length <= 40).slice(0, 12) as string[])
      : undefined;
    const autoMixWeights = requestedSource === "auto-mix"
      ? parseAutoMixWeights(body.autoMixWeights) ?? undefined
      : undefined;
    const autoMixRequestsAi = requestedSource === "auto-mix"
      && (autoMixProviders === undefined || autoMixProviders.includes("kie-ai"))
      && (autoMixWeights?.ai ?? 1) > 0;
    const requestsBrandVisualImage = Boolean(
      projectId && (useHeroRunpodImage || autoMixRequestsAi),
    );
    // Resolve an established immutable pin BEFORE the live Hero rollout gate.
    // Rollback closes new adoption, but must not reject a FREE/Trial project
    // whose exact Project Look/Revision already exists (ADR-0005).
    const hasPersistedProjectPin = requestsBrandVisualImage && projectId
      ? await projectHasPersistedVisualPin({ userId: user.id, projectId })
      : false;
    const brandVisualRenderAccess = resolveBrandVisualRenderAccess({
      requestsBrandVisualImage,
      hasPersistedProjectPin,
      liveAccess: brandVisualAccess,
    });
    if (useHeroRunpodImage) {
      if (!heroAiImageAccess.canUse && !brandVisualRenderAccess) {
        if (heroAiImageAccess.reason === "allowance_exhausted") {
          return NextResponse.json(HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.body, { status: HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.status });
        }
        if (process.env.HERO_AI_IMAGE_PUBLIC === "1") {
          return NextResponse.json(HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.body, { status: HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.status });
        }
        return NextResponse.json({ error: "beta_only", message: "Hero AI Image ยังเปิดเฉพาะทีมงาน (Beta)" }, { status: 403 });
      }
      if (requestedImageModel !== "z-image-turbo") {
        return NextResponse.json({ error: "invalid_image_model", message: "Hero AI Image ต้องใช้โมเดลภาพที่ระบบรองรับ" }, { status: 400 });
      }
      const model = AI_IMAGE_MODELS.find((item) => item.id === "z-image-turbo")!;
      const offer = describeImageOffer(model);
      if (!offer.available || !isHeroRunpodRoute(offer.providerRoute)) {
        return NextResponse.json({
          error: "hero_image_unavailable",
          message: "Hero AI Image ยังไม่พร้อมใช้งานในขณะนี้",
        }, { status: 503 });
      }
      if (usesCustomRunpodEndpoint(offer.providerRoute)) {
        const runpodCost = await getRunpodImageCostSnapshot({
          endpointId: offer.providerEndpoint,
        });
        if (!runpodCost.admitted) {
          return NextResponse.json({
            error: "hero_image_cost_guard",
            message: runpodCost.status === "stale"
              ? "ระบบตรวจสอบต้นทุน Hero AI Image ขาดข้อมูลล่าสุด จึงยังไม่รับงานใหม่"
              : "ต้นทุน Hero AI Image สูงกว่าเพดาน ฿1.08/รูป จึงยังไม่รับงานใหม่",
            retryable: true,
          }, { status: 503 });
        }
      }
    } else if (requestedSource === "auto-mix") {
      // AutoMix "ai" slots now generate on the Hero RunPod seam (fetch-stock), so the
      // mode follows the SAME Hero rollout gate as Hero-only mode; the legacy
      // managed-kie beta cohort keeps its existing access. fetch-stock re-checks both.
      if (!heroAiImageAccess.canUse && !canUseKieImages && !brandVisualRenderAccess) {
        if (heroAiImageAccess.reason === "allowance_exhausted") {
          return NextResponse.json(HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.body, { status: HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.status });
        }
        if (process.env.HERO_AI_IMAGE_PUBLIC === "1") {
          return NextResponse.json(HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.body, { status: HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.status });
        }
        return NextResponse.json({ error: "beta_only", message: "ภาพ AI / AutoMix ยังเปิดเฉพาะทีมงาน (Beta)" }, { status: 403 });
      }
    } else if (requestedSource !== "stock" && (!canUseKieImages || !isAdmin)) {
      // Legacy kie image mode: paused for customers, admin-only (ADR 0004).
      return NextResponse.json({ error: "beta_only", message: "ภาพ AI / AutoMix ยังเปิดเฉพาะทีมงาน (Beta)" }, { status: 403 });
    }
    const stockSource = requestedSource === "stock" ? undefined : requestedSource;

    // ขั้นสูง (P6c): จำนวนคลิป + ตัวเลือก AI-gen (Beta fields ผ่านได้เฉพาะเมื่อ source เป็น Beta
    // ซึ่งผ่าน admin gate ด้านบนแล้ว)
    let targetClipCount = num(body.targetClipCount, 1, 60);
    if (firstClip.reason === "conversion_trial" && !uploadMode) {
      const trialImageCap = Math.max(0, heroAiImageAccess.remainingTrialImages);
      if (trialImageCap < 1) {
        return NextResponse.json(HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.body, {
          status: HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.status,
        });
      }
      targetClipCount = Math.min(targetClipCount ?? trialImageCap, trialImageCap);
    }
    const brollRegionPreference = normalizeBrollRegionPreference(body.brollRegionPreference);
    const brollVisualStyle = normalizeBrollVisualStyle(body.brollVisualStyle);
    const sceneContentPolicy = sceneContentPolicyFromPreference(
      body.sceneContentPolicy ?? brollRegionPreference,
    );
    const kieModel = stockSource && !useHeroRunpodImage ? str(body.kieModel, 60) : undefined;
    // Mix-preset weights (D5.1): only well-formed {video,photo,ai} ints 0–9 are stored;
    // fetch-stock re-validates + gates them behind MANAGED_KIE authoritatively.
    // Disclosure ceiling: the exact NEW/affected AI-image count in the Render Receipt.
    // Current retained assets are reused without consuming this ceiling.
    const maxAiImages = requestedSource === "auto-mix"
      ? parseAutoMixReceiptImageCeiling(body.maxAiImages)
      : null;
    if (requestedSource === "auto-mix" && autoMixRequestsAi && !isAdmin && maxAiImages === null) {
      return NextResponse.json({
        error: "render_receipt_required",
        message: "กรุณาตรวจและยืนยันใบรับงานก่อนเริ่มสร้างภาพ AutoMix",
      }, { status: 400 });
    }
    const requestedContentPreflightId = str(body.contentPreflightId, 120);
    const requestedNarrativeSourceKind: NarrativeSourceKind | undefined = body.narrativeSourceKind === "ai-script"
      || body.narrativeSourceKind === "creator-script"
      ? body.narrativeSourceKind
      : undefined;
    const projectVisualPin = brandVisualRenderAccess
      ? uploadMode
        ? await prepareUploadProjectVisualSnapshot({ userId: user.id, projectId: projectId! })
        : requestedContentPreflightId
          ? await prepareProjectVisualPin({
              userId: user.id,
              projectId: projectId!,
              preflightId: requestedContentPreflightId,
              // Script-mode callers may originate from either authored or AI-assisted
              // input. Both kinds hash the same normalized text independently; accept
              // only an analysis of this request's narrative, never merely the newest
              // analysis another tab happened to create.
              sourceHashes: (requestedNarrativeSourceKind
                ? [requestedNarrativeSourceKind]
                : (["ai-script", "creator-script"] as const))
                .map((kind) => contentPreflightSourceHash(kind, script, {
                  ...(targetClipCount ? { windowCount: targetClipCount } : {}),
                  sceneContentPolicy,
                })),
            })
          : await prepareProjectVisualSnapshotAwaitingPreflight({
              userId: user.id,
              projectId: projectId!,
              narrativeSourceKind: requestedNarrativeSourceKind ?? "creator-script",
            })
      : (onFirstClipPath && projectId && !uploadMode)
        ? await prepareProjectVisualSnapshotAwaitingPreflight({
            userId: user.id,
            projectId,
            narrativeSourceKind: requestedNarrativeSourceKind ?? "creator-script",
          })
        : null;
    const brandVisualAcceptanceJson = projectVisualPin && projectId && brandVisualRenderAccess
      ? await prepareBrandVisualJobAcceptance({
          userId: user.id,
          projectId,
          projectVisualPin,
          access: brandVisualRenderAccess,
        })
      : null;

    // Pexels VALIDITY preflight (Task 7, 2026-07-16 stability audit): 20/59 weekly
    // VideoJob failures were BYOK keys that exist but don't work (ElevenLabs missing
    // the text_to_speech scope — pushed onto preflightChecks above — and an invalid
    // Pexels key) — the presence guards above only check existence, so these jobs were
    // accepted and failed mid-pipeline with a raw JSON dump as the only user-facing
    // message. Fail-open (@/lib/key-preflight): a network hiccup or slow provider
    // never blocks a legitimate job, only a confirmed 401/403.
    // Gated on the RESOLVED stockSource (must run after it's parsed above):
    //  - kie-image never touches Pexels/Pixabay at all.
    //  - auto-mix only touches them when the "video" bucket is enabled (default on;
    //    off only if the caller explicitly excluded it via autoMixProviders).
    // Every configured provider is checked. A confirmed-bad provider is excluded from
    // this job when another provider remains; known-bad keys can therefore never become a
    // late stock-stage failure, while a valid backup still lets the job proceed.
    const stockVideoMayBeUsed = stockVideoProvidersMayBeUsed({ stockSource: requestedSource, autoMixProviders });
    let stockProviders: StockProvider[] | undefined;
    // Only the caller's OWN keys are preflighted. On the managed path there is
    // nothing of the user's to validate, and publishing the resulting EMPTY
    // `stockProviders` allowlist downstream would disable both providers in
    // fetch-stock. Flag off this condition is unreachable (the 400 above fires
    // first), so BYOK behaviour is unchanged.
    const stockPreflightPromise = stockVideoMayBeUsed && (user.pexelsKey || user.pixabayKey)
      ? preflightStockProviders({
          pexelsKey: user.pexelsKey ? decryptKey(user.pexelsKey) : null,
          pixabayKey: user.pixabayKey ? decryptKey(user.pixabayKey) : null,
        })
      : null;
    if (preflightChecks.length) {
      const blocks = (await Promise.all(preflightChecks)).filter((b): b is PreflightBlock => b !== null);
      if (blocks[0]) {
        return NextResponse.json({ error: "invalid_key", missingKey: blocks[0].key, message: blocks[0].message }, { status: 400 });
      }
    }
    if (stockPreflightPromise) {
      const stockPreflight = await stockPreflightPromise;
      if (stockPreflight.block) {
        return NextResponse.json({ error: "invalid_key", missingKey: stockPreflight.block.key, message: stockPreflight.block.message }, { status: 400 });
      }
      stockProviders = stockPreflight.providers;
    }

    const subtitleMode = typeof body.subtitleMode === "string" && SUB_MODES.has(body.subtitleMode) ? body.subtitleMode : undefined;
    const subtitlePosition = typeof body.subtitlePosition === "string" && SUB_POSITIONS.has(body.subtitlePosition) ? body.subtitlePosition : undefined;
    const bgmFile = str(body.bgmFile, 300);

    try {
      const job = await createVideoJob(
        user.id,
        {
          script: uploadMode ? "" : script,
          ...(uploadMode ? { mode: "upload", clipUrl } : {}),
          previewMode: true,
          ...(voiceProvider ? { voiceProvider } : {}),
          ...(voiceId ? { voiceId } : {}),
          ...(geminiVoiceName ? { geminiVoiceName } : {}),
          ...(omniVoiceId ? { omniVoiceId } : {}),
          ...(voiceBackend ? { voiceBackend } : {}),
          ...(avatar.kind === "ok" && avatarLayout
            ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs,
                avatarScale: avatarLayout.scale, avatarOffsetX: avatarLayout.offsetX, avatarOffsetY: avatarLayout.offsetY }
            : {}),
          ...(bgmFile ? { bgmFile, bgmVolume: num(body.bgmVolume, 0, 1) } : {}),
          ...(stockSource ? { stockSource } : {}),
          ...(targetClipCount ? { targetClipCount: Math.round(targetClipCount) } : {}),
          ...(brollRegionPreference ? { brollRegionPreference } : {}),
          ...(brollVisualStyle ? { brollVisualStyle } : {}),
          sceneContentPolicy,
          ...(requestedNarrativeSourceKind ? { narrativeSourceKind: requestedNarrativeSourceKind } : {}),
          ...(kieModel ? { kieModel } : {}),
          ...(useHeroRunpodImage ? { imageEngine: "runpod", imageModel: "z-image-turbo" } : {}),
          ...(autoMixProviders?.length ? { autoMixProviders } : {}),
          ...(autoMixWeights ? { autoMixWeights } : {}),
          ...(maxAiImages !== null ? { maxAiImages } : {}),
          ...(stockProviders?.length ? { stockProviders } : {}),
          ...(subtitleMode ? { subtitleMode } : {}),
          ...(subtitlePosition ? { subtitlePosition } : {}),
        },
        idempotencyKey,
        {
          projectId,
          idempotencyFingerprint,
          projectVisualPin,
          brandVisualAcceptanceJson,
          ...(process.env.MINUTE_QUOTA === "1" && process.env.CREDITS_LIVE === "1"
            ? {
                funding: {
                  meteredMinutes,
                  creditsLive: process.env.CREDITS_LIVE === "1",
                },
              }
            : {}),
        },
      );
      if (projectId) {
        await prisma.editorProject.updateMany({
          where: { id: projectId, userId: user.id },
          data: { activeJobId: job.id, status: "rendering", lastOpenedAt: new Date() },
        });
      }
      return NextResponse.json({
        jobId: job.id,
        status: "queued",
        idempotencyKey,
        idempotencyFingerprint,
        ...((legacyClient || heygenWarning)
          ? {
              warning: [legacyClient ? LEGACY_CLIENT_WARNING : null, heygenWarning]
                .filter((value): value is string => !!value)
                .join(" "),
            }
          : {}),
        ...(legacyClient ? { legacyClient: true, reloadRecommended: true } : {}),
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        return (await replayIdempotentVideoJob(user.id, idempotencyKey, idempotencyFingerprint, legacyClient))
          ?? NextResponse.json(
            { error: "idempotency_conflict", message: "idempotencyKey นี้ถูกใช้แล้ว" },
            { status: 409 },
          );
      }
      throw e;
    }
  } catch (err) {
    if (err instanceof BrandAssetError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    if (err instanceof BrandProfileLibraryError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    if (err instanceof ProjectLookError) {
      const status = err.code === "NOT_FOUND" ? 404
        : err.code === "PREFLIGHT_REQUIRED" ? 409
          : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    if (err instanceof RenderDeployDrainError) {
      return NextResponse.json(
        { error: "render_maintenance", retryable: true, message: RENDER_MAINTENANCE_CUSTOMER_MESSAGE },
        { status: 503 },
      );
    }
    if (err instanceof VideoJobFundingError) {
      return NextResponse.json(
        {
          error: QUOTA_EXCEEDED_CODE,
          message: err.message,
          userAction: quotaUpgradeUserAction(creditsLiveNow()),
          remainingMinutes: err.remainingMinutes,
          canBuyCredits: creditsLiveNow(),
        },
        { status: 403 },
      );
    }
    if ((err as { code?: string })?.code === "project_not_found") {
      return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    }
    if ((err as { code?: string })?.code === "stale_export_source") {
      return NextResponse.json(
        {
          error: "stale_export_source",
          message: "โปรเจกต์มีวิดีโอเวอร์ชันใหม่กว่า — กรุณากลับไปใช้เวอร์ชันล่าสุดแล้วส่งออกอีกครั้ง",
        },
        { status: 409 },
      );
    }
    console.error("[api/videos/jobs] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
