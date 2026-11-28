/**
 * End-to-end verification suite for the AI Story Director Engine (Web + MCP + Remotion + FFmpeg):
 *   1. Event & Story SFX Synthesizer (all 7 kinds: whoosh, pop, shutter, ding, drumroll, boom, record-scratch)
 *   2. Transparent Story Overlays normalization & SFX cue planning (all 6 kinds)
 *   3. Face-Safe Overlay & Caption Placement + RGBA portrait face-cluster detector
 *   4. Beat-Synced Multi-Cut & Speed Ramp planner (BPM detection + Cold Open + Hero Freeze + Slow-Mo + Blooper)
 *   5. Native Clip Audio preservation & Live-Photo 20fps -> 30fps smooth normalization
 *   6. Dual Social Export (`_withMusic` + `_tiktok-nobgm` `-c:v copy` at -14 LUFS, zero BGM)
 *   7. Story Director Style Packs + MCP `analyze_footage_pack` / `create_video_job` / `export_video` G13/G14 compliance
 */

import assert from "node:assert/strict";
import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-director-verify-"));
  const dbPath = path.join(tmp, "story-director.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  const { getFfmpegPath } = await import("../src/lib/ffmpeg-path");
  const { getFfprobePath, ffprobeVideoStreamMeta } = await import("../src/lib/upload-media-probe");
  const { normalizeForRemotion } = await import("../src/lib/broll-asset-lib");
  const {
    TRANSITION_SFX_KINDS,
    synthesizeTransitionSfxWavBytes,
    getTransitionSfxDataUrl,
  } = await import("../src/lib/transition-sfx");
  const {
    STORY_OVERLAY_KINDS,
    normalizeStoryOverlays,
    planStoryOverlaySfxCues,
  } = await import("../src/lib/story-overlays");
  const {
    coordinateStoryOverlays,
    coordinateSubtitlePopups,
    estimatePortraitFaceBoxesFromRgba,
    resolveFaceSafeStickerPosition,
    resolveFaceSafeVerticalPercent,
  } = await import("../src/lib/face-safe-placement");
  const {
    detectBpmAndBeatsFromEnvelope,
    planBeatSyncedStoryCuts,
  } = await import("../src/lib/beat-sync-plan");
  const {
    buildStoryDirectorPlan,
    buildStoryDirectorPlanFromVisionSelection,
  } = await import("../src/lib/story-director-planner");
  const {
    buildTimestampedContactSheetJpeg,
    materializeSmoothSlowMoSegments,
  } = await import("../src/lib/story-director-analyzer.server");
  const {
    CREDIT_COST,
    STORY_DIRECTOR_FLASH_CREDITS,
    STORY_DIRECTOR_NEON_CREDITS,
  } = await import("../src/lib/credit-costs");
  const { GEMINI_MODEL, GEMINI_DIRECTOR_NEON_MODEL, GEMINI_FAST_LITE_MODEL } = await import("../src/lib/gemini");
  const { createDualTikTokSoundMp4 } = await import("../src/lib/render/dual-social-export");
  const { activeStylePacks, stylePack } = await import("../src/lib/style-pack-catalog");
  const { resolveStep1TemplateDefaults } = await import("../src/lib/video-template-apply");
  const {
    MCP_MEDIA_IMPORT_TOOL_NAMES,
    analyzeFootagePackTool,
    inspectFootagePackTool,
    registerMediaImportTools,
  } = await import("../src/lib/mcp/media-import-tools");
  const { prepareVideoQuote } = await import("../src/lib/mcp/video-quote.server");
  const { registerEditTools } = await import("../src/lib/mcp/edit-tools");
  const { createVideoJobInputShape, prepareVideoJobInputShape } = await import("../src/lib/mcp/create-video-input");

  let passed = 0;
  const check = (label: string, cond: boolean, detail = "") => {
    assert.ok(cond, detail ? `${label} — ${detail}` : label);
    console.log(`  PASS  ${label}`);
    passed += 1;
  };

  try {
    // ── 1. All 7 Transition & Story Event SFX Kinds ──────────────────────────
    check("TRANSITION_SFX_KINDS has 7 kinds", TRANSITION_SFX_KINDS.length === 7);
    for (const kind of TRANSITION_SFX_KINDS) {
      const wav = synthesizeTransitionSfxWavBytes(kind);
      const header = Buffer.from(wav.buffer, wav.byteOffset, 12).toString("ascii");
      check(`SFX "${kind}" produces valid RIFF WAVE PCM`, header.startsWith("RIFF") && header.endsWith("WAVE") && wav.byteLength > 4000);
      // Ensure non-silent audio samples
      const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
      let peak = 0;
      for (let off = 44; off + 2 <= wav.byteLength; off += 2) {
        const abs = Math.abs(view.getInt16(off, true));
        if (abs > peak) peak = abs;
      }
      check(`SFX "${kind}" has audible non-clipped peak (${peak})`, peak > 4000 && peak <= 32767);
      check(`SFX "${kind}" data URL is cached base64`, getTransitionSfxDataUrl(kind).startsWith("data:audio/wav;base64,"));
    }

    // ── 2. Transparent Story Overlays & Planned Event SFX ────────────────────
    check("STORY_OVERLAY_KINDS has 6 overlay types", STORY_OVERLAY_KINDS.length === 6);
    const overlays = normalizeStoryOverlays(
      [
        { kind: "hero-freeze-card", startMs: 2100, endMs: 3900, title: "SONIC · #4", subtitle: "DRUM MAJOR · ทีมสีชมพู", badge: "HERO" },
        { kind: "chapter-pill", startMs: 4000, endMs: 11000, title: "ภารกิจ 1/2", subtitle: "เดินขบวนพาเหรด" },
        { kind: "checklist-pop", startMs: 5200, endMs: 8000, title: "เช็กลิสต์", items: ["ควงคทาเป๊ะ", "คว้า 3 เหรียญ"] },
        { kind: "countdown", startMs: 11200, endMs: 13000, title: "3 · 2 · 1", subtitle: "ปล่อยตัววิ่ง!" },
        { kind: "callout-sticker", startMs: 14500, endMs: 16800, title: "สุดแรง!", badge: "⚡" },
        { kind: "blooper-end", startMs: 18500, endMs: 21500, title: "เบื้องหลังซ้อมเต้นที่บ้าน", badge: "BLOOPER" },
      ],
      22_000,
    );
    check("normalizeStoryOverlays normalizes all 6 overlay kinds", overlays.length === 6);
    const plannedOverlaySfx = planStoryOverlaySfxCues(overlays, 22);
    const plannedKinds = new Set(plannedOverlaySfx.map((c) => c.kind));
    check(
      "planStoryOverlaySfxCues emits shutter, boom, ding, drumroll, pop, and record-scratch",
      plannedKinds.has("shutter")
        && plannedKinds.has("boom")
        && plannedKinds.has("ding")
        && plannedKinds.has("drumroll")
        && plannedKinds.has("pop")
        && plannedKinds.has("record-scratch"),
      JSON.stringify([...plannedKinds]),
    );

    // ── 3. Face-Safe Placement & RGBA Portrait Face Detector ─────────────────
    const lowerFaceTop = resolveFaceSafeVerticalPercent({
      faceBoxes: [{ x: 0.25, y: 0.68, width: 0.45, height: 0.22, confidence: 0.9 }],
      preferredTopPercent: 74,
      role: "subtitle",
    });
    check("resolveFaceSafeVerticalPercent shifts subtitle away from lower-frame face", lowerFaceTop < 65, `got ${lowerFaceTop}`);

    const upperFaceSticker = resolveFaceSafeStickerPosition({
      faceBoxes: [{ x: 0.08, y: 0.14, width: 0.44, height: 0.24, confidence: 0.9 }],
      seedIndex: 0,
    });
    check(
      "resolveFaceSafeStickerPosition avoids face at top-left",
      !(upperFaceSticker.leftPercent < 30 && upperFaceSticker.topPercent < 24),
      JSON.stringify(upperFaceSticker),
    );

    // Synthetic portrait frame with warm skin cluster in upper center (x: 0.35..0.65, y: 0.18..0.36)
    const w = 96;
    const h = 170;
    const rgba = Buffer.alloc(w * h * 4);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = (py * w + px) * 4;
        const inFace = px >= 34 && px <= 62 && py >= 30 && py <= 62;
        rgba[idx] = inFace ? 218 : 24;
        rgba[idx + 1] = inFace ? 164 : 48;
        rgba[idx + 2] = inFace ? 136 : 82;
        rgba[idx + 3] = 255;
      }
    }
    const detectedFaces = estimatePortraitFaceBoxesFromRgba(rgba, w, h);
    check(
      "estimatePortraitFaceBoxesFromRgba locates upper-center portrait face",
      detectedFaces.length === 1 && detectedFaces[0]!.y < 0.4 && detectedFaces[0]!.x > 0.15,
      JSON.stringify(detectedFaces),
    );

    // Regression (Sky orange/red Drum Major uniform): saturated red-orange jersey at lower torso
    // MUST NOT trigger a false-positive face box!
    const jerseyRgba = Buffer.alloc(w * h * 4);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = (py * w + px) * 4;
        const inJersey = px >= 28 && px <= 70 && py >= 75 && py <= 155;
        jerseyRgba[idx] = inJersey ? 215 : 42;
        jerseyRgba[idx + 1] = inJersey ? 45 : 78;
        jerseyRgba[idx + 2] = inJersey ? 20 : 38;
        jerseyRgba[idx + 3] = 255;
      }
    }
    const jerseyFaces = estimatePortraitFaceBoxesFromRgba(jerseyRgba, w, h);
    check(
      "estimatePortraitFaceBoxesFromRgba rejects saturated red-orange uniform (0 false positives)",
      jerseyFaces.length === 0,
      JSON.stringify(jerseyFaces),
    );

    // Regression: subtitles must NEVER enter the 24%..73% center portrait face danger zone!
    for (const faceY of [0.18, 0.34, 0.48, 0.62, 0.70]) {
      for (const disallowTopZone of [false, true]) {
        const subY = resolveFaceSafeVerticalPercent({
          faceBoxes: [{ x: 0.32, y: faceY, width: 0.36, height: 0.22, confidence: 0.92 }],
          preferredTopPercent: 80,
          role: "subtitle",
          disallowTopZone,
        });
        check(
          `subtitle safe zone never enters center face band (faceY=${faceY}, disallowTop=${disallowTopZone})`,
          subY >= 74 || (!disallowTopZone && subY <= 22),
          `got subY=${subY}`,
        );
      }
    }

    // Regression (image.png collision): callout-sticker MUST NOT overlap active subtitle OR face OR chapter-pill!
    const skyShotSticker = resolveFaceSafeStickerPosition({
      faceBoxes: [{ x: 0.44, y: 0.18, width: 0.26, height: 0.26, confidence: 0.9 }],
      seedIndex: 4,
      avoidBands: [
        { top: 72, bottom: 90, left: 0, right: 100 }, // active bottom subtitle
        { top: 5, bottom: 14.5, left: 0, right: 68 }, // active top-left chapter-pill
      ],
    });
    check(
      "callout-sticker avoids active subtitle, top-left chapter-pill, and center-right face simultaneously",
      skyShotSticker.topPercent >= 15
        && skyShotSticker.topPercent + 8 <= 72
        && !(skyShotSticker.leftPercent > 40 && skyShotSticker.topPercent < 44),
      JSON.stringify(skyShotSticker),
    );

    // Regression: coordinateSubtitlePopups suppresses/trims subtitles during hero-freeze-card & coordinateStoryOverlays separates chapter-pill from hero/blooper
    const coordSubs = coordinateSubtitlePopups({
      popups: [
        { start: 30, end: 85, topPercent: 80 }, // completely inside hero-freeze-card (30..90)
        { start: 95, end: 180, topPercent: 80 }, // after hero-freeze-card, overlaps chapter-pill
      ],
      fps: 30,
      faceSafePlacement: true,
      resolveFaceBoxesAtMs: () => [{ x: 0.25, y: 0.68, width: 0.45, height: 0.22, confidence: 0.9 }],
      hookEndFrame: 0,
      storyOverlays: [
        { kind: "hero-freeze-card", startMs: 1000, endMs: 3000, title: "SKY" },
        { kind: "chapter-pill", startMs: 2800, endMs: 6500, title: "ภารกิจ 1/2" },
      ],
    });
    check(
      "coordinateSubtitlePopups suppresses redundant subtitle inside hero-freeze-card and keeps bottom zone when chapter-pill is active",
      coordSubs.length === 1 && coordSubs[0]!.visibleStart === 95 && coordSubs[0]!.topPercent >= 74,
      JSON.stringify(coordSubs),
    );
    const coordOverlays = coordinateStoryOverlays([
      { kind: "hero-freeze-card", startMs: 1000, endMs: 3000, title: "SKY" },
      { kind: "chapter-pill", startMs: 2500, endMs: 6500, title: "ภารกิจ 1/2" },
      { kind: "blooper-end", startMs: 6000, endMs: 8000, title: "เบื้องหลัง" },
    ]);
    const trimmedPill = coordOverlays.find((o) => o.kind === "chapter-pill");
    check(
      "coordinateStoryOverlays trims chapter-pill away from hero-freeze-card and blooper-end",
      Boolean(trimmedPill && trimmedPill.startMs > 3000 && trimmedPill.endMs < 6000),
      JSON.stringify(coordOverlays),
    );

    // ── 4. Beat-Sync Detector & Multi-Cut Story EDL ──────────────────────────
    const envHz = 100;
    const durSec = 16;
    const targetBpm = 120; // 0.5s beat period = 50 samples at 100Hz
    const env = new Float64Array(envHz * durSec);
    for (let beat = 0; beat * 50 < env.length; beat += 1) {
      const idx = beat * 50 + 8;
      if (idx < env.length) env[idx] = 1.0;
      if (idx + 1 < env.length) env[idx + 1] = 0.6;
    }
    const beatDetected = detectBpmAndBeatsFromEnvelope(env, envHz, durSec);
    check(
      "detectBpmAndBeatsFromEnvelope recovers 120 BPM within ±2 BPM",
      Math.abs(beatDetected.bpm - targetBpm) <= 2 && beatDetected.beats.length >= 28,
      `got ${beatDetected.bpm} BPM`,
    );

    const storyPlan = buildStoryDirectorPlan({
      brief: "น้องโซนิคเป็นดรัมเมเยอร์สีชมพู + แข่งวิ่งคว้า 3 เหรียญ",
      templateId: "event-mission-vlog",
      clips: [
        { src: "/api/stocks/c1.mp4", durationSec: 4.2, hasAudio: true, hasSpeechOrCheer: true, transcriptSnippet: "ดรัมเมเยอร์ สีชมพู!" },
        { src: "/api/stocks/c2.mp4", durationSec: 5.0, hasAudio: true },
        { src: "/api/stocks/c3.mp4", durationSec: 6.5, hasAudio: true },
        { src: "/api/stocks/c4.mp4", durationSec: 4.8, stillImage: true },
        { src: "/api/stocks/c5.mp4", durationSec: 5.2, hasAudio: true, hasSpeechOrCheer: true },
      ],
      targetDurationSec: 20,
    });
    check("buildStoryDirectorPlan preserves Cold Open native audio on clip 0", storyPlan.bgVideos[0]?.keepClipAudio === true);
    check("buildStoryDirectorPlan includes Hero Freeze hold", storyPlan.bgVideos.some((v) => (v.freezeAtEndFrames ?? 0) > 0));
    check("buildStoryDirectorPlan includes 0.58x Slow-Mo peak shot", storyPlan.bgVideos.some((v) => v.playbackRate === 0.58));
    check("buildStoryDirectorPlan builds >=4 storyboard summary cards", storyPlan.storyboardCards.length >= 4);

    // ── 5. Native Clip Audio + Live-Photo 20fps -> 30fps Smooth Normalization & Dual TikTok Export ──
    const ffmpeg = getFfmpegPath();
    const livePhotoClip = path.join(tmp, "livephoto-20fps-with-audio.mp4");
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=360x640:rate=20:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      livePhotoClip,
    ]);
    const preMeta = ffprobeVideoStreamMeta(livePhotoClip, "mov");
    check("20fps clip detected as isLivePhotoCadence + hasAudio", preMeta.isLivePhotoCadence && preMeta.hasAudio, JSON.stringify(preMeta));

    const normRes = await normalizeForRemotion(livePhotoClip, {
      inputFormat: "mov",
      preserveAudio: true,
      smoothLivePhoto: true,
    });
    check("normalizeForRemotion(preserveAudio+smoothLivePhoto) succeeds", normRes.status === "normalized");
    const postMeta = ffprobeVideoStreamMeta(livePhotoClip, "mov");
    check("normalized clip is 30fps CFR AND preserves audio stream", postMeta.fps === 30 && postMeta.hasAudio, JSON.stringify(postMeta));

    // Dual Social Export test
    const voiceWav = path.join(tmp, "voice.wav");
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=2",
      voiceWav,
    ]);
    const masterWithBgm = path.join(tmp, "master-with-bgm.mp4");
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      masterWithBgm,
    ]);
    const tiktokOut = path.join(tmp, "master-tiktok-nobgm.mp4");
    const dual = await createDualTikTokSoundMp4({
      masterMp4Path: masterWithBgm,
      outputMp4Path: tiktokOut,
      durationSec: 2,
      voiceSource: voiceWav,
      voiceVolume: 1,
      clipAudioSources: [{ src: livePhotoClip, startSec: 0, endSec: 1.0, volume: 0.9 }],
      storyOverlays: overlays.slice(0, 2),
    });
    check("createDualTikTokSoundMp4 succeeds and applies -14 LUFS loudnorm", dual.ok && dual.loudnessApplied, JSON.stringify(dual));
    const tiktokMeta = ffprobeVideoStreamMeta(tiktokOut, "mov");
    check("TikTok companion MP4 has 30fps video + clean audio track", tiktokMeta.fps === 30 && tiktokMeta.hasAudio);

    // ── 6. Style Packs & MCP Agent-Neutral Schema Compliance ─────────────────
    const activeIds = new Set(activeStylePacks().map((p) => p.id));
    for (const id of ["event-mission-vlog", "proud-moment-highlight", "product-beat-showcase"] as const) {
      check(`Active style packs include ${id}`, activeIds.has(id));
      const pack = stylePack(id);
      check(`${id} carries storyDirector recipe`, Boolean(pack.storyDirector?.beatSync));
      const step1Def = resolveStep1TemplateDefaults(id, { scriptText: "ทดสอบสคริปต์" });
      check(`resolveStep1TemplateDefaults(${id}) resolves cleanly`, step1Def.templateId === id);
    }

    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        id: "u-story-dir",
        name: "Story Director Tester",
        email: "story@aoacademy.co",
        plan: "PRO",
        minutesLimit: 80,
        minutesUsed: 0,
        usagePeriodStartedAt: now,
        usageLimit: 100,
        usageCount: 0,
        subStatus: "active",
        stripeSubscriptionId: "sub_sd",
        planExpiresAt: new Date(now.getTime() + 30 * 86400_000),
      },
    });

    const server = new McpServer({ name: "heroai", version: "0.2.0" }, { capabilities: { tools: {} } });
    const dummyRunner = async (_name: string, _extra: unknown, fn: (p: { userId: string; user: typeof user }) => Promise<unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await fn({ userId: user.id, user })) }],
    });
    server.registerTool("create_video_job", { title: "Create", description: "Create", inputSchema: createVideoJobInputShape }, async () => ({ content: [] }));
    server.registerTool("prepare_video_job", { title: "Prepare", description: "Prepare", inputSchema: prepareVideoJobInputShape }, async () => ({ content: [] }));
    registerMediaImportTools(server, { userId: user.id, user }, dummyRunner as never);
    registerEditTools(server, { userId: user.id, user }, dummyRunner as never);

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const listed = (await client.listTools()).tools;

    const schemaProblems = verifyAgentNeutralSchemas(listed as never, [
      ...MCP_MEDIA_IMPORT_TOOL_NAMES,
      "create_video_job",
      "prepare_video_job",
      "export_video",
    ]);
    check("All Story Director MCP tool schemas are 100% G13 agent-neutral", schemaProblems.length === 0, schemaProblems.join("; "));

    const badAnalyze = await analyzeFootagePackTool(user.id, { uploadIds: ["missing-id"] });
    const badProblems = checkFailureEnvelope(badAnalyze);
    check("analyze_footage_pack missing import returns valid G14 Thai failure envelope", badProblems.length === 0, badProblems.join("; "));

    const impRow = await prisma.mediaImport.create({
      data: {
        userId: user.id,
        source: "upload",
        purpose: "broll_video",
        status: "ready",
        resultSrc: "/api/stocks/demo-story-clip.mp4",
        durationMs: 4800,
        bytes: 12345,
        deadlineAt: now,
      },
    });
    const okAnalyze = await analyzeFootagePackTool(user.id, {
      uploadIds: [impRow.id],
      brief: "น้องสกายเดินพาเหรดสีส้ม + วิ่งผลัดสุดมันส์",
      templateId: "event-mission-vlog",
    }) as Record<string, unknown>;
    check("analyze_footage_pack returns ok:true + Story Director plan", okAnalyze.ok === true && Boolean(okAnalyze.plan), JSON.stringify(okAnalyze));

    // ── 7. Upgraded Models, Credit Pricing, 1fps Contact Sheet, Optical-Flow Slow-Mo & MCP BYO-Brain ──
    check("Default GEMINI_MODEL is gemini-3.8-flash", GEMINI_MODEL === "gemini-3.8-flash");
    check("GEMINI_DIRECTOR_NEON_MODEL is gemini-4-neon", GEMINI_DIRECTOR_NEON_MODEL === "gemini-4-neon");
    check("GEMINI_FAST_LITE_MODEL is gemini-3.5-flash-lite", GEMINI_FAST_LITE_MODEL === "gemini-3.5-flash-lite");
    check(
      "Story Director credit pricing is 19 credits (Neon) and 6 credits (Flash)",
      CREDIT_COST["story-director-neon"] === 19
        && STORY_DIRECTOR_NEON_CREDITS === 19
        && CREDIT_COST["story-director-flash"] === 6
        && STORY_DIRECTOR_FLASH_CREDITS === 6,
    );

    const sheetRes = await buildTimestampedContactSheetJpeg({
      filePath: livePhotoClip,
      durationSec: 2.0,
      clipIndex: 0,
      filename: "IMG_8041.mp4",
    });
    check(
      "buildTimestampedContactSheetJpeg generates valid JPEG contact sheet + timestamps",
      Boolean(sheetRes && sheetRes.base64Jpeg.length > 1000 && sheetRes.timestampsSec.length >= 1),
    );

    const slowDir = path.join(tmp, "slowmo-out");
    const slowMaterialized = await materializeSmoothSlowMoSegments(
      [
        {
          src: "/api/stocks/demo-slow.mp4",
          start: 0,
          end: 2.2,
          clipOffset: 0.1,
          clipDuration: 2.0,
          playbackRate: 0.58,
          provider: "upload",
        },
      ],
      {
        outDir: slowDir,
        urlPrefix: "/api/stocks",
        resolveLocalPath: () => livePhotoClip,
      },
    );
    check(
      "materializeSmoothSlowMoSegments pre-renders 30fps optical-flow clip and resets playbackRate=1",
      slowMaterialized.length === 1
        && slowMaterialized[0]!.playbackRate === 1
        && slowMaterialized[0]!.src.startsWith("/api/stocks/story-slowmo-"),
      JSON.stringify(slowMaterialized),
    );
    const slowMeta = ffprobeVideoStreamMeta(
      path.join(slowDir, path.basename(slowMaterialized[0]!.src)),
      "mov",
    );
    check("optical-flow slow-mo output is true 30fps CFR", slowMeta.fps === 30, JSON.stringify(slowMeta));

    // Copy normalized clip into public/stocks temporarily so inspect_footage_pack & prepareVideoQuote read real frames
    const pubStocksDir = path.join(ROOT, "public", "stocks");
    fs.mkdirSync(pubStocksDir, { recursive: true });
    const tempPublicFilename = `verify-byo-brain-${process.pid}-${Date.now()}.mp4`;
    const tempPublicPath = path.join(pubStocksDir, tempPublicFilename);
    fs.copyFileSync(livePhotoClip, tempPublicPath);
    try {
      const realImpRow = await prisma.mediaImport.create({
        data: {
          userId: user.id,
          source: "upload",
          purpose: "broll_video",
          status: "ready",
          resultSrc: `/api/stocks/${tempPublicFilename}`,
          durationMs: 2000,
          bytes: fs.statSync(tempPublicPath).size,
          deadlineAt: now,
        },
      });
      const inspectRes = await inspectFootagePackTool(user.id, {
        uploadIds: [realImpRow.id],
      });
      check(
        "inspect_footage_pack returns 0-credit summary + image/jpeg contact sheet content block",
        inspectRes.kind === "ok"
          && inspectRes.summaryPayload.ok === true
          && inspectRes.summaryPayload.creditsCharged === 0
          && inspectRes.images.length === 1
          && inspectRes.images[0]!.mimeType === "image/jpeg"
          && inspectRes.images[0]!.data.length > 1000,
      );

      const edlSelection = {
        templateId: "event-mission-vlog",
        headline: "โซนิค ดรัมเมเยอร์สีชมพู",
        subheadline: "คัดช็อตโดย Claude Opus 5.5",
        mission1Label: "ภารกิจ 1: เดินขบวนดรัมเมเยอร์",
        mission2Label: "ภารกิจ 2: แข่งวิ่งผลัดใส่กางเกง",
        shots: [
          {
            clipIndex: 0,
            inSec: 0.1,
            outSec: 1.9,
            role: "cold-open" as const,
            faceZone: "upper" as const,
            keepClipAudio: true,
            captionText: "เปิดขบวนสุดเท่!",
          },
          {
            clipIndex: 0,
            inSec: 0.2,
            outSec: 1.9,
            role: "mission-1" as const,
            captionText: "ก้าวเข้าจังหวะ!",
          },
          {
            clipIndex: 0,
            inSec: 0.1,
            outSec: 1.9,
            role: "mission-2" as const,
            captionText: "วิ่งผลัดสุดมันส์!",
          },
        ],
      };
      const visionPlan = buildStoryDirectorPlanFromVisionSelection({
        brief: "โซนิค ดรัมเมเยอร์",
        voiceMode: "real-moments",
        clips: [
          { src: `/api/stocks/${tempPublicFilename}`, durationSec: 6.0, hasAudio: true },
        ],
        selection: {
          ...edlSelection,
          shots: [
            { ...edlSelection.shots[0]!, outSec: 2.2 },
            { clipIndex: 0, inSec: 0.2, outSec: 2.4, role: "hero-freeze" as const, heroFreeze: true, captionText: "เปิดตัวสุดเท่!" },
            { ...edlSelection.shots[1]!, outSec: 3.6 },
            { ...edlSelection.shots[2]!, outSec: 3.8 },
          ],
        },
      });
      const chapter2 = visionPlan.storyOverlays.find(
        (o) => o.kind === "chapter-pill" && o.title === "ภารกิจ 2/2",
      );
      check(
        "buildStoryDirectorPlanFromVisionSelection builds real-moments momentCaptions, maps shot faceZone, & trims Thai chapter labels cleanly without mid-word slice",
        visionPlan.voiceMode === "real-moments"
          && visionPlan.momentCaptions.length === 4
          && visionPlan.momentCaptions[0]!.text === "เปิดขบวนสุดเท่!"
          && Boolean(visionPlan.bgVideos[0]!.faceBoxes?.length && visionPlan.bgVideos[0]!.faceBoxes[0]!.y < 0.2)
          && chapter2?.subtitle === "แข่งวิ่งผลัดใส่กางเกง",
        JSON.stringify({ chapter2, faceBoxes: visionPlan.bgVideos[0]?.faceBoxes }),
      );

      const quoteRes = await prepareVideoQuote(user, {
        storyUploadIds: [realImpRow.id],
        storyVoiceMode: "real-moments",
        storyEdlJson: JSON.stringify(edlSelection),
      });
      check(
        "prepareVideoQuote accepts scriptless storyVoiceMode=real-moments + storyEdlJson at 0 AI image credits",
        "quoteId" in quoteRes && quoteRes.imageCreditCeiling === 0 && quoteRes.exactDuration === true,
        JSON.stringify(quoteRes),
      );
    } finally {
      if (fs.existsSync(tempPublicPath)) fs.unlinkSync(tempPublicPath);
    }

    console.log(`\nverify-story-director-engine: ALL ${passed} CHECKS PASSED`);
  } finally {
    await getFfprobePath(); // keep import used
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
