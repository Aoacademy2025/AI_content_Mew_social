import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { createVideoJob } from "@/lib/mcp/video-job";
import { checkClipQuota } from "@/lib/usage-limits";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { resolveAvatarRequest } from "@/lib/mcp/avatar-steps";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { resolveKieImageAccess } from "@/lib/kie-image-guards";
import { parseAutoMixWeights } from "@/lib/automix-weights";
import { normalizeBrollRegionPreference, normalizeBrollVisualStyle } from "@/lib/broll-preferences";
import { assertEditorProjectOwner } from "@/lib/editor-projects";
import { validateWindowEdits } from "@/lib/broll-rerender";
import { parseVideoJobOutput } from "@/lib/mcp/video-job";
import { BrandAssetError } from "@/lib/brand-assets.server";
import { createDurableExportWithStagedLogo } from "@/lib/logo-export.server";

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
  script?: unknown; voiceProvider?: unknown; voiceId?: unknown; geminiVoiceName?: unknown;
  avatarMode?: unknown; avatarId?: unknown; avatarIntroSecs?: unknown; avatarTailSecs?: unknown;
  bgmFile?: unknown; bgmVolume?: unknown; stockSource?: unknown;
  targetClipCount?: unknown; kieModel?: unknown; autoMixProviders?: unknown; autoMixWeights?: unknown;
  brollRegionPreference?: unknown; brollVisualStyle?: unknown;
  subtitleMode?: unknown; subtitlePosition?: unknown; idempotencyKey?: unknown; projectId?: unknown;
  // Phase 2 free per-window re-render (mode: "broll-rerender")
  sourceJobId?: unknown; windowEdits?: unknown;
  // Editor v2 durable export (mode: "export")
  subtitleOverlayConfig?: unknown; exportSceneCount?: unknown;
};

// b-roll sources the v2 UI may request. kie-image / auto-mix = Beta, ADMIN only —
// gate SERVER-SIDE (the UI disables the cards, but that's not security).
const STOCK_SOURCES = new Set(["stock", "kie-image", "auto-mix"]);

