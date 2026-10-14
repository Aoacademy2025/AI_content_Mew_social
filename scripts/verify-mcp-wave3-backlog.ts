import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import {
  SFX_MODES,
  SFX_SUBTLE_DB,
  SFX_SUBTLE_LINEAR_VOLUME,
  effectiveSfxMode,
  getTransitionSfxDataUrl,
  isSfxMode,
  planTransitionSfxCues,
  synthesizeTransitionSfxWavBytes,
} from "../src/lib/transition-sfx";
import {
  buildTransitionSfxFfmpegFilter,
  ensureTransitionSfxWavFiles,
} from "../src/lib/transition-sfx.server";
import {
  extractStatCalloutFromText,
  planStatCardsForCaptions,
} from "../src/lib/stat-cards";
import {
  StatCardBadge,
  statCardMotionAt,
} from "../src/remotion/StatCardOverlay";

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave3-backlog-"));
  const dbPath = path.join(tmp, "wave3.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  const {
    getEditStateTool,
    setBrollStyleInputShape,
    setBrollStyleTool,
    setSubtitleStyleInputShape,
    setSubtitleStyleTool,
  } = await import("../src/lib/mcp/edit-tools");
  const { createVideoJobInputSchema } = await import("../src/lib/mcp/create-video-input");
  const { parsePendingEditDraft, toBurnConfig } = await import("../src/lib/mcp/pending-edit-draft");
  const { buildV2BurnConfig, DEFAULT_V2_SUB } = await import("../src/app/(dashboard)/video-editor/_v2/subtitle-style");
  const { normalizeSubtitleStylePresetConfig } = await import("../src/lib/editor-style-preset-contract");
  const { normalizeEditorExportDraft } = await import("../src/lib/editor-export-snapshot");
  const {
    buildBurnConfig,
    resolveMcpSubtitleDesign,
    v2SubConfigToHeroDesign,
  } = await import("../src/lib/mcp/orchestrator-steps");

  try {
    // ── 1. #3 Subtle Transition SFX Pure Logic & PCM WAV Synthesis ──────────────────
    check("SFX_MODES has none and subtle", SFX_MODES[0] === "none" && SFX_MODES[1] === "subtle");
    check("SFX_SUBTLE_DB is -18", SFX_SUBTLE_DB === -18);
    check(
      "SFX_SUBTLE_LINEAR_VOLUME is ~0.1259",
      Math.abs(SFX_SUBTLE_LINEAR_VOLUME - 0.1259) < 1e-4,
    );
    check("isSfxMode validates none and subtle", isSfxMode("none") && isSfxMode("subtle") && !isSfxMode("loud"));
    check("effectiveSfxMode defaults to none", effectiveSfxMode(undefined) === "none" && effectiveSfxMode("subtle") === "subtle");

    check(
      "planTransitionSfxCues returns [] when sfxMode is none",
      planTransitionSfxCues({
        sfxMode: "none",
        brollStartTimesSec: [0, 3, 6.5, 10],
        totalDurationSec: 14,
      }).length === 0,
    );
    const plannedCues = planTransitionSfxCues({
      sfxMode: "subtle",
      brollStartTimesSec: [0, 3, 6.5, 10],
      punchCueTimesSec: [4.9],
      hasOpeningHook: true,
      totalDurationSec: 14,
    });
    check("planTransitionSfxCues schedules cues when subtle", plannedCues.length >= 3, JSON.stringify(plannedCues));
    check(
      "planTransitionSfxCues respects minimum gap and totalDurationSec",
      plannedCues.every((c, idx) => c.timeSec >= 0.05 && c.timeSec < 13.7 && (idx === 0 || c.timeSec - plannedCues[idx - 1].timeSec >= 1.8 - 1e-6)),
    );

    const whooshBytes = synthesizeTransitionSfxWavBytes("whoosh");
    const popBytes = synthesizeTransitionSfxWavBytes("pop");
    check(
      "whoosh WAV starts with RIFF WAVE header",
      Buffer.from(whooshBytes.buffer, whooshBytes.byteOffset, 4).toString("ascii") === "RIFF" &&
        Buffer.from(whooshBytes.buffer, whooshBytes.byteOffset + 8, 4).toString("ascii") === "WAVE",
    );
    check("pop WAV has non-zero PCM payload", popBytes.byteLength > 44);
    check(
      "getTransitionSfxDataUrl returns base64 audio/wav data URL",
      getTransitionSfxDataUrl("whoosh").startsWith("data:audio/wav;base64,") &&
        getTransitionSfxDataUrl("pop").startsWith("data:audio/wav;base64,"),
    );

    const wavFiles = ensureTransitionSfxWavFiles(path.join(tmp, "sfx"));
    check("ensureTransitionSfxWavFiles writes whoosh and pop wav paths", wavFiles.whoosh.endsWith(".wav") && wavFiles.pop.endsWith(".wav"));
    const filterSpec = buildTransitionSfxFfmpegFilter(plannedCues, {
      baseAudioLabel: "0:a",
      firstSfxInputIndex: 1,
      outputLabel: "aout",
    });
    check("buildTransitionSfxFfmpegFilter produces amix filter", filterSpec !== null);
    if (filterSpec) {
      check("FFmpeg filter includes -18dB volume and adelay", filterSpec.includes("volume=-18dB") && filterSpec.includes("adelay=") && filterSpec.includes("amix=inputs="));
    }

    // ── 2. #6 Animated Infographics / Stat Cards Pure Logic & Remotion Badge ────────
    const pctCallout = extractStatCalloutFromText("ยอดขายเติบโตขึ้น 320% ในเดือนเดียว");
    check("extractStatCalloutFromText extracts percentage", pctCallout?.valueText === "320%" && pctCallout.labelText.length > 0, JSON.stringify(pctCallout));

    const multCallout = extractStatCalloutFromText("ประหยัดเวลาทำงานได้ 3 เท่า ทันที");
    check("extractStatCalloutFromText extracts Thai multiplier", multCallout?.valueText === "3เท่า", JSON.stringify(multCallout));

    const bareSingleDigit = extractStatCalloutFromText("มี 3 เรื่องที่อยากเล่าให้ฟัง");
    check("extractStatCalloutFromText ignores bare single-digit numbers without unit", bareSingleDigit === null, JSON.stringify(bareSingleDigit));

    const captions = [
      { startMs: 0, endMs: 2500, text: "ยอดขายโตขึ้น 320% ในไตรมาสแรก" },
      { startMs: 2500, endMs: 4800, text: "และต้นทุนลดลง 45% ทันที" }, // within 3000ms gap -> skipped
      { startMs: 6000, endMs: 8500, text: "ลูกค้าเก่ากลับมาซื้อซ้ำ 4 เท่า" },
    ];
    const statCards = planStatCardsForCaptions(captions, { enabled: true });
    check("planStatCardsForCaptions extracts salient stats and enforces spacing", statCards.length === 2, JSON.stringify(statCards));
    check("first stat card is 320%", statCards[0]?.valueText === "320%");
    check("second stat card is 4เท่า", statCards[1]?.valueText === "4เท่า");
    check("planStatCardsForCaptions returns [] when enabled is false", planStatCardsForCaptions(captions, { enabled: false }).length === 0);

    const enterMotion = statCardMotionAt(100, 2000);
    const steadyMotion = statCardMotionAt(800, 2000);
    check("statCardMotionAt animates entrance and settles at scale 1 / opacity 1", enterMotion.opacity > 0 && steadyMotion.opacity === 1 && Math.abs(steadyMotion.scale - 1) < 1e-4);

    const badgeHtml = renderToStaticMarkup(
      React.createElement(StatCardBadge, {
        card: statCards[0]!,
        frameScale: 1,
        motion: steadyMotion,
        fontFamily: "Kanit",
      }),
    );
    check("StatCardBadge SSR renders valueText and label", badgeHtml.includes("320%") && badgeHtml.includes("data-stat-card"));

    // ── 3. Schema, Draft Persistence & MCP Held Preview Edit Tools ──────────────────
    const createParsed = createVideoJobInputSchema.safeParse({
      script: "ยอดขายเพิ่มขึ้น 250% ใน 7 วัน",
      statCards: true,
      sfxMode: "subtle",
    });
    check("createVideoJobInputSchema accepts statCards and sfxMode", createParsed.success && createParsed.data.statCards === true && createParsed.data.sfxMode === "subtle");

    const presetNorm = normalizeSubtitleStylePresetConfig({
      ...DEFAULT_V2_SUB,
      cardLen: "sentence",
      statCards: true,
    });
    check("normalizeSubtitleStylePresetConfig preserves statCards", presetNorm?.statCards === true);

    const snapshotNorm = normalizeEditorExportDraft({
      version: 1,
      captions,
      originalCaptions: captions,
      subtitleConfig: { ...DEFAULT_V2_SUB, statCards: true },
      cardLen: "sentence",
      captionOverrides: {},
    });
    check("normalizeEditorExportDraft preserves statCards", snapshotNorm?.subtitleConfig.statCards === true);

    const v2BurnCfg = buildV2BurnConfig(
      "https://example.com/video.mp4",
      captions,
      9000,
      { ...DEFAULT_V2_SUB, statCards: true },
    );
    check("buildV2BurnConfig sets subtitleStatCards", v2BurnCfg.subtitleStatCards === true);

    const heroDesign = v2SubConfigToHeroDesign({ ...DEFAULT_V2_SUB, statCards: true });
    check("v2SubConfigToHeroDesign preserves statCards", heroDesign.statCards === true);

    const { design: resolvedDesign } = resolveMcpSubtitleDesign({ statCards: true }, null);
    check("resolveMcpSubtitleDesign resolves statCards", resolvedDesign.statCards === true);

    const mcpBurnCfg = buildBurnConfig("https://example.com/video.mp4", captions, 9000, heroDesign);
    check("buildBurnConfig sets subtitleStatCards", mcpBurnCfg.subtitleStatCards === true);

    const setSubParsed = z.object(setSubtitleStyleInputShape).safeParse({
      jobId: "job_123",
      statCards: true,
    });
    check("setSubtitleStyleInputShape accepts statCards boolean", setSubParsed.success);

    const setBrollParsed = z.object(setBrollStyleInputShape).safeParse({
      jobId: "job_123",
      sfxMode: "subtle",
    });
    check("setBrollStyleInputShape accepts sfxMode subtle", setBrollParsed.success);

    const draft = parsePendingEditDraft(
      JSON.stringify({
        version: 1,
        rootJobId: "job_root",
        baseJobId: "job_root",
        captions,
        originalCaptions: captions,
        words: [],
        fullText: "ยอดขายโตขึ้น 320%",
        cardLen: "sentence",
        subtitleConfig: { ...DEFAULT_V2_SUB, statCards: true },
        captionOverrides: {},
        tailHoldMs: 0,
        windowEdits: [],
        sfxMode: "subtle",
      }),
    );
    check("parsePendingEditDraft preserves sfxMode and subtitleConfig.statCards", draft?.sfxMode === "subtle" && draft?.subtitleConfig.statCards === true);

    if (draft) {
      const burnCfg = toBurnConfig(draft, {
        videoUrl: "https://example.com/video.mp4",
        preview: {
          audioDurationMs: 9000,
          captions,
          words: [],
          fullText: "ยอดขายโตขึ้น 320%",
          config: {
            bgVideos: [
              { src: "https://example.com/1.mp4", start: 0, duration: 3, brollEnabled: true },
              { src: "https://example.com/2.mp4", start: 3, duration: 3.5, brollEnabled: true },
              { src: "https://example.com/3.mp4", start: 6.5, duration: 2.5, brollEnabled: true },
            ],
            durationInFrames: 270,
          },
        },
      });
      check(
        "toBurnConfig sets subtitleStatCards, sfxMode, and sfxCues",
        burnCfg.subtitleStatCards === true && burnCfg.sfxMode === "subtle" && (burnCfg.sfxCues?.length ?? 0) > 0,
      );
    }

    // End-to-end Held Preview MCP quote + edit tools (`set_subtitle_style` + `set_broll_style` + `get_edit_state`)
    const { prepareVideoQuote, decideVideoQuote } = await import("../src/lib/mcp/video-quote.server");
    const { requestVideoJob } = await import("../src/lib/mcp/video-budget.server");
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        id: "user-wave3",
        name: "Wave 3 Tester",
        email: "wave3@aoacademy.co",
        plan: "PRO",
        minutesLimit: 80,
        minutesUsed: 0,
        usagePeriodStartedAt: now,
        trialEndsAt: null,
        usageLimit: 100,
        usageCount: 0,
        subStatus: "active",
        stripeSubscriptionId: "sub_wave3",
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: "user-wave3",
        stripeSessionId: "cs_wave3",
        plan: "PRO",
        amount: 59_900,
        status: "PAID",
        periodDays: 30,
        paidAt: now,
      },
    });

    const quote = await prepareVideoQuote(user, {
      script: "สวัสดีครับ ยอดขายเติบโตขึ้น 320% ในไตรมาสแรก และลูกค้าเก่าซื้อซ้ำ 4 เท่า",
      brollSource: "stock",
      bgmFile: "none",
      exportMode: "hold",
      statCards: true,
      sfxMode: "subtle",
    });
    check("prepareVideoQuote succeeds with statCards and sfxMode", !("error" in quote));
    if (!("error" in quote)) {
      await decideVideoQuote(user.id, quote.quoteId, "approve");
      const created = (await requestVideoJob(user, { quoteId: quote.quoteId })) as {
        jobId: string;
        projectId: string;
      };
      check("requestVideoJob consumes quote and creates held job", typeof created.jobId === "string");

      await prisma.videoJob.update({
        where: { id: created.jobId },
        data: {
          status: "done",
          progress: 100,
          outputJson: JSON.stringify({
            version: 2,
            videoUrl: "/renders/wave3-preview.mp4",
            audioDurationMs: 9000,
            preview: {
              compositeBaseUrl: "/renders/wave3-preview.mp4",
              audioDurationMs: 9000,
              captions,
              config: {
                fps: 30,
                durationInFrames: 270,
                sfxMode: "subtle",
                bgVideos: [
                  { src: "/stocks/a.mp4", start: 0, end: 4.5, brollEnabled: true },
                  { src: "/stocks/b.mp4", start: 4.5, end: 9, brollEnabled: true },
                ],
              },
            },
          }),
        },
      });

      const state1 = (await getEditStateTool(user.id, created.jobId)) as {
        subtitleStyle: { statCards: boolean };
        sfxMode: string;
        allowed: { sfxModes: string[] };
      };
      check(
        "get_edit_state reflects initial statCards=true and sfxMode='subtle' and allowed.sfxModes",
        state1.subtitleStyle?.statCards === true &&
          state1.sfxMode === "subtle" &&
          Array.isArray(state1.allowed?.sfxModes) &&
          state1.allowed.sfxModes.includes("subtle"),
      );

      const subUpdated = await setSubtitleStyleTool(user.id, {
        jobId: created.jobId,
        statCards: false,
      });
      check(
        "setSubtitleStyleTool toggles statCards to false",
        "ok" in subUpdated && subUpdated.ok === true && subUpdated.subtitleStyle.statCards === false,
      );

      const brollUpdated = await setBrollStyleTool(user, {
        jobId: created.jobId,
        sfxMode: "none",
      });
      check(
        "setBrollStyleTool updates project-level sfxMode to none",
        "ok" in brollUpdated && brollUpdated.ok === true && "sfxMode" in brollUpdated && brollUpdated.sfxMode === "none",
      );

      const state2 = (await getEditStateTool(user.id, created.jobId)) as {
        subtitleStyle: { statCards: boolean };
        sfxMode: string;
      };
      check(
        "getEditStateTool surfaces updated subtitleStyle.statCards=false and sfxMode='none'",
        state2.subtitleStyle?.statCards === false && state2.sfxMode === "none",
      );
    }
  } finally {
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`verify-mcp-wave3-backlog: ${passed} assertions passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
