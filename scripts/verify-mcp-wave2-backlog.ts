/**
 * Verification suite for EP5/S2 Studio Backlog Wave 2:
 *   - #5 First-3-Second Visual Hook Overlay (`banner` / `stat-burst` / `question-pill` + MCP `create_video_job` & `set_headline_hook`)
 *   - #2 Auto-Highlight Keywords in Subtitles (`highlightKeywords` in Remotion, Editor v2, and MCP `create_video_job` / `set_subtitle_style`)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave2-backlog-"));
  const dbPath = path.join(tmp, "wave2.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  const {
    HEADLINE_HOOK_PRESETS,
    isHeadlineHookPreset,
    normalizeHeadlineHook,
    resolveInitialHeadlineHookFromJobInput,
  } = await import("../src/lib/headline-hook");
  const { HeadlineHookView } = await import("../src/remotion/HeadlineHookView");
  const {
    extractHighlightedKeywords,
    scoreSubtitleTokenForHighlight,
    selectHighlightedTokenIndices,
  } = await import("../src/lib/subtitle-keyword-highlight");
  const { renderSubtitle } = await import("../src/remotion/renderSubtitle");
  const { buildV2BurnConfig, DEFAULT_V2_SUB } = await import(
    "../src/app/(dashboard)/video-editor/_v2/subtitle-style"
  );
  const {
    buildBurnConfig,
    resolveMcpSubtitleDesign,
    v2SubConfigToHeroDesign,
  } = await import("../src/lib/mcp/orchestrator-steps");
  const { createVideoJobInputSchema } = await import("../src/lib/mcp/create-video-input");
  const { prepareVideoQuote, decideVideoQuote } = await import("../src/lib/mcp/video-quote.server");
  const { requestVideoJob } = await import("../src/lib/mcp/video-budget.server");
  const {
    getEditStateTool,
    setHeadlineHookTool,
    setSubtitleStyleTool,
    setSubtitleStyleInputShape,
  } = await import("../src/lib/mcp/edit-tools");

  try {
    let passed = 0;
    const check = (label: string, cond: boolean) => {
      assert.ok(cond, label);
      passed += 1;
    };

    const now = new Date();
    const user = await prisma.user.create({
      data: {
        id: "user-wave2",
        name: "Wave 2 Tester",
        email: "wave2@aoacademy.co",
        plan: "PRO",
        minutesLimit: 80,
        minutesUsed: 0,
        usagePeriodStartedAt: now,
        trialEndsAt: null,
        usageLimit: 100,
        usageCount: 0,
        subStatus: "active",
        stripeSubscriptionId: "sub_wave2",
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: "user-wave2",
        stripeSessionId: "cs_wave2",
        plan: "PRO",
        amount: 59_900,
        status: "PAID",
        periodDays: 30,
        paidAt: now,
      },
    });
    await prisma.music.create({
      data: {
        id: "music-wave2",
        title: "Wave 2 Beat",
        filename: "wave2-beat.mp3",
      },
    });

    // ── 1. #5 First-3-Second Visual Hook Overlay ─────────────────────────────
    for (const preset of ["viral", "news", "clean", "banner", "stat-burst", "question-pill"] as const) {
      check(`HEADLINE_HOOK_PRESETS includes ${preset}`, HEADLINE_HOOK_PRESETS.includes(preset));
      check(`isHeadlineHookPreset(${preset}) is true`, isHeadlineHookPreset(preset));
    }
    check("isHeadlineHookPreset rejects unknown preset", !isHeadlineHookPreset("neon-laser"));

    const bannerHook = resolveInitialHeadlineHookFromJobInput(
      {
        headlineHook: "3 ความลับเพิ่มยอดขาย 300%",
        headlineHookSubtext: "ฟังจบทำตามได้ทันที",
        headlineHookStyle: "banner",
        headlineHookDurationMs: 3500,
      },
      30_000,
      82,
    );
    check(
      "resolveInitialHeadlineHookFromJobInput resolves flat headlineHook + banner style",
      bannerHook !== undefined
        && bannerHook.enabled === true
        && bannerHook.preset === "banner"
        && bannerHook.headline === "3 ความลับเพิ่มยอดขาย 300%"
        && bannerHook.subheadline === "ฟังจบทำตามได้ทันที"
        && bannerHook.durationMs === 3500,
    );

    const visualHookAlias = resolveInitialHeadlineHookFromJobInput(
      {
        visualHook: "+340% ยอดวิวพุ่งใน 7 วัน",
        visualHookStyle: "stat-burst",
      },
      30_000,
      82,
    );
    check(
      "resolveInitialHeadlineHookFromJobInput resolves visualHook + visualHookStyle alias",
      visualHookAlias !== undefined
        && visualHookAlias.enabled === true
        && visualHookAlias.preset === "stat-burst"
        && visualHookAlias.headline === "+340% ยอดวิวพุ่งใน 7 วัน"
        && visualHookAlias.durationMs === 3000,
    );

    const questionPillHook = normalizeHeadlineHook(
      {
        enabled: true,
        headline: "ทำไมยิงแอดแล้วเงียบ?",
        subheadline: "เช็ก 3 จุดนี้ก่อนเสียเงินฟรี",
        preset: "question-pill",
        durationMs: 3200,
      },
      25_000,
      82,
    );
    check(
      "normalizeHeadlineHook accepts question-pill preset",
      questionPillHook !== undefined
        && questionPillHook.preset === "question-pill"
        && questionPillHook.enabled === true,
    );

    for (const preset of ["banner", "stat-burst", "question-pill"] as const) {
      const hookCfg = normalizeHeadlineHook(
        {
          enabled: true,
          headline: "หยุดเลื่อน! 3 เทคนิคเพิ่มยอดวิว",
          subheadline: "สรุปครบใน 30 วินาที",
          preset,
        },
        30_000,
        82,
      )!;
      const html = renderToStaticMarkup(
        React.createElement(HeadlineHookView, { hook: hookCfg, frameScale: 1 }),
      );
      check(
        `HeadlineHookView renders preset=${preset} with data-headline-hook-preset`,
        html.includes(`data-headline-hook-preset="${preset}"`)
          && html.includes("หยุดเลื่อน! 3 เทคนิคเพิ่มยอดวิว"),
      );
    }

    // ── 2. #2 Auto-Highlight Keywords in Subtitles ───────────────────────────
    check(
      "scoreSubtitleTokenForHighlight prioritizes numbers/percentages over ordinary words",
      scoreSubtitleTokenForHighlight("300%") > scoreSubtitleTokenForHighlight("เทคนิคการตลาด")
        && scoreSubtitleTokenForHighlight("เทคนิคการตลาด") > scoreSubtitleTokenForHighlight("และ"),
    );
    check(
      "scoreSubtitleTokenForHighlight returns 0 for Thai and English stopwords",
      scoreSubtitleTokenForHighlight("และ") === 0
        && scoreSubtitleTokenForHighlight("ของ") === 0
        && scoreSubtitleTokenForHighlight("the") === 0,
    );

    const statCardKeywords = extractHighlightedKeywords("เพิ่มยอดขาย 300% ใน 7 วัน");
    check(
      "extractHighlightedKeywords picks numeric/stat tokens first (max 2)",
      statCardKeywords.length === 2
        && statCardKeywords.includes("300%")
        && statCardKeywords.includes("7"),
    );

    const textCardKeywords = extractHighlightedKeywords("และ ของ เทคนิคการตลาด สร้างแบรนด์");
    check(
      "extractHighlightedKeywords skips stopwords and picks salient content tokens",
      textCardKeywords.length > 0
        && textCardKeywords.length <= 2
        && !textCardKeywords.includes("และ")
        && !textCardKeywords.includes("ของ")
        && textCardKeywords.includes("เทคนิค"),
    );

    const singleWordNonStat = selectHighlightedTokenIndices(["สวัสดีครับ"]);
    check(
      "selectHighlightedTokenIndices does not highlight a single-token card when not a number/stat",
      singleWordNonStat.size === 0,
    );
    const singleWordStat = selectHighlightedTokenIndices(["+300%"]);
    check(
      "selectHighlightedTokenIndices highlights a single-token card when it is a number/stat",
      singleWordStat.has(0),
    );

    const plainSubtitleHtml = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderSubtitle(
          "เพิ่มยอดขาย 300% ใน 7 วัน",
          "#FFFFFF",
          64,
          false,
          "none",
          "'Kanit', sans-serif",
          900,
          0,
          60,
          "none",
          "#FFD700",
          { highlightKeywords: false },
        ),
      ),
    );
    check(
      "renderSubtitle without highlightKeywords does not emit data-keyword-highlight spans",
      !plainSubtitleHtml.includes('data-keyword-highlight="true"'),
    );

    const highlightedBodyHtml = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderSubtitle(
          "เพิ่มยอดขาย 300% ใน 7 วัน",
          "#FFFFFF",
          64,
          false,
          "none",
          "'Kanit', sans-serif",
          900,
          0,
          60,
          "none",
          "#FFD700",
          { highlightKeywords: true },
        ),
      ),
    );
    check(
      "renderSubtitle with highlightKeywords=true on body card wraps salient tokens with data-keyword-highlight and accentColor",
      highlightedBodyHtml.includes('data-keyword-highlight="true"')
        && (highlightedBodyHtml.includes("#FFD700") || highlightedBodyHtml.includes("rgb(255, 215, 0)")),
    );

    const highlightedHookHtml = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderSubtitle(
          "หยุดดู! ยอดวิวพุ่ง 300% ทันที",
          "#FFFFFF",
          64,
          true,
          "none",
          "'Kanit', sans-serif",
          900,
          0,
          60,
          "none",
          "#FFD700",
          { highlightKeywords: true },
        ),
      ),
    );
    check(
      "renderSubtitle with highlightKeywords=true on hook card uses contrasting #FFFFFF highlight over accentColor card",
      highlightedHookHtml.includes('data-keyword-highlight="true"')
        && (highlightedHookHtml.includes("#FFFFFF") || highlightedHookHtml.includes("rgb(255, 255, 255)")),
    );

    // ── 3. Burn Config & Subtitle Design Threading ───────────────────────────
    const resolvedDesign = resolveMcpSubtitleDesign({
      subtitleStyle: "viral",
      subtitleAccentColor: "#00F5D4",
      highlightKeywords: true,
    });
    check(
      "resolveMcpSubtitleDesign threads highlightKeywords=true onto V2SubConfig",
      resolvedDesign.design.highlightKeywords === true
        && resolvedDesign.design.accentColor === "#00F5D4",
    );

    const v2BurnCfg = buildV2BurnConfig(
      "/renders/base.mp4",
      [{ text: "เพิ่มยอดขาย 300%", startMs: 0, endMs: 4000, tag: "body" }],
      10_000,
      { ...DEFAULT_V2_SUB, highlightKeywords: true },
      30,
      {},
      undefined,
      undefined,
      bannerHook,
    );
    check(
      "buildV2BurnConfig sets subtitleHighlightKeywords=true and headlineHook",
      v2BurnCfg.subtitleHighlightKeywords === true
        && v2BurnCfg.headlineHook?.preset === "banner",
    );

    const mcpBurnCfg = buildBurnConfig(
      "/renders/base.mp4",
      [{ text: "เพิ่มยอดขาย 300%", startMs: 0, endMs: 4000, tag: "body" }],
      10_000,
      v2SubConfigToHeroDesign(resolvedDesign.design),
      30,
      bannerHook,
    );
    check(
      "buildBurnConfig sets subtitleHighlightKeywords=true and headlineHook",
      mcpBurnCfg.subtitleHighlightKeywords === true
        && mcpBurnCfg.headlineHook?.preset === "banner"
        && mcpBurnCfg.headlineHook?.headline === "3 ความลับเพิ่มยอดขาย 300%",
    );

    // ── 4. MCP Schema, Quote, and Edit Tools Integration ─────────────────────
    const validSchema = createVideoJobInputSchema.safeParse({
      script: "สวัสดีครับ วันนี้มี 3 ความลับเพิ่มยอดขาย 300% มาฝากกัน",
      highlightKeywords: true,
      headlineHook: "3 ความลับเพิ่มยอดขาย 300%",
      headlineHookSubtext: "รู้แล้วทำตามได้ทันที",
      headlineHookStyle: "banner",
      headlineHookDurationMs: 3500,
    });
    check(
      "createVideoJobInputSchema accepts highlightKeywords + headlineHook fields",
      validSchema.success
        && validSchema.data.highlightKeywords === true
        && validSchema.data.headlineHookStyle === "banner",
    );

    const invalidHookDuration = createVideoJobInputSchema.safeParse({
      script: "สวัสดีครับ",
      headlineHook: "ฮุคสั้นเกิน",
      headlineHookDurationMs: 1000,
    });
    check(
      "createVideoJobInputSchema rejects headlineHookDurationMs < 3000",
      !invalidHookDuration.success,
    );

    check(
      "setSubtitleStyleInputShape exposes highlightKeywords boolean",
      "highlightKeywords" in setSubtitleStyleInputShape,
    );

    const quote = await prepareVideoQuote(user, {
      script: "สวัสดีครับ วันนี้มี 3 ความลับเพิ่มยอดขาย 300% มาฝากสำหรับคนทำคลิปสั้นทุกคนครับ",
      brollSource: "stock",
      bgmFile: "none",
      exportMode: "hold",
      highlightKeywords: true,
      headlineHook: "3 ความลับเพิ่มยอดขาย 300%",
      headlineHookSubtext: "ดูจบเข้าใจทันที",
      headlineHookStyle: "stat-burst",
      headlineHookDurationMs: 3500,
    });
    check("prepareVideoQuote succeeds with highlightKeywords and headlineHook", !("error" in quote));
    if (!("error" in quote)) {
      await decideVideoQuote(user.id, quote.quoteId, "approve");
      const created = await requestVideoJob(user, { quoteId: quote.quoteId }) as {
        jobId: string;
        projectId: string;
      };
      check("requestVideoJob consumes quote and creates held job", typeof created.jobId === "string");

      // Simulate completed preview output so get_edit_state & set_subtitle_style & set_headline_hook can run
      await prisma.videoJob.update({
        where: { id: created.jobId },
        data: {
          status: "done",
          progress: 100,
          outputJson: JSON.stringify({
            version: 2,
            videoUrl: "/renders/wave2-preview.mp4",
            audioDurationMs: 6000,
            preview: {
              compositeBaseUrl: "/renders/wave2-preview.mp4",
              audioDurationMs: 6000,
              captions: [
                { startMs: 0, endMs: 3000, text: "3 ความลับเพิ่มยอดขาย 300%", tag: "hook" },
                { startMs: 3000, endMs: 6000, text: "รู้แล้วทำตามได้ทันทีใน 7 วัน", tag: "body" },
              ],
              config: {
                fps: 30,
                durationInFrames: 180,
                bgVideos: [{ src: "/stocks/a.mp4", start: 0, end: 6 }],
              },
            },
          }),
        },
      });

      const state1 = await getEditStateTool(user.id, created.jobId) as {
        subtitleStyle: { highlightKeywords: boolean };
        headlineHook: { preset: string; headline: string; subheadline?: string; enabled: boolean } | null;
      };
      check(
        "get_edit_state reflects initial highlightKeywords=true and stat-burst headlineHook from create_video_job",
        state1.subtitleStyle?.highlightKeywords === true
          && state1.headlineHook?.enabled === true
          && state1.headlineHook?.preset === "stat-burst"
          && state1.headlineHook?.headline === "3 ความลับเพิ่มยอดขาย 300%",
      );

      const toggledStyle = await setSubtitleStyleTool(user.id, {
        jobId: created.jobId,
        highlightKeywords: false,
      }) as { ok?: boolean; subtitleStyle?: { highlightKeywords: boolean } };
      check(
        "set_subtitle_style can toggle highlightKeywords to false",
        toggledStyle.ok === true && toggledStyle.subtitleStyle?.highlightKeywords === false,
      );

      const updatedHook = await setHeadlineHookTool(user.id, {
        jobId: created.jobId,
        preset: "question-pill",
        headline: "ทำไมยอดขายไม่โต?",
      }) as { ok?: boolean; headlineHook?: { preset: string; headline: string } };
      check(
        "set_headline_hook accepts new question-pill preset",
        updatedHook.ok === true
          && updatedHook.headlineHook?.preset === "question-pill"
          && updatedHook.headlineHook?.headline === "ทำไมยอดขายไม่โต?",
      );
    }

    const postPhaseSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
    const postPhaseMobileSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");
    check(
      "PostPhase.tsx and PostPhaseMobile.tsx expose highlightKeywords toggle",
      postPhaseSrc.includes('ed.set("highlightKeywords"') && postPhaseMobileSrc.includes('ed.set("highlightKeywords"'),
    );

    console.log(`verify-mcp-wave2-backlog: ${passed} assertions passed`);
  } finally {
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