const SUB_MODES = new Set(["sentence", "1", "2", "3", "4"]);
const SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const AVATAR_MODES = new Set(["none", "full", "bookend", "bookend-both"]);

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() && v.length <= max ? v : undefined;
}
function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    // ── Phase 2: free per-window b-roll re-render (mode: "broll-rerender") ─────────
    // Reuses the source job's TTS + avatar and only swaps b-roll windows → NOTHING new is
    // fetched or charged, so this SKIPS the API-key guards and the clip-quota reserve. It KEEPS
    // auth (above), the in-flight cap of 3, and idempotency. The render route's server-trusted
    // `rerenderOf` skip (not any client flag) is what makes the render itself free; here we only
    // validate shape + ownership up-front and enqueue. The orchestrator re-checks authoritatively.
    if (body.mode === "broll-rerender") {
      if (process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT !== "1") {
        return NextResponse.json({ error: "not_enabled" }, { status: 404 });
      }
      const sourceJobId = str(body.sourceJobId, 120);
      if (!sourceJobId) return NextResponse.json({ error: "invalid_source", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 400 });
      const editsRes = validateWindowEdits(body.windowEdits);
      if ("error" in editsRes) return NextResponse.json({ error: "invalid_edits", message: editsRes.error }, { status: 400 });

      const srcJob = await prisma.videoJob.findUnique({ where: { id: sourceJobId }, select: { userId: true, status: true, outputJson: true, projectId: true } });
      if (!srcJob || srcJob.userId !== user.id) return NextResponse.json({ error: "source_not_found", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 404 });
      if (srcJob.status !== "done") return NextResponse.json({ error: "source_not_ready", message: "วิดีโอต้นฉบับยังไม่พร้อม (ยังเรนเดอร์ไม่เสร็จ)" }, { status: 400 });

      // Fail fast for upload-cutaway sources: the orchestrator's chromakey re-composite path
      // is only valid for HeyGen avatars (full/bookend/bookend-both); cutaway uses a DIFFERENT
      // composite (personRanges) that would corrupt the video. Previously this rejection only
      // fired in the orchestrator AFTER step("render") already produced a new base render —
      // wasted CPU, an orphan free ChargedClip row, and a consumed in-flight rate slot. Checking
      // here rejects before enqueue; the orchestrator guard stays as defense-in-depth (the jobs
      // API is directly reachable, so UI-hiding alone is not sufficient).
      const srcPreview = parseVideoJobOutput(srcJob.outputJson)?.preview;
      const heygenAvatarModes = new Set(["full", "bookend", "bookend-both"]);
      const isCutawaySource = !!srcPreview && (
        srcPreview.avatarModel === "upload-cutaway"
        || (!!srcPreview.avatarVideoUrl && !heygenAvatarModes.has(srcPreview.avatarMode ?? ""))
      );
      if (isCutawaySource) {
        return NextResponse.json(
          { error: "cutaway_not_supported", message: "โปรเจกต์แบบอัปโหลดคลิปเต็มจอยังไม่รองรับการแก้บีโรลราย window" },
          { status: 400 },
        );
      }

      const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: ["queued", "processing"] } } });
      if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

      try {
        // Inherit the SOURCE job's projectId (server-trusted — never body.projectId) so the
        // new job re-links the EditorProject on finish (finishJob sets activeJobId only when
        // job.projectId is set); otherwise reopening the project reverts to the pre-edit video.
        // srcJob.userId === user.id is already verified above, so this preserves the IDOR guard.
        const job = await createVideoJob(
          user.id,
          { mode: "broll-rerender", previewMode: true, sourceJobId, windowEdits: editsRes },
          str(body.idempotencyKey, 120),
          { projectId: srcJob.projectId },
        );
        return NextResponse.json({ jobId: job.id, status: "queued" });
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") {
          return NextResponse.json({ error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" }, { status: 409 });
        }
        throw e;
      }
    }

    // ── Durable export (mode: "export") ──────────────────────────────────────
    // The browser only submits the subtitle overlay config. The worker owns the long
    // burn + Gallery save + project status transition, so switching projects or closing
    // the tab cannot lose progress/finalization.
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
        select: { userId: true, status: true, outputJson: true, projectId: true },
      });
      if (!srcJob || srcJob.userId !== user.id) return NextResponse.json({ error: "source_not_found", message: "ไม่พบวิดีโอต้นฉบับ" }, { status: 404 });
      if (srcJob.status !== "done") return NextResponse.json({ error: "source_not_ready", message: "วิดีโอต้นฉบับยังไม่พร้อม" }, { status: 400 });
      if (!srcJob.projectId) return NextResponse.json({ error: "project_required", message: "โปรเจกต์นี้ยังไม่พร้อมสำหรับส่งออกแบบทำงานเบื้องหลัง" }, { status: 400 });
      const sourceProjectId = srcJob.projectId;
      const parsed = parseVideoJobOutput(srcJob.outputJson);
      if (!parsed?.preview) return NextResponse.json({ error: "source_not_exportable", message: "วิดีโอต้นฉบับไม่มีข้อมูลสำหรับแก้ซับ/ส่งออก" }, { status: 400 });

      const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: ["queued", "processing"] } } });
      if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

      try {
        const job = await createDurableExportWithStagedLogo({
          staging: {
            userId: user.id,
            plan: user.plan,
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
                exportScript: str(body.script, 20000),
                exportSceneCount: num(body.exportSceneCount, 1, 1000),
              },
              str(body.idempotencyKey, 120),
              { projectId: sourceProjectId, type: "export" },
            );
          },
          afterDurableJobCreated: async (durableJob) => {
            await prisma.editorProject.updateMany({
              where: { id: sourceProjectId, userId: user.id },
              data: { activeExportJobId: durableJob.id, status: "exporting", lastOpenedAt: new Date() },
            });
          },
        });
        return NextResponse.json({ jobId: job.id, status: "queued" });
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") {
          return NextResponse.json({ error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" }, { status: 409 });
        }
        throw e;
      }
    }

    const projectId = typeof body.projectId === "string" && body.projectId.trim()
      ? await assertEditorProjectOwner(user.id, body.projectId.trim())
      : null;

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

    const voiceProvider = body.voiceProvider === "elevenlabs" ? "elevenlabs" : body.voiceProvider === "gemini" ? "gemini" : undefined;
    const voiceId = str(body.voiceId, 120);
    const geminiVoiceName = str(body.geminiVoiceName, 60);

    // Key guards — same checks as MCP create_video_job, same wording surface (web shows toasts)
    // upload mode ไม่ใช้ TTS → ข้าม guard ฝั่งเสียง (Gemini ยังจำเป็น: transcribe/keywords)
    const useEleven = !uploadMode && (voiceProvider === "elevenlabs" || (!voiceProvider && user.ttsProvider === "elevenlabs"));
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
    if (!user.pexelsKey && !user.pixabayKey) {
      return NextResponse.json({ error: "missing_key", missingKey: "broll", message: "ต้องใส่ Pexels หรือ Pixabay key อย่างน้อย 1 ตัวสำหรับ B-roll" }, { status: 400 });
    }

    // Avatar (optional) — same resolver as MCP; layout falls back to the saved preset.
    // upload mode = ไม่มีอวตารตามดีไซน์
    const avatarModeRaw = !uploadMode && typeof body.avatarMode === "string" && AVATAR_MODES.has(body.avatarMode) ? body.avatarMode : undefined;
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

    // Quota + in-flight cap (shared worker, no global render queue)
    const q = await checkClipQuota(user.id);
    if (q && !q.allowed) return NextResponse.json({ error: "quota_exceeded", message: q.message }, { status: 403 });
    const inflight = await prisma.videoJob.count({ where: { userId: user.id, status: { in: ["queued", "processing"] } } });
    if (inflight >= 3) return NextResponse.json({ error: "too_many_jobs", message: "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่" }, { status: 429 });

    // B-roll source: "stock" (default) → orchestrator default "both". AI sources
    // (kie-image / auto-mix) are open to admins AND paid users un-gated for kie spend
    // — mirror of the fetch-stock authorization (resolveKieImageAccess), so the v2
    // background path matches the money path. FREE / flag-off stay blocked here (and
    // fetch-stock re-checks + force-zeros ai as the authoritative boundary).
    const requestedSource = typeof body.stockSource === "string" && STOCK_SOURCES.has(body.stockSource) ? body.stockSource : "stock";
    const isAdmin = user.role === "ADMIN";
    const { kiePaidUnlocked } = resolveKieImageAccess({
      managedKieOn: process.env.MANAGED_KIE === "1",
      creditsLive: process.env.CREDITS_LIVE === "1",
      isAdmin,
      isPaidPlan: user.plan === "PRO" || user.plan === "BUSINESS",
    });
    if (requestedSource !== "stock" && !isAdmin && !kiePaidUnlocked) {
      return NextResponse.json({ error: "beta_only", message: "ภาพ AI / AutoMix ยังเปิดเฉพาะทีมงาน (Beta)" }, { status: 403 });
    }
    const stockSource = requestedSource === "stock" ? undefined : requestedSource;

    // ขั้นสูง (P6c): จำนวนคลิป + ตัวเลือก AI-gen (Beta fields ผ่านได้เฉพาะเมื่อ source เป็น Beta
    // ซึ่งผ่าน admin gate ด้านบนแล้ว)
    const targetClipCount = num(body.targetClipCount, 1, 60);
    const brollRegionPreference = normalizeBrollRegionPreference(body.brollRegionPreference);
    const brollVisualStyle = normalizeBrollVisualStyle(body.brollVisualStyle);
    const kieModel = stockSource ? str(body.kieModel, 60) : undefined;
    const autoMixProviders = requestedSource === "auto-mix" && Array.isArray(body.autoMixProviders)
      ? (body.autoMixProviders.filter((x) => typeof x === "string" && x.length <= 40).slice(0, 12) as string[])
      : undefined;
    // Mix-preset weights (D5.1): only well-formed {video,photo,ai} ints 0–9 are stored;
    // fetch-stock re-validates + gates them behind MANAGED_KIE authoritatively.
    const autoMixWeights = requestedSource === "auto-mix"
      ? parseAutoMixWeights(body.autoMixWeights) ?? undefined
      : undefined;

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
          ...(avatar.kind === "ok" && avatarLayout
            ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs,
                avatarScale: avatarLayout.scale, avatarOffsetX: avatarLayout.offsetX, avatarOffsetY: avatarLayout.offsetY }
            : {}),
          ...(!uploadMode && bgmFile ? { bgmFile, bgmVolume: num(body.bgmVolume, 0, 1) } : {}),
          ...(stockSource ? { stockSource } : {}),
          ...(targetClipCount ? { targetClipCount: Math.round(targetClipCount) } : {}),
          ...(brollRegionPreference ? { brollRegionPreference } : {}),
          ...(brollVisualStyle ? { brollVisualStyle } : {}),
          ...(kieModel ? { kieModel } : {}),
          ...(autoMixProviders?.length ? { autoMixProviders } : {}),
          ...(autoMixWeights ? { autoMixWeights } : {}),
          ...(subtitleMode ? { subtitleMode } : {}),
          ...(subtitlePosition ? { subtitlePosition } : {}),
        },
        str(body.idempotencyKey, 120),
        { projectId },
      );
      if (projectId) {
        await prisma.editorProject.updateMany({
          where: { id: projectId, userId: user.id },
          data: { activeJobId: job.id, status: "rendering", lastOpenedAt: new Date() },
        });
      }
      return NextResponse.json({ jobId: job.id, status: "queued" });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        return NextResponse.json({ error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" }, { status: 409 });
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
    if ((err as { code?: string })?.code === "project_not_found") {
      return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    }
    console.error("[api/videos/jobs] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
