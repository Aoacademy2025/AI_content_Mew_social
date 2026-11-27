/**
 * End-to-end regression suite for Production-Grade Video Quality Upgrades (Packs 1–3):
 *   - Pack 1: Aspect-safe cutaway composite + dissolve lead-in, 30fps CFR single-clip
 *             presenter normalization, 30fps avatar chroma-key sync, 6s 2x-oversampled Ken Burns.
 *   - Pack 2: Vision re-ranker thumbnail wiring, Full-HD Pixabay variant floor (blocking 4K),
 *             semantic AutoMix slot routing, positive hand posture framing.
 *   - Pack 3: Motion B-Roll self-promo de-mockup, word-synced Karaoke/Highlight subtitles +
 *             contiguous anti-blink flags, BGM speech ducking + fade-in/out envelope, and
 *             48kHz stereo 16-bit PCM transition SFX synthesis.
 *
 * Run: npx tsx scripts/verify-production-video-quality-upgrades.ts
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildCutawayCompositeFilter } from "../src/lib/cutaway-composite";
import { stitchPresenterVideoFiles, probeClipInfoViaFfmpeg } from "../src/lib/presenter-stitch.server";
import { buildCompositeFilter } from "../src/lib/chroma-key";
import { KEN_BURNS_DURATION_SEC } from "../src/lib/broll-asset-lib";
import { pickPixabayVariant } from "../src/lib/broll-source-quality";
import { planAutoMixSources, planSemanticAutoMixSources } from "../src/lib/automix-plan";
import { sceneDiversityClause } from "../src/lib/scene-brief-diversity";
import { planMotionSceneForWindow } from "../src/lib/motion-broll-catalog";
import { buildHeroSubtitleOverlayConfig } from "../src/lib/hero-editorial";
import { DEFAULT_V2_SUB, buildV2BurnConfig } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import { renderSubtitle } from "../src/remotion/renderSubtitle";
import { bgmEnvelopeGainAt, speechSegments } from "../src/lib/background-music";
import { synthesizeTransitionSfxWavBytes } from "../src/lib/transition-sfx";
import { getFfmpegPath } from "../src/lib/ffmpeg-path";

const execFileAsync = promisify(execFile);

let passed = 0;
function check(label: string, cond: unknown, detail = ""): void {
  if (!cond) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
  passed += 1;
}

async function main() {
  const ffmpeg = getFfmpegPath();

  // ── Pack 1: Transitions, CFR 30fps Sync, Aspect-Safe Cutaway & Ken Burns ──
  console.log("\n[Pack 1] Transitions, CFR 30fps Sync & Aspect-Safe Composite");

  const cutawayWithLeadIn = buildCutawayCompositeFilter(
    [
      { start: 0, end: 3.5 },
      { start: 7.0, end: 11.0 },
    ],
    { dissolveLeadInSec: 8 / 30 },
  );
  check(
    "cutaway filter uses aspect-safe cover crop on presenter stream",
    cutawayWithLeadIn !== null
      && cutawayWithLeadIn.includes("force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920"),
  );
  check(
    "cutaway dissolveLeadInSec keeps t=0 hook intact while delaying internal return by ~0.267s",
    cutawayWithLeadIn !== null
      && cutawayWithLeadIn.includes("between(t,0.000,3.500)+between(t,7.267,11.000)"),
    cutawayWithLeadIn ?? "",
  );

  const chromaFilter = buildCompositeFilter(
    { color: "0x12FF05", similarity: 0.28, blend: 0.1 },
    null,
  );
  check(
    "avatar chroma-key filter normalizes foreground stream to 30fps",
    chromaFilter.includes(",fps=30[fg]"),
    chromaFilter,
  );

  check(
    "KEN_BURNS_DURATION_SEC is 6s so standard 4–5.4s B-roll windows never Loop-snap",
    KEN_BURNS_DURATION_SEC === 6,
    `got ${KEN_BURNS_DURATION_SEC}`,
  );

  // Verify single-clip 60fps presenter upload normalizes to 30fps CFR 1080x1920
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const raw60Name = `verify-60fps-presenter-${Date.now()}.mp4`;
  const raw60Path = path.join(rendersDir, raw60Name);
  const cleanupPaths = [raw60Path];
  try {
    await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=darkslateblue:s=720x1280:r=60:d=1.0",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1.0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      raw60Path,
    ]);
    const stitched = await stitchPresenterVideoFiles({
      clipUrls: [`/api/renders/${raw60Name}`],
      presenterFit: "crop",
    });
    const normalizedPath = path.join(rendersDir, path.basename(stitched.clipUrl));
    cleanupPaths.push(normalizedPath);
    check("single 60fps 720x1280 upload is normalized to canonical 30fps CFR", stitched.stitched === true);
    const probed = await probeClipInfoViaFfmpeg(normalizedPath);
    check(
      "normalized presenter clip is 1080x1920 @ 30fps h264 yuv420p",
      probed.width === 1080
        && probed.height === 1920
        && probed.codec === "h264"
        && probed.pixFmt === "yuv420p"
        && Boolean(probed.fps && Math.abs(probed.fps - 30) <= 0.05),
      JSON.stringify(probed),
    );

    // Verify 16:9 presenter input inside cutaway composite is cover-cropped (square stays ~1:1, never stretched)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cutaway-aspect-verify-"));
    cleanupPaths.push(tmpDir);
    const bgMp4 = path.join(tmpDir, "bg.mp4");
    const widePresenterMp4 = path.join(tmpDir, "wide-presenter.mp4");
    const compMp4 = path.join(tmpDir, "comp.mp4");
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", bgMp4,
    ]);
    // 1600x900 landscape presenter with centered 300x300 white square
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=1600x900:r=30:d=1",
      "-vf", "drawbox=x=650:y=300:w=300:h=300:color=white:t=fill",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", widePresenterMp4,
    ]);
    const aspectFilter = buildCutawayCompositeFilter([{ start: 0, end: 1 }])!;
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", bgMp4, "-i", widePresenterMp4,
      "-filter_complex", aspectFilter,
      "-map", "[out]", "-frames:v", "1", "-f", "mp4",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", compMp4,
    ]);
    let bboxStderr = "";
    try {
      const r = await execFileAsync(ffmpeg, [
        "-hide_banner", "-y", "-i", compMp4, "-frames:v", "1", "-vf", "bbox=min_val=200", "-f", "null", "-",
      ]);
      bboxStderr = r.stderr ?? "";
    } catch (e) {
      bboxStderr = (e as { stderr?: string }).stderr ?? "";
    }
    const bboxMatch = [...bboxStderr.matchAll(/w:(\d+)\s+h:(\d+)/g)].at(-1);
    const ratio = bboxMatch ? Number(bboxMatch[1]) / Number(bboxMatch[2]) : 0;
    check(
      "cutaway composite preserves 1:1 square proportions on 16:9 presenter input (no stretch)",
      ratio > 0.9 && ratio < 1.1,
      `ratio=${ratio.toFixed(3)}`,
    );
  } finally {
    for (const p of cleanupPaths) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }

  // ── Pack 2: B-Roll Context, Vision Ranker Thumbs, HD Stock & Semantic AutoMix ──
  console.log("\n[Pack 2] B-Roll Context, Vision Re-Ranker, HD Stock & AutoMix");

  const fetchStockSrc = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/videos/fetch-stock/route.ts"),
    "utf8",
  );
  check(
    "fetch-stock wires Pexels and Pixabay thumbnails into CandidateVideo for Vision Re-Ranker",
    fetchStockSrc.includes("...(v.image ? { thumb: v.image } : {})")
      && fetchStockSrc.includes("...(pv.thumb ? { thumb: pv.thumb } : {})"),
  );
  check(
    "fetch-stock unlocks Pixabay/Pexels photo fallbacks on managed keys with photo deduplication",
    fetchStockSrc.includes("const canUsePixabayPhotoFallback = useAutoMix && !!pixabayKey")
      && fetchStockSrc.includes("usedAutoMixPhotoIds"),
  );

  const hdPick = pickPixabayVariant(
    { url: "med-540", width: 540, height: 960 },
    { url: "lg-1080", width: 1080, height: 1920 },
  );
  const block4kPick = pickPixabayVariant(
    { url: "med-540", width: 540, height: 960 },
    { url: "lg-4k", width: 2160, height: 3840 },
  );
  check("pickPixabayVariant upgrades 540p medium to 1080p Full-HD large", hdPick.url === "lg-1080");
  check("pickPixabayVariant still blocks 4K (>1920) large variants", block4kPick.url === "med-540");

  const weights = { video: 3, photo: 2, ai: 1 };
  const baseMix = planAutoMixSources(6, weights);
  const semanticMix = planSemanticAutoMixSources(6, weights, [
    "เปิดคลิปสวัสดีทุกคน",
    "กำลังเดินและพิมพ์งานบนโน้ตบุ๊กในออฟฟิศ",
    "ภาพนิ่งโต๊ะทำงานมินิมอล",
    "ข้อมูลสำคัญของการวางระบบ",
    "เปรียบเหมือนกับดักจิตวิทยาในตลาดนัดกรุงเทพราคาหลักร้อยบาท",
    "กำลังชงกาแฟและเทลงแก้วใส",
  ]);
  check(
    "planSemanticAutoMixSources preserves exact 3:2:1 source budget and slot[0] !== 'ai'",
    semanticMix.filter((s) => s === "video").length === baseMix.filter((s) => s === "video").length
      && semanticMix.filter((s) => s === "photo").length === baseMix.filter((s) => s === "photo").length
      && semanticMix.filter((s) => s === "ai").length === baseMix.filter((s) => s === "ai").length
      && semanticMix[0] !== "ai",
    semanticMix.join(","),
  );
  check(
    "planSemanticAutoMixSources routes culturally-specific Thai/idiom window to paid AI slot",
    semanticMix[4] === "ai" && semanticMix[1] === "video" && semanticMix[5] === "video",
    semanticMix.join(","),
  );

  const divClause = sceneDiversityClause({
    setting: "a local bakery",
    action: "knead dough on a wooden counter",
    shotScale: "medium observational view",
    allowPointing: false,
  });
  check(
    "sceneDiversityClause leads with positive hand posture while keeping HERO-56 pointing refusal",
    divClause.includes("Hands stay engaged with the scene's objects")
      && divClause.includes("No pointing hand and no pointing finger."),
  );

  // ── Pack 3: Motion B-Roll De-Mockup, Word-Synced Subtitles & Audio/SFX ──
  console.log("\n[Pack 3] Motion B-Roll De-Mockup, Word-Synced Subtitles & Broadcast Audio");

  const motionSceneSrc = fs.readFileSync(
    path.join(process.cwd(), "src/remotion/MotionBrollScene.tsx"),
    "utf8",
  );
  const motionCatalogSrc = fs.readFileSync(
    path.join(process.cwd(), "src/lib/motion-broll-catalog.ts"),
    "utf8",
  );
  check(
    "MotionBrollScene and motion-broll-catalog contain zero self-promotional Mew Social / duckyhero mockup strings",
    !/mewsocial|Mew Social|duckyhero|Mew Guide/i.test(motionSceneSrc)
      && !/mewsocial|Mew Social|duckyhero|Mew Guide/i.test(motionCatalogSrc),
  );

  const plannedMotion = planMotionSceneForWindow({
    themeId: "cue-step-board",
    windowIndex: 1,
    totalWindows: 4,
    spokenText: "ขั้นตอนการตั้งงบประมาณโฆษณาให้ได้กำไรสูงสุด",
    clipTitle: "ตั้งงบโฆษณา",
  });
  check(
    "planMotionSceneForWindow derives subtitle from spoken topic instead of hardcoded file paths",
    Boolean(plannedMotion.props.subtitle && !plannedMotion.props.subtitle.includes("mewsocial")),
    plannedMotion.props.subtitle,
  );

  // Word-synced subtitles & contiguous anti-blink flags
  const captions = [
    { text: "คำแรกสั้น คำหลังยาวมาก", startMs: 0, endMs: 2000, tag: "hook" as const },
    { text: "ประโยคต่อมาติดกันเลย", startMs: 2020, endMs: 3500, tag: "body" as const },
  ];
  const words = [
    // Deliberately hold the short first word for 1.6s (48 frames) and say the second phrase fast in 0.4s
    { word: "คำแรกสั้น", startMs: 0, endMs: 1600 },
    { word: "คำหลังยาวมาก", startMs: 1600, endMs: 2000 },
    { word: "ประโยคต่อมาติดกันเลย", startMs: 2020, endMs: 3500 },
  ];
  const overlayCfg = buildHeroSubtitleOverlayConfig({
    baseVideoUrl: "/api/renders/test.mp4",
    captions,
    durationMs: 3500,
    fps: 30,
    design: {
      fontFamily: "Kanit",
      positionTopPercent: 82,
      fontSize: 80,
      fontWeight: 900,
      color: "#FFFFFF",
      accentColor: "#FFE500",
      stylePreset: "box-rounded",
      textEffect: "highlight",
    },
    words,
  });
  check(
    "buildHeroSubtitleOverlayConfig populates popup.words and contiguousNext/contiguousPrev flags",
    Boolean(
      overlayCfg.keywordPopups[0]?.words?.length === 2
        && overlayCfg.keywordPopups[0]?.contiguousNext === true
        && overlayCfg.keywordPopups[1]?.contiguousPrev === true,
    ),
  );
  const v2BurnCfg = buildV2BurnConfig(
    "/api/renders/test.mp4",
    captions,
    3500,
    DEFAULT_V2_SUB,
    30,
    {},
    undefined,
    undefined,
    undefined,
    0,
    "none",
    words,
  );
  check(
    "buildV2BurnConfig preserves DEFAULT_V2_SUB.verticalPos=82 and attaches popup.words",
    DEFAULT_V2_SUB.verticalPos === 82 && v2BurnCfg.keywordPopups[0]?.words?.length === 2,
  );

  // At frame 35 (1.16s out of 2.0s = 58% into the card), character-ratio fallback would have
  // jumped to "คำหลังยาวมาก", whereas real wordTimings knows the speaker is STILL saying "คำแรกสั้น" (0..48f)!
  const htmlAtFrame35 = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderSubtitle(
        "คำแรกสั้น คำหลังยาวมาก",
        "#FFFFFF",
        80,
        true,
        "box-rounded",
        "Kanit",
        900,
        35,
        60,
        "highlight",
        "#FFE500",
        {
          wordTimings: [
            { word: "คำแรกสั้น", startFrame: 0, endFrame: 48 },
            { word: "คำหลังยาวมาก", startFrame: 48, endFrame: 60 },
          ],
        },
      ),
    ),
  );
  const htmlAtFrame52 = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderSubtitle(
        "คำแรกสั้น คำหลังยาวมาก",
        "#FFFFFF",
        80,
        true,
        "box-rounded",
        "Kanit",
        900,
        52,
        60,
        "highlight",
        "#FFE500",
        {
          wordTimings: [
            { word: "คำแรกสั้น", startFrame: 0, endFrame: 48 },
            { word: "คำหลังยาวมาก", startFrame: 48, endFrame: 60 },
          ],
        },
      ),
    ),
  );
  const stripWordJoiners = (s: string) => s.replace(/\u2060/g, "");
  const clean35 = stripWordJoiners(htmlAtFrame35);
  const clean52 = stripWordJoiners(htmlAtFrame52);
  check(
    "renderSubtitle highlight syncs to real wordTimings at frame 35 and advances after frame 48",
    clean35.includes('background:#FFE500')
      && clean35.indexOf('background:#FFE500') < clean35.indexOf('คำแรกสั้น')
      && clean52.indexOf('background:#FFE500') > clean52.indexOf('คำแรกสั้น'),
    clean35,
  );

  // BGM envelope: fade-in, speech ducking, fade-out
  const segs = speechSegments({ captions: [{ startMs: 1000, endMs: 3000 }] });
  const gainAt0 = bgmEnvelopeGainAt(0, 5000, { volume: 0.12, ducking: true, segments: segs });
  const gainAt500 = bgmEnvelopeGainAt(500, 5000, { volume: 0.12, ducking: true, segments: segs });
  const gainAt2000 = bgmEnvelopeGainAt(2000, 5000, { volume: 0.12, ducking: true, segments: segs });
  const gainAt5000 = bgmEnvelopeGainAt(5000, 5000, { volume: 0.12, ducking: true, segments: segs });
  check("bgmEnvelopeGainAt starts at 0 at t=0ms (no click)", gainAt0 === 0);
  check("bgmEnvelopeGainAt reaches full 0.12 volume in non-speech intro", Math.abs(gainAt500 - 0.12) < 1e-6);
  check("bgmEnvelopeGainAt ducks to ~35% under active speech", Math.abs(gainAt2000 - 0.12 * 0.35) < 1e-6);
  check("bgmEnvelopeGainAt fades smoothly to 0 at clip end", gainAt5000 === 0);

  // 48kHz Stereo 16-bit PCM SFX synthesis
  for (const kind of ["whoosh", "pop"] as const) {
    const wav = synthesizeTransitionSfxWavBytes(kind);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const channels = dv.getUint16(22, true);
    const sampleRate = dv.getUint32(24, true);
    const bitsPerSample = dv.getUint16(34, true);
    const firstL = dv.getInt16(44, true);
    check(
      `synthesizeTransitionSfxWavBytes("${kind}") produces 48kHz stereo 16-bit PCM WAV starting at 0 amplitude`,
      channels === 2 && sampleRate === 48000 && bitsPerSample === 16 && firstL === 0,
      `ch=${channels} sr=${sampleRate} bits=${bitsPerSample} firstL=${firstL}`,
    );
  }

  console.log(`\n✅ ALL ${passed} PRODUCTION VIDEO QUALITY UPGRADE CHECKS PASSED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
