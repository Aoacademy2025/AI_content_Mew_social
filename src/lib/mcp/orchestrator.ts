import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { refundClipUsage } from "@/lib/usage-limits";
import { captionsFromTtsTiming } from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { setJobStep, finishJob, failJob, parseVideoJobOutput } from "@/lib/mcp/video-job";
import { validateWindowEdits, mergeWindowEdits, type WindowEdit } from "@/lib/broll-rerender";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { pipelineCaller, pollRender, type PipelineCaller } from "@/lib/mcp/pipeline-client";
import {
  DEFAULT_STOCK_SOURCE, RENDER_FPS, RENDER_JPEG_QUALITY, maxCardCharsFor,
  buildKeywordsPayload, buildStockPayload, buildConfigPayload, buildBurnConfig, type OrchCaption,
  cardsByWordCount, POSITION_TOP_PERCENT,
} from "@/lib/mcp/orchestrator-steps";
import { runAvatarComposite } from "@/lib/mcp/avatar-steps";
import { resolveBgm, moodMenu } from "@/lib/mcp/bgm-resolve";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { buildBrollWindows, type BrollWindow } from "@/lib/broll-windows";
import { planCutaway } from "@/lib/cutaway-plan";
import type { ScriptCard, TtsTiming } from "@/lib/tts-timing";

export interface OrchestratorDeps {
  caller?: PipelineCaller;
  refundOneClip?: (userId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

interface CreateInput {
  script: string; title?: string; voiceProvider?: "gemini" | "elevenlabs"; voiceId?: string;
  avatarMode?: "full" | "bookend" | "bookend-both"; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number;
  avatarScale?: number; avatarOffsetX?: number; avatarOffsetY?: number;
  bgmFile?: string; bgmVolume?: number;
  subtitleMode?: "sentence" | "1" | "2" | "3" | "4";
  subtitlePosition?: "top" | "middle" | "bottom";
  /** Per-job Gemini voice override (Editor v2) — falls back to user.geminiVoiceName. */
  geminiVoiceName?: string;
  /**
   * B-roll source override (Editor v2): "both" (stock, default) | "kie-image" | "auto-mix".
   * Validated + admin-gated at the web route; MCP never sends it → DEFAULT_STOCK_SOURCE.
   */
  stockSource?: string;
  /** จำนวนคลิปบีโรลกำหนดเอง (Editor v2 ขั้นสูง) — absent = auto */
  targetClipCount?: number;
  /** Visual preference hints for B-roll keyword/search/ranking (Editor v2 Advanced) */
  brollRegionPreference?: string;
  brollVisualStyle?: string;
  /** โมเดลภาพ AI (Beta, admin-gated at the web route) */
  kieModel?: string;
  /** แหล่งภาพ Auto Mix (Beta, admin-gated at the web route) */
  autoMixProviders?: string[];
  /** Editor v2 mix-preset weights (D5.1) — validated at the web route; fetch-stock
   *  honors them only under MANAGED_KIE and force-zeros ai for unauthorized users. */
  autoMixWeights?: { video: number; photo: number; ai: number };
  /**
   * Editor v2 "ใช้คลิปที่ถ่ายเอง" (cutaway, launch-coupled): clip แนวตั้งของผู้ใช้
   * → transcribe เสียงในคลิป → b-roll windows → base reel → composite mode:cutaway.
   * previewMode เสมอ (ยิงจากเว็บเท่านั้น; MCP ไม่ส่ง). Route gates on CLIP_CUTAWAY flag.
   */
  mode?: "script" | "upload" | "broll-rerender";
  clipUrl?: string;
  /**
   * Editor v2 free per-window b-roll re-render (Phase 2, previewMode-only): reuse the source
   * job's TTS/avatar, swap only the named b-roll windows, re-render the base WITHOUT charging
   * minutes again (render route's server-trusted `rerenderOf` skip). Never sent by MCP.
   */
  sourceJobId?: string;
  windowEdits?: WindowEdit[];
  /**
   * Editor v2 background render (ADR 0001): stop after the base render (+ avatar
   * composite if any) WITHOUT burning subtitles; persist captions/config in
   * outputJson v2 so the web editor resumes at the subtitle phase and burns there.
   * MCP clients never send this — the full path below is byte-identical without it.
   */
  previewMode?: boolean;
}

function brollWindowCaptions(windows: BrollWindow[]): OrchCaption[] {
  return windows.map((w, i) => ({
    text: w.text,
    startMs: w.startMs,
    endMs: w.endMs,
    tag: i === 0 ? "hook" : "body",
  }));
}

function alignBrollWindowsToKeywords(
  windows: BrollWindow[],
  units: OrchCaption[],
  keywords: string[],
  alternatives?: string[][],
): { windows: BrollWindow[]; units: OrchCaption[]; keywords: string[]; alternatives?: string[][] } {
  if (windows.length === 0 || keywords.length === windows.length) {
    return { windows, units, keywords, alternatives };
  }
  const count = Math.min(windows.length, keywords.length);
  return {
    windows: windows.slice(0, count),
    units: units.slice(0, count),
    keywords: keywords.slice(0, count),
    alternatives: alternatives?.slice(0, count),
  };
}

export async function runOrchestrator(jobId: string, userId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const caller = deps.caller ?? pipelineCaller(userId);
  const refund = deps.refundOneClip ?? refundClipUsage;
  const sleep = deps.sleep;

  // P3: server-side stage telemetry — emitted from the worker so stage done/fail is
  // recorded even when no browser is attached (the web editor emits client-side and
  // loses events on tab-close). Maps worker phase → canonical insights step name.
  // Fire-and-forget + fail-open: telemetry must NEVER break the pipeline.
  const pipelineRunId = `mcp_${jobId}`;
  const STEP_TELEMETRY_NAME: Record<string, string> = {
    tts: "tts", keywords: "keywords", stock: "fetchStock",
    config: "config", render: "render", avatar: "avatar", burn: "burnSubtitles",
  };
  const jobStartedAt = Date.now();
  let phaseName = "startup";
  let phaseStartedAt = jobStartedAt;
  const timings: Array<[string, number]> = [];
  function emitStage(phase: string, status: "started" | "done" | "error", durationMs?: number, extra?: Record<string, unknown>) {
    const step = STEP_TELEMETRY_NAME[phase];
    if (!step) return; // skip startup/captions and other non-pipeline phases
    void recordTelemetryEvent(userId, {
      name: status === "started" ? "pipeline_step_started" : status === "done" ? "pipeline_step_done" : "pipeline_step_error",
      category: status === "error" ? "error" : "pipeline",
      source: "server",
      step,
      status,
      durationMs: durationMs != null && durationMs >= 0 ? Math.round(durationMs) : null,
      properties: { pipelineRunId, jobId, via: "mcp", ...extra },
    }).catch(() => {});
  }
  // step() logs the phase that just ended (worker log, for audits) + emits its `done`
  // telemetry, then advances and emits the new phase's `started`. Render/burn progress
  // callbacks keep calling setJobStep directly so they don't spam this.
  const JOB_CANCELED = "__job_canceled__";
  async function step(name: string, progress: number) {
    // Cooperative cancel (incident 07-03: kie runaway had no stop lever): the cancel
    // route marks processing jobs `canceled`; we honor it at every step boundary —
    // the current step finishes, nothing further starts, no failJob overwrite.
    const current = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (current?.status === "canceled") throw new Error(JOB_CANCELED);
    const now = Date.now();
    const ended = now - phaseStartedAt;
    timings.push([phaseName, ended]);
    console.log(`[mcp-worker] job ${jobId} step=${phaseName} ${(ended / 1000).toFixed(1)}s`);
    emitStage(phaseName, "done", ended);
    phaseName = name;
    phaseStartedAt = now;
    emitStage(name, "started");
    await setJobStep(jobId, name, progress);
  }
  // Cancel mid-RENDER (QA 07-03 Flow 4.2): the render step is the only one whose cost is
  // already committed — /api/videos/render reserves minutes/credits at request time — and
  // it's the longest, so step-boundary checks alone let a canceled job render to completion
  // with the charge standing (never refunded; finishJob even flipped the job back to done).
  // Checked every poll tick: on cancel, kill the in-flight render via its cancel route —
  // the render route's own cancelled path refunds the reservation bucket-aware
  // (refundReservedClip) — then throw so the poll aborts and the job stops cleanly.
  const cancelInFlightRender = (renderJobId: string) => async () => {
    const cur = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (cur?.status !== "canceled") return;
    await caller.post(`/api/videos/render-cancel?jobId=${encodeURIComponent(renderJobId)}`, {}).catch(() => {});
    throw new Error(JOB_CANCELED);
  };

  try {
    const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.userId !== userId) { await failJob(jobId, "forbidden: job/user mismatch"); return; } // defense-in-depth (IDOR guard)
    const input = JSON.parse(job.inputJson) as CreateInput;
    const user = (await prisma.user.findUnique({ where: { id: userId } })) as User;
    const provider = input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");

    // Resolve BGM (path | track title | mood word like "ชิล"/"chill"/"ดราม่า") → a
    // real /music path. In chat the client usually sends a title or mood, not a path,
    // so without this the renderer gets <Audio src="Groove"> and crashes. Unresolvable
    // → fail fast with the mood menu; music-list fetch failure → drop bgm rather than
    // block the whole video over decorative music.
    if (input.bgmFile) {
      const rawBgm = input.bgmFile; // narrowed string — keep for the catch (input.bgmFile gets reassigned below)
      try {
        const lib = await caller.get<{ tracks?: { title: string; filename: string }[]; userTracks?: { title: string; filename: string }[] }>("/api/music");
        const bgmTracks = [
          ...(lib.tracks ?? []).map((t) => ({ title: t.title, bgmFile: `/music/${t.filename}` })),
          ...(lib.userTracks ?? []).map((t) => ({ title: t.title, bgmFile: `/api/music/${t.filename}` })),
        ];
        const res = resolveBgm(rawBgm, bgmTracks);
        if (res.kind === "resolved") input.bgmFile = res.bgmFile;
        else if (res.kind === "none") input.bgmFile = undefined;
        else { await failJob(jobId, `เพลงประกอบ "${rawBgm}" ไม่พบในระบบ — เลือกแนวเพลง: ${moodMenu()}`); return; }
      } catch {
        if (!rawBgm.startsWith("/")) input.bgmFile = undefined; // can't resolve a name without the list → drop, don't fail the video
      }
    }

    // ── EDITOR V2 FREE PER-WINDOW B-ROLL RE-RENDER (Phase 2, previewMode-only) ──
    // Reuse the SOURCE preview's captions/TTS/avatar; swap only the edited b-roll windows;
    // re-render the base for FREE (render route's server-trusted `rerenderOf` skip — never a
    // client flag). Subtitle timing is untouched: captions/voiceUrl/words/audioDurationMs are
    // copied through verbatim. MCP never sends this mode.
    if (input.mode === "broll-rerender") {
      if (!input.sourceJobId) { await failJob(jobId, "broll-rerender job missing sourceJobId"); return; }
      const src = await prisma.videoJob.findUnique({ where: { id: input.sourceJobId } });
      if (!src || src.userId !== userId) { await failJob(jobId, "ไม่พบวิดีโอต้นฉบับ หรือไม่มีสิทธิ์เข้าถึง"); return; } // IDOR guard
      const parsed = parseVideoJobOutput(src.outputJson);
      const preview = parsed?.preview;
      const srcBgVideos = (preview?.config as Record<string, unknown> | undefined)?.bgVideos;
      if (!preview || !Array.isArray(srcBgVideos)) { await failJob(jobId, "วิดีโอต้นฉบับไม่มีข้อมูล b-roll ที่แก้ไขได้"); return; }

      // Re-validate the edits server-side (defense-in-depth; the jobs route already validated).
      const editsRes = validateWindowEdits(input.windowEdits);
      if ("error" in editsRes) { await failJob(jobId, editsRes.error); return; }
      const mergeRes = mergeWindowEdits(srcBgVideos, editsRes);
      if ("error" in mergeRes) { await failJob(jobId, mergeRes.error); return; }

      // New base config: source preview config with merged b-roll, no keyword popups (base render).
      const rrBaseConfig = { ...(preview.config as Record<string, unknown>), bgVideos: mergeRes.bgVideos, keywordPopups: [] as unknown[] };

      await step("render", 40);
      const rr = await caller.post<{ jobId: string }>("/api/videos/render", {
        shortVideoConfig: rrBaseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
        rerenderOf: { sourceJobId: input.sourceJobId },
      });
      const rrNewBase = await pollRender(caller, rr.jobId, (pct) => { void setJobStep(jobId, "render", 40 + Math.round(pct * 0.3)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(rr.jobId) });

      // Avatar re-composite (HeyGen only) — EXACTLY like AvatarAdjustOverlay.apply(): a free
      // chromakey re-composite of the SAME stored avatar assets onto the NEW base (no HeyGen call).
      let rrFinalUrl = rrNewBase;
      let rrCompositeBaseUrl: string | null = preview.compositeBaseUrl ?? null;
      const rrHasAvatar = !!(preview.avatarModel && preview.avatarModel !== "none" && preview.avatarVideoUrl);
      if (rrHasAvatar) {
        const heygenModes = new Set(["full", "bookend", "bookend-both"]);
        const rrAvatarTiming = preview.avatarMode;
        // chromakey re-composite is only valid for HeyGen avatars (full/bookend/bookend-both) —
        // the exact set AvatarAdjustOverlay operates on (its gate also requires compositeBaseUrl +
        // avatarMode). An upload-cutaway preview (avatarModel="upload-cutaway", no avatarMode) is a
        // DIFFERENT composite (cutaway w/ personRanges); chromakey-ing it would corrupt the video,
        // so fail cleanly rather than emit garbage. (Per-window edit for uploaded clips = future.)
        if (!rrAvatarTiming || !heygenModes.has(rrAvatarTiming)) {
          await failJob(jobId, "การแก้ b-roll รายช่วงยังไม่รองรับวิดีโอที่อัปโหลดคลิปเอง");
          return;
        }
        if (rrAvatarTiming === "bookend-both" && !preview.tailAvatarUrl) {
          await failJob(jobId, "ข้อมูลอวตารท้ายคลิปไม่ครบ — ปรับ b-roll ไม่ได้"); return;
        }
        await step("avatar", 80);
        const rrLayout = resolveAvatarLayout({}, await getAvatarPreset(userId, preview.avatarModel!));
        const rrComp = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
          avatarVideoUrl: preview.avatarVideoUrl,
          ...(preview.tailAvatarUrl ? { tailAvatarVideoUrl: preview.tailAvatarUrl } : {}),
          bgVideoUrl: rrNewBase,
          mode: "chromakey",
          avatarTiming: rrAvatarTiming,
          avatarBookendSecs: preview.avatarIntroSecs ?? 5,
          avatarTailSecs: preview.avatarTailSecs ?? 5,
          avatarLayout: rrLayout,
        });
        rrFinalUrl = rrComp.videoUrl;
        rrCompositeBaseUrl = rrNewBase; // new pre-composite base
      }

      // flush final phase + one-line log
      const rrDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, rrDuration]);
      emitStage(phaseName, "done", rrDuration);
      console.log(`[mcp-worker] job ${jobId} BROLL-RERENDER total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s edits=${editsRes.length} avatar=${rrHasAvatar}`);

      // Preview payload = SOURCE preview copied verbatim (captions/voiceUrl/words/audioDurationMs
      // /avatar* unchanged — subtitle invariant) with config + videoUrl + compositeBaseUrl updated.
      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: rrFinalUrl,
        preview: {
          ...preview,
          config: rrBaseConfig,
          compositeBaseUrl: rrCompositeBaseUrl,
        },
      });
      return;
    }

    // ── EDITOR V2 UPLOAD → CUTAWAY (P6.5, previewMode-only) ───────────────────
    // ข้ามเสียง/อวตาร/เพลงตามดีไซน์: ถอดซับจากเสียงในคลิป → b-roll windows →
    // base reel → composite mode:"cutaway" (เสียงมาจากคลิปเสมอ) → จบที่ preview.
    if (input.mode === "upload") {
      if (!input.clipUrl) { await failJob(jobId, "upload job missing clipUrl"); return; }

      await step("captions", 20);
      const tx = await caller.post<{ captions?: OrchCaption[]; audioDurationMs?: number }>(
        "/api/videos/transcribe", { audioUrl: input.clipUrl, script: "" },
      );
      const upCaps = (tx.captions ?? []).filter((c) => typeof c?.text === "string" && c.text.trim());
      if (!upCaps.length) throw new Error("ถอดซับจากคลิปไม่สำเร็จ — เช็คว่าคลิปมีเสียงพูดชัดเจน");
      const upDurMs = (tx.audioDurationMs && tx.audioDurationMs > 0)
        ? Math.round(tx.audioDurationMs)
        : Math.max(...upCaps.map((c) => c.endMs));

      const upWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
      const upWindows = buildBrollWindows(upCaps.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), upWindowSec);
      const upBrollUnits = upWindows.length > 0 ? brollWindowCaptions(upWindows) : upCaps;

      await step("keywords", 40);
      const upKw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][]; relevanceSpec?: unknown }>(
        "/api/videos/extract-keywords",
        {
          ...buildKeywordsPayload(upBrollUnits.map((c) => c.text), upCaps.map((c) => c.text).join("\n"), upDurMs, {
            brollRegionPreference: input.brollRegionPreference,
            brollVisualStyle: input.brollVisualStyle,
          }),
          ...(input.targetClipCount && input.targetClipCount > 0 ? { targetClipCount: input.targetClipCount } : {}),
        },
      );

      await step("stock", 55);
      const upAiGen = input.stockSource === "kie-image" || input.stockSource === "auto-mix";
      const upAligned = alignBrollWindowsToKeywords(upWindows, upBrollUnits, upKw.keywords ?? [], upKw.keywordAlternatives);
      const upTotalDur = upAligned.windows.length > 0
        ? Math.round(upDurMs / 1000)
        : (upKw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(upDurMs / 1000);
      const upStock = await caller.post<{ results: unknown[] }>(
        "/api/videos/fetch-stock",
        {
          ...buildStockPayload(upAligned.keywords, upTotalDur, input.stockSource ?? DEFAULT_STOCK_SOURCE, upAligned.units, upKw.visualDirection, upAligned.alternatives, upKw.relevanceSpec, {
            brollRegionPreference: input.brollRegionPreference,
            brollVisualStyle: input.brollVisualStyle,
          }),
          ...(input.kieModel ? { kieModel: input.kieModel } : {}),
          ...(input.autoMixProviders?.length ? { autoMixProviders: input.autoMixProviders } : {}),
          ...(input.autoMixWeights ? { autoMixWeights: input.autoMixWeights } : {}),
        },
        upAiGen ? { retries: 0 } : undefined,
      );

      await step("config", 65);
      const upScc = upAligned.windows.length > 0 ? [] : (upCaps.length === (upKw.keywords ?? []).length ? upCaps.map(() => 1) : (upKw.sceneClipCounts ?? []));
      const upCfg = await caller.post<{ config: Record<string, unknown> }>(
        "/api/videos/generate-config",
        buildConfigPayload(
          upCaps, upStock.results ?? [], input.clipUrl, upDurMs, upCaps.map((c) => c.text),
          upKw.keywordsPerScene ?? 5, upScc, upKw.sceneDurations ?? [],
          upAligned.windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
        ),
      );

      await step("render", 75);
      const upBaseConfig = { ...upCfg.config, keywordPopups: [] as unknown[] };
      const upR = await caller.post<{ jobId: string }>("/api/videos/render", {
        shortVideoConfig: upBaseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
      });
      const upReelUrl = await pollRender(caller, upR.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.12)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(upR.jobId) });
      // preview: การจองที่ base render คือค่าใช้จ่ายเดียว (เหมือน script preview) — ไม่ refund

      await step("composite", 90);
      const plan = planCutaway(upWindows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })));
      const personRanges = plan.person.map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));
      // hook = คลิปที่อัปต้องเป็นเฟรมแรกเสมอ. transcribe เว้นช่วง [0, คำแรก) ไว้ (เงียบ/หายใจ/อินโทร)
      // ทำให้ base reel (b-roll) โผล่ก่อนหน้าคนพูด — คลุม person range แรกให้เริ่มที่ 0 (บั๊ก kapokja 07-04).
      // person เป็น overlay บน b-roll base (composite mode:cutaway) → ทุกจังหวะที่ไม่มี person range = b-roll โผล่.
      if (personRanges.length > 0) personRanges[0] = { ...personRanges[0], start: 0 };
      const comp = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
        mode: "cutaway",
        avatarVideoUrl: input.clipUrl,
        bgVideoUrl: upReelUrl,
        personRanges,
      });

      const upFinalDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, upFinalDuration]);
      emitStage(phaseName, "done", upFinalDuration);
      console.log(`[mcp-worker] job ${jobId} UPLOAD-CUTAWAY total=${((Date.now() - jobStartedAt) / 1000).toFixed(0)}s scenes=${upCaps.length} windows=${upWindows.length}`);

      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: comp.videoUrl,
        preview: {
          captions: upCaps,
          config: upBaseConfig,
          voiceUrl: input.clipUrl,
          audioDurationMs: upDurMs,
          avatarModel: "upload-cutaway",
          avatarVideoUrl: input.clipUrl,
        },
      });
      return;
    }

    // 1. TTS
    await step("tts", 10);
    const tts = provider === "elevenlabs"
      ? await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts", { text: input.script, voiceId: input.voiceId ?? user.elevenlabsVoiceId ?? undefined, languageCode: "th" })
      : await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts-gemini", { text: input.script, voiceName: input.geminiVoiceName ?? user.geminiVoiceName ?? "Aoede" });
    const audioDurationMs = tts.audioDurationMs ?? 0;

    // 2. Captions (in-process, reuse the pure editor helper)
    await step("captions", 25);
    // Sentence-mode PARITY with the web editor: the editor first calls /api/videos/split-script
    // (an LLM that cuts on natural breath points — keeps a number and its unit together, never
    // splits mid-phrase) and feeds those cards into captionsFromTtsTiming. Without it the MCP
    // path fell back to the greedy char-cap splitter, so cards broke mid-phrase and the renderer's
    // word-break wrapped them awkwardly ("ตัดคำ/เว้นบรรทัดเพี้ยน"). Text-only over the exact TTS
    // text (timing stays 100% TTS-derived), server-validated verbatim; ANY failure → viralCards
    // null → byte-identical to the old deterministic cards (fail-open). Only sentence mode uses
    // these cards — word modes re-split capRes.words below, so skip the extra call there.
    const wantsSentenceCards = !input.subtitleMode || input.subtitleMode === "sentence";
    const timingForCards = tts.timing as TtsTiming | null;
    const fullTextForCards = (timingForCards?.segments ?? []).map((s) => s.text).join("");
    let viralCards: ScriptCard[] | null = null;
    if (wantsSentenceCards && fullTextForCards.length >= 120) {
      try {
        const sc = await caller.post<{ cards?: ScriptCard[] }>("/api/videos/split-script", {
          text: fullTextForCards,
          maxCardChars: maxCardCharsFor(),
        });
        viralCards = Array.isArray(sc.cards) ? sc.cards : null;
      } catch { /* fail-open → deterministic sentence cards */ }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor(), viralCards);
    if (!capRes || capRes.captions.length === 0) throw new Error("ไม่มี subtitle timing จาก TTS — ลองใหม่อีกครั้ง");
    const baseCaptions = capRes.captions as OrchCaption[];
    const captions = (input.subtitleMode && input.subtitleMode !== "sentence")
      ? cardsByWordCount(capRes.words, parseInt(input.subtitleMode), capRes.fullText)
      : baseCaptions;
    const durMs = capRes.audioDurationMs || audioDurationMs;

    // B-roll cadence PARITY with the web editor: group captions into ~4s windows so the
    // background holds one clip per window instead of cutting on every caption (the strobing
    // "พื้นหลังไม่เนียน / แล้วตัด"). Gated on the SAME flag as web so both surfaces stay in
    // lockstep. In window mode generate-config places one clip per window (ignoring
    // sceneClipCounts); subtitle timing is untouched.
    const brollWindowMode = process.env.NEXT_PUBLIC_BROLL_WINDOW_MODE === "1";
    const brollWindowSec = Number(process.env.NEXT_PUBLIC_BROLL_WINDOW_SEC) || 4;
    const brollWindows = brollWindowMode
      ? buildBrollWindows(captions.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })), brollWindowSec)
      : [];
    const brollUnits = brollWindows.length > 0 ? brollWindowCaptions(brollWindows) : captions;

    // 3. Keywords
    await step("keywords", 40);
    const kw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][]; relevanceSpec?: unknown }>(
      "/api/videos/extract-keywords",
      {
        ...buildKeywordsPayload(brollUnits.map((c) => c.text), input.script, durMs, {
          brollRegionPreference: input.brollRegionPreference,
          brollVisualStyle: input.brollVisualStyle,
        }),
        // v2 ขั้นสูง: จำนวนคลิปกำหนดเอง (extract-keywords รองรับ field นี้จาก web เดิมอยู่แล้ว)
        ...(input.targetClipCount && input.targetClipCount > 0 ? { targetClipCount: input.targetClipCount } : {}),
      },
    );

    // 4. Stock
    await step("stock", 55);
    const aligned = alignBrollWindowsToKeywords(brollWindows, brollUnits, kw.keywords ?? [], kw.keywordAlternatives);
    const totalDur = aligned.windows.length > 0
      ? Math.round(durMs / 1000)
      : (kw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(durMs / 1000);
    // AI-gen sources (kie-image / auto-mix) SPEND kie credits per image — a transport
    // retry re-generates the entire batch (incident 07-03: 20+ images × 2). retries: 0.
    const aiGenSource = input.stockSource === "kie-image" || input.stockSource === "auto-mix";
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock",
      {
        ...buildStockPayload(aligned.keywords, totalDur, input.stockSource ?? DEFAULT_STOCK_SOURCE, aligned.units, kw.visualDirection, aligned.alternatives, kw.relevanceSpec, {
          brollRegionPreference: input.brollRegionPreference,
          brollVisualStyle: input.brollVisualStyle,
        }),
        // v2 ขั้นสูง (Beta): โมเดลภาพ AI + แหล่ง Auto Mix — fetch-stock มี server default ให้ทั้งคู่
        ...(input.kieModel ? { kieModel: input.kieModel } : {}),
        ...(input.autoMixProviders?.length ? { autoMixProviders: input.autoMixProviders } : {}),
        ...(input.autoMixWeights ? { autoMixWeights: input.autoMixWeights } : {}),
      },
      aiGenSource ? { retries: 0 } : undefined,
    );

    // 5. Config
    await step("config", 65);
    // Window mode → empty sceneClipCounts so generate-config takes the window branch (one clip
    // per window) instead of per-caption cycling; brollWindows below carries the spans (mirrors
    // web page.tsx runConfig). Otherwise keep the legacy 1-clip-per-caption path.
    const sceneClipCounts = aligned.windows.length > 0
      ? []
      : (captions.length === (kw.keywords ?? []).length ? captions.map(() => 1) : (kw.sceneClipCounts ?? []));
    const cfgRes = await caller.post<{ config: Record<string, unknown> }>(
      "/api/videos/generate-config",
      buildConfigPayload(
        captions, stock.results ?? [], tts.voiceUrl, durMs, captions.map((c) => c.text),
        kw.keywordsPerScene ?? 5, sceneClipCounts, kw.sceneDurations ?? [],
        aligned.windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
      ),
    );

    // 6. Base render (no burned subs) → poll
    await step("render", 75);
    const baseConfig = { ...cfgRes.config, keywordPopups: [] as unknown[], ...(input.bgmFile ? { bgmFile: input.bgmFile, bgmVolume: input.bgmVolume ?? 0.12 } : {}) };
    const r1 = await caller.post<{ jobId: string }>("/api/videos/render", {
      shortVideoConfig: baseConfig, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
    });
    const baseUrl = await pollRender(caller, r1.jobId, (pct) => { void setJobStep(jobId, "render", 75 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(r1.jobId) });
    // Base render reserved 1 clip; the burn render will reserve another. Refund the base's
    // reservation NOW so a finished video nets exactly 1 clip, and a burn-stage failure (the
    // burn route refunds its own clip) nets 0 — never over-charges for an undelivered video.
    // PREVIEW MODE: no burn follows in this job, so the base reservation must STAND as the
    // single charge (same as the web editor's preview render today) — skip the refund.
    if (!input.previewMode) await refund(userId).catch(() => {});

    // 6b. Avatar (optional) — generate + composite onto the base render.
    let finalBase = baseUrl;
    let avatarModel = "none";
    let avatarVideoUrl: string | null = null;
    let tailAvatarUrl: string | null = null;
    if (input.avatarMode) {
      // Defense-in-depth: the route only ever persists avatarMode together with a
      // resolved avatarId, but the worker reads inputJson directly — fail cleanly on a
      // malformed job rather than generating with avatarModel=undefined.
      if (!input.avatarId) throw new Error("avatar job missing avatarId");
      await step("avatar", 80);
      const av = await runAvatarComposite(caller, {
        baseUrl, ttsAudioUrl: tts.voiceUrl, avatarMode: input.avatarMode, avatarId: input.avatarId,
        introSecs: input.avatarIntroSecs ?? 5, tailSecs: input.avatarTailSecs ?? 5, sleep,
        layout: { scale: input.avatarScale ?? 1, offsetX: input.avatarOffsetX ?? 0, offsetY: input.avatarOffsetY ?? 0 },
        onStep: (label) => { void setJobStep(jobId, label, 84).catch(() => {}); },
      });
      finalBase = av.compositeUrl;
      avatarModel = input.avatarId;
      avatarVideoUrl = av.avatarUrl;
      tailAvatarUrl = av.tailAvatarUrl ?? null;
    }

    // PREVIEW MODE (Editor v2): stop here — no burn, no gallery Video row (the web burn
    // step creates it, exactly like today's web flow; also avoids PROCESSING ghost rows).
    // outputJson v2 carries everything the editor's subtitle phase needs.
    if (input.previewMode) {
      const previewDuration = Date.now() - phaseStartedAt;
      timings.push([phaseName, previewDuration]);
      emitStage(phaseName, "done", previewDuration);
      const totalPreviewS = (Date.now() - jobStartedAt) / 1000;
      console.log(`[mcp-worker] job ${jobId} PREVIEW TIMINGS total=${totalPreviewS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);
      await finishJob(jobId, {
        version: 2,
        mode: "preview",
        videoUrl: finalBase,
        preview: {
          captions,
          config: baseConfig,
          voiceUrl: tts.voiceUrl,
          audioDurationMs: durMs,
          avatarModel,
          avatarVideoUrl,
          // ข้อมูล re-composite (จอแต่งซับปรับตำแหน่งอวตารได้โดยไม่เรียก HeyGen ใหม่)
          avatarMode: input.avatarMode ?? null,
          avatarIntroSecs: input.avatarIntroSecs ?? 5,
          avatarTailSecs: input.avatarTailSecs ?? 5,
          compositeBaseUrl: input.avatarMode ? baseUrl : null,
          tailAvatarUrl,
          // word timeline สำหรับ "ความยาวการ์ด 1/2/3/4 คำ" ในจอแต่งซับ (regroup ฝั่ง
          // editor ด้วย timing เป๊ะ ไม่ต้อง interpolate) — MCP path (non-preview) ไม่แตะ
          words: capRes.words,
          fullText: capRes.fullText,
        },
      });
      return;
    }

    // 7. Create Video row (PROCESSING)
    const created = await caller.post<{ id: string }>("/api/videos", {
      videoUrl: finalBase, audioUrl: tts.voiceUrl, thumbnail: null, script: input.script.trim() || null,
      avatarModel, avatarVideoUrl, voiceModel: provider === "elevenlabs" ? (input.voiceId ?? "elevenlabs") : (user.geminiVoiceName ?? "gemini"),
      sceneCount: captions.length, renderConfig: baseConfig, status: "PROCESSING",
    });

    // 8. Burn subtitles onto the (possibly avatar-composited) base.
    await step("burn", 88);
    const subTop = input.subtitlePosition ? POSITION_TOP_PERCENT[input.subtitlePosition] : undefined;
    const r2 = await caller.post<{ jobId: string }>("/api/videos/render", { subtitleOverlayConfig: buildBurnConfig(finalBase, captions, durMs, RENDER_FPS, subTop) });
    const burnedUrl = await pollRender(caller, r2.jobId, (pct) => { void setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep, checkCanceled: cancelInFlightRender(r2.jobId) });

    // 9. Update Video row → COMPLETED (the gallery route is PATCH — see /api/videos/[id])
    await caller.patch(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

    // flush final phase + emit one-line breakdown for audits
    const finalDuration = Date.now() - phaseStartedAt;
    timings.push([phaseName, finalDuration]);
    emitStage(phaseName, "done", finalDuration); // final phase (burn) done
    const totalS = (Date.now() - jobStartedAt) / 1000;
    console.log(`[mcp-worker] job ${jobId} TIMINGS total=${totalS.toFixed(0)}s ${timings.map(([n, ms]) => `${n}=${(ms / 1000).toFixed(0)}s`).join(" ")} scenes=${captions.length} subMode=${input.subtitleMode ?? "sentence"}`);

    await finishJob(jobId, { videoUrl: burnedUrl, videoId: created.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    if (message === "__job_canceled__") {
      console.log(`[mcp-worker] job ${jobId} canceled by user at step=${phaseName} — stopping cleanly`);
      return; // status is already 'canceled'; don't overwrite with failed
    }
    emitStage(phaseName, "error", Date.now() - phaseStartedAt, { message });
    await failJob(jobId, message);
  }
}
