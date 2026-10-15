/**
 * Verification suite for EP5/S2 Studio Backlog Wave 1:
 *   - #16 Batch Upload URLs (`count: 1..20` on `create_upload_url`)
 *   - #4  Presenter Auto Punch-In Zoom (`punchZoom` on presenter video layer)
 *   - #17 TTS Pace & Length Target (`ttsSpeed`, `targetDurationSec` + Thai warning)
 *   - #1  Tighten Presenter Pace (`tighten`, `tightenMaxGapMs`, `tightenSpeed`)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave1-backlog-"));
  const dbPath = path.join(tmp, "wave1.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  const { createUploadUrlTool, createUploadUrlInputShape } = await import("../src/lib/mcp/media-import-tools");
  const { MAX_BATCH_UPLOAD_LINKS } = await import("../src/lib/media-import/imports");
  const {
    PUNCH_ZOOM_ORIGIN,
    PUNCH_ZOOM_SCALE,
    effectivePunchZoom,
    isPunchZoomActiveAtTime,
    planPunchZoomIntervals,
  } = await import("../src/lib/presenter-punch-zoom");
  const { buildCutawayCompositeFilter } = await import("../src/lib/cutaway-composite");
  const {
    estimatePacedDurationSeconds,
    isValidTargetDurationSec,
    isValidTtsSpeed,
    resolveEffectiveTtsSpeed,
    scaleTtsTiming,
  } = await import("../src/lib/tts-pace");
  const {
    TIGHTEN_DEFAULT_MAX_GAP_MS,
    TIGHTEN_DEFAULT_SPEED,
    TIGHTEN_RESIDUAL_SILENCE_MS,
    isValidTightenMaxGapMs,
    isValidTightenSpeed,
    parseFfmpegSilenceDetectIntervals,
    planTightenKeepSegments,
    resolveTightenOptions,
  } = await import("../src/lib/presenter-tighten");
  const { buildTightenFfmpegFilter } = await import("../src/lib/presenter-tighten.server");
  const { createVideoJobInputSchema } = await import("../src/lib/mcp/create-video-input");
  const { clipFieldsRequested, parseClipJobArgs } = await import("../src/lib/mcp/clip-video-job");
  const { prepareVideoQuote } = await import("../src/lib/mcp/video-quote.server");
  const { draftHasBrollChanges } = await import("../src/lib/mcp/pending-edit-draft");

  try {
    let passed = 0;
    const check = (label: string, cond: boolean) => {
      assert.ok(cond, label);
      passed += 1;
    };

    const now = new Date();
    const user = await prisma.user.create({
      data: {
        id: "user-wave1",
        name: "Wave 1 Tester",
        email: "wave1@aoacademy.co",
        plan: "PRO",
        minutesLimit: 80,
        minutesUsed: 0,
        usagePeriodStartedAt: now,
        trialEndsAt: null,
        usageLimit: 100,
        usageCount: 0,
        subStatus: "active",
        stripeSubscriptionId: "sub_wave1",
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: "user-wave1",
        stripeSessionId: "cs_wave1",
        plan: "PRO",
        amount: 59_900,
        status: "PAID",
        periodDays: 30,
        paidAt: now,
      },
    });
    await prisma.music.create({
      data: {
        id: "music-wave1",
        title: "Wave 1 Beat",
        filename: "wave1-beat.mp3",
      },
    });

    // ── 1. #16 Batch Upload URLs (`create_upload_url` with `count`) ───────────
    check("MAX_BATCH_UPLOAD_LINKS is 20", MAX_BATCH_UPLOAD_LINKS === 20);
    check("createUploadUrlInputShape exposes optional flat count", "count" in createUploadUrlInputShape);

    const singleRes = await createUploadUrlTool("user-wave1", { kind: "video" }) as Record<string, unknown>;
    check("single upload call returns uploadId", typeof singleRes.uploadId === "string" && singleRes.uploadId.length > 0);
    check(
      "single upload call omits batch uploads array for backward compatibility",
      !("uploads" in singleRes) && !("count" in singleRes),
    );

    const batchRes = await createUploadUrlTool("user-wave1", { kind: "video", count: 3 }) as {
      uploadId: string;
      uploadUrl: string;
      count: number;
      uploads: Array<{ uploadId: string; uploadUrl: string }>;
    };
    check("batch upload call returns count=3", batchRes.count === 3);
    check("batch upload call returns 3 uploads", Array.isArray(batchRes.uploads) && batchRes.uploads.length === 3);
    check("batch upload top-level uploadId matches first item", batchRes.uploadId === batchRes.uploads[0].uploadId);
    check(
      "batch upload URLs use tokenized /api/mcp-uploads/:token path",
      batchRes.uploads[2].uploadUrl.startsWith("https://studio.test/api/mcp-uploads/"),
    );
    check(
      "all 3 batch upload IDs are distinct",
      new Set(batchRes.uploads.map((u) => u.uploadId)).size === 3,
    );

    for (const invalidCount of [0, 21, -2, 2.5]) {
      const badBatch = await createUploadUrlTool("user-wave1", { kind: "video", count: invalidCount }) as {
        error?: string;
        code?: string;
      };
      check(
        `invalid count ${String(invalidCount)} returns invalid_input`,
        badBatch.error === "invalid_input" && badBatch.code === "invalid_input",
      );
    }

    // ── 2. #4 Presenter Auto Punch-In Zoom (`punchZoom`) ─────────────────────
    check("PUNCH_ZOOM_SCALE is 1.15", PUNCH_ZOOM_SCALE === 1.15);
    check("PUNCH_ZOOM_ORIGIN is upper-center 50% 38%", PUNCH_ZOOM_ORIGIN === "50% 38%");

    const jumpIntervals = planPunchZoomIntervals(
      [{ start: 0, end: 12 }],
      [3, 6.5, 9.5],
    );
    check(
      "jump-cut cues alternate normal [0..3], zoom [3..6.5], normal [6.5..9.5], zoom [9.5..12]",
      jumpIntervals.length === 2
        && jumpIntervals[0].start === 3
        && jumpIntervals[0].end === 6.5
        && jumpIntervals[1].start === 9.5
        && jumpIntervals[1].end === 12,
    );
    check("isPunchZoomActiveAtTime is false at 1.5s", !isPunchZoomActiveAtTime(jumpIntervals, 1.5));
    check("isPunchZoomActiveAtTime is true at 4.0s", isPunchZoomActiveAtTime(jumpIntervals, 4.0));

    const cutawayIntervals = planPunchZoomIntervals([
      { start: 0, end: 3 },
      { start: 6, end: 10 },
      { start: 13, end: 18 },
    ]);
    check(
      "cutaway presenter spans alternate normal on span 0 [0..3] and zoomed on span 1 [6..10]",
      cutawayIntervals.length === 1
        && cutawayIntervals[0].start === 6
        && cutawayIntervals[0].end === 10,
    );

    const filterDefault = buildCutawayCompositeFilter([{ start: 0, end: 3 }]);
    check(
      "buildCutawayCompositeFilter without punchZoom keeps legacy 3-part filter",
      filterDefault !== null && filterDefault.split(";").length === 3 && !filterDefault.includes("fg_zoom"),
    );
    const filterPunch = buildCutawayCompositeFilter(
      [
        { start: 0, end: 3 },
        { start: 6, end: 10 },
      ],
      {
        punchZoom: true,
        cueTimesSec: [1.5],
      },
    );
    check(
      "buildCutawayCompositeFilter with punchZoom scales presenter with 1242x2208 and upper-center crop",
      filterPunch !== null
        && filterPunch.includes("scale=1242:2208:flags=lanczos,crop=1080:1920:81:109")
        && filterPunch.includes("[fg_zoom]"),
    );

    check(
      "draftHasBrollChanges detects punchZoom on PendingEditDraft",
      draftHasBrollChanges({ windowEdits: [], punchZoom: true }) && !draftHasBrollChanges({ windowEdits: [] }),
    );
    check("effectivePunchZoom returns true only for boolean true", effectivePunchZoom(true) === true && effectivePunchZoom(false) === false);

    // ── 3. #17 TTS Pace & Length Target (`ttsSpeed` & `targetDurationSec`) ───
    check("isValidTtsSpeed accepts 0.85..1.25", isValidTtsSpeed(0.85) && isValidTtsSpeed(1.25));
    check("isValidTtsSpeed rejects 0.8 and 1.3", !isValidTtsSpeed(0.8) && !isValidTtsSpeed(1.3));
    check("isValidTargetDurationSec accepts 5..600", isValidTargetDurationSec(5) && isValidTargetDurationSec(600));
    check("isValidTargetDurationSec rejects 4 and 601", !isValidTargetDurationSec(4) && !isValidTargetDurationSec(601));

    const explicitSpeed = resolveEffectiveTtsSpeed({
      naturalDurationSec: 36,
      ttsSpeed: 1.15,
    });
    check(
      "explicit ttsSpeed resolves exact effectiveSpeed without warning",
      explicitSpeed.effectiveSpeed === 1.15 && explicitSpeed.clamped === false && explicitSpeed.warning === undefined,
    );

    const naturalTarget = resolveEffectiveTtsSpeed({
      naturalDurationSec: 33,
      targetDurationSec: 30,
    });
    check(
      "targetDurationSec within 0.85x..1.20x computes exact speed without warning",
      naturalTarget.effectiveSpeed === 1.1 && naturalTarget.clamped === false && naturalTarget.warning === undefined,
    );

    const clampedFastTarget = resolveEffectiveTtsSpeed({
      naturalDurationSec: 45,
      targetDurationSec: 30,
    });
    check(
      "targetDurationSec requiring >1.20x clamps to 1.20x and emits Thai warning",
      clampedFastTarget.effectiveSpeed === 1.2
        && clampedFastTarget.clamped === true
        && Boolean(clampedFastTarget.warning?.includes("1.20x")),
    );

    const scaledTiming = scaleTtsTiming(
      [
        { text: "สวัสดีครับ", startMs: 0, endMs: 1200 },
        { text: "วันนี้มาดูกัน", startMs: 1200, endMs: 2400 },
      ],
      1.2,
    );
    check(
      "scaleTtsTiming scales timestamps inversely with speed",
      scaledTiming !== undefined
        && scaledTiming[0].endMs === 1000
        && scaledTiming[1].startMs === 1000
        && scaledTiming[1].endMs === 2000,
    );
    const pacedEst = estimatePacedDurationSeconds(36, { ttsSpeed: 1.2 });
    check(
      "estimatePacedDurationSeconds scales estimated duration",
      Math.abs(pacedEst.durationSeconds - 30) < 0.01 && pacedEst.effectiveSpeed === 1.2,
    );

    const validScriptSchema = createVideoJobInputSchema.safeParse({
      script: "สวัสดีครับ วันนี้มีเทคนิคดีๆ มาฝากกัน",
      ttsSpeed: 1.15,
      targetDurationSec: 30,
      punchZoom: true,
    });
    check(
      "createVideoJobInputSchema accepts ttsSpeed + targetDurationSec + punchZoom on script mode",
      validScriptSchema.success
        && validScriptSchema.data.ttsSpeed === 1.15
        && validScriptSchema.data.targetDurationSec === 30
        && validScriptSchema.data.punchZoom === true,
    );

    const invalidSpeedSchema = createVideoJobInputSchema.safeParse({
      script: "สวัสดีครับ",
      ttsSpeed: 1.5,
    });
    check("createVideoJobInputSchema rejects ttsSpeed > 1.25", !invalidSpeedSchema.success);

    const invalidTargetSchema = createVideoJobInputSchema.safeParse({
      script: "สวัสดีครับ",
      targetDurationSec: 3,
    });
    check("createVideoJobInputSchema rejects targetDurationSec < 5", !invalidTargetSchema.success);

    const speedInClipMode = parseClipJobArgs({
      clipUrl: "https://example.com/presenter.mp4",
      ttsSpeed: 1.1,
    });
    check(
      "parseClipJobArgs rejects ttsSpeed on clipUrl mode with invalid_input",
      !speedInClipMode.ok && speedInClipMode.failure.code === "invalid_input",
    );

    // ── 4. #1 Tighten Presenter Pace (`tighten`, `tightenMaxGapMs`, `tightenSpeed`) ─
    check("TIGHTEN_DEFAULT_MAX_GAP_MS is 400", TIGHTEN_DEFAULT_MAX_GAP_MS === 400);
    check("TIGHTEN_RESIDUAL_SILENCE_MS is 100", TIGHTEN_RESIDUAL_SILENCE_MS === 100);
    check("TIGHTEN_DEFAULT_SPEED is 1.1", TIGHTEN_DEFAULT_SPEED === 1.1);
    check("isValidTightenMaxGapMs accepts 250..2000", isValidTightenMaxGapMs(250) && isValidTightenMaxGapMs(2000));
    check("isValidTightenMaxGapMs rejects 200 and 2500", !isValidTightenMaxGapMs(200) && !isValidTightenMaxGapMs(2500));
    check("isValidTightenSpeed accepts 1.0..1.25", isValidTightenSpeed(1.0) && isValidTightenSpeed(1.25));
    check("isValidTightenSpeed rejects 0.95 and 1.3", !isValidTightenSpeed(0.95) && !isValidTightenSpeed(1.3));

    const presetTighten = resolveTightenOptions({ tighten: true });
    check(
      "resolveTightenOptions(tighten: true) resolves 400ms maxGap, 100ms residual, 1.10x speed",
      presetTighten.enabled
        && presetTighten.maxGapMs === 400
        && presetTighten.residualGapMs === 100
        && presetTighten.speed === 1.1,
    );

    const customTighten = resolveTightenOptions({ tightenMaxGapMs: 500, tightenSpeed: 1.15 });
    check(
      "resolveTightenOptions enables automatically when custom tightenMaxGapMs/tightenSpeed is set",
      customTighten.enabled && customTighten.maxGapMs === 500 && customTighten.speed === 1.15,
    );

    const logSample = [
      "[silencedetect @ 0x1] silence_start: 1.200",
      "[silencedetect @ 0x1] silence_end: 2.000 | silence_duration: 0.800",
      "[silencedetect @ 0x1] silence_start: 4.500",
      "[silencedetect @ 0x1] silence_end: 5.100 | silence_duration: 0.600",
    ].join("\n");
    const silences = parseFfmpegSilenceDetectIntervals(logSample, 8);
    check("parseFfmpegSilenceDetectIntervals parses 2 silence intervals", silences.length === 2);

    const tightenPlan = planTightenKeepSegments({
      durationSec: 8,
      silences,
      maxGapMs: presetTighten.maxGapMs,
      residualGapMs: presetTighten.residualGapMs,
      crossfadeMs: presetTighten.crossfadeMs,
      speed: presetTighten.speed,
    });
    check(
      "planTightenKeepSegments cuts 2 silences into 3 speech segments and computes jumpCutTimesSec",
      tightenPlan.trimmedSilenceMs > 0
        && tightenPlan.segments.length === 3
        && tightenPlan.jumpCutTimesSec.length === 2
        && tightenPlan.estimatedOutputDurationSec < 8,
    );

    const tightenFilter = buildTightenFfmpegFilter(tightenPlan, presetTighten.speed);
    check(
      "buildTightenFfmpegFilter generates synchronized trim/atrim + afade + concat + setpts/atempo",
      tightenFilter.includes("concat=n=3:v=1:a=1")
        && tightenFilter.includes("afade=t=in")
        && tightenFilter.includes("afade=t=out")
        && tightenFilter.includes("setpts=PTS/1.1")
        && tightenFilter.includes("atempo=1.1"),
    );

    const tightenOnScript = parseClipJobArgs({
      script: "สวัสดีครับ",
      tighten: true,
    });
    check(
      "parseClipJobArgs rejects tighten on script mode with invalid_input",
      !tightenOnScript.ok && tightenOnScript.failure.code === "invalid_input",
    );
    check(
      "clipFieldsRequested detects tighten fields",
      clipFieldsRequested({ tighten: true }) && clipFieldsRequested({ tightenSpeed: 1.15 }),
    );

    // ── 5. Quote & Web Editor v2 Wiring Checks ───────────────────────────────
    const normalQuote = await prepareVideoQuote(user, {
      script: "สวัสดีครับ วันนี้มาพบกับเทคนิคการทำคลิปสั้นให้คนดูจบและยอดวิวพุ่งแบบมืออาชีพกันครับ",
      brollSource: "stock",
      bgmFile: "none",
    });
    const fastQuote = await prepareVideoQuote(user, {
      script: "สวัสดีครับ วันนี้มาพบกับเทคนิคการทำคลิปสั้นให้คนดูจบและยอดวิวพุ่งแบบมืออาชีพกันครับ",
      ttsSpeed: 1.25,
      brollSource: "stock",
      bgmFile: "none",
    });
    const clampedQuote = await prepareVideoQuote(user, {
      script: "สวัสดีครับ วันนี้มาพบกับเทคนิคการทำคลิปสั้นให้คนดูจบและยอดวิวพุ่งแบบมืออาชีพกันครับ สำหรับคนที่อยากปั้นช่องให้โตไวในปีนี้",
      targetDurationSec: 5,
      brollSource: "stock",
      bgmFile: "none",
    });
    check(
      "prepareVideoQuote scales durationSeconds when ttsSpeed is faster",
      !("error" in normalQuote)
        && !("error" in fastQuote)
        && fastQuote.durationSeconds < normalQuote.durationSeconds,
    );
    check(
      "prepareVideoQuote attaches Thai warnings[] when targetDurationSec clamps speed",
      !("error" in clampedQuote)
        && Array.isArray(clampedQuote.warnings)
        && clampedQuote.warnings.length === 1
        && clampedQuote.warnings[0].includes("1.20x"),
    );

    const jobsRouteSrc = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
    check("jobs/route.ts validates ttsSpeed and targetDurationSec", jobsRouteSrc.includes("TTS_SPEED_MIN") && jobsRouteSrc.includes("TARGET_DURATION_SEC_MIN"));
    check("jobs/route.ts validates tighten parameters", jobsRouteSrc.includes("TIGHTEN_MIN_MAX_GAP_MS") && jobsRouteSrc.includes("TIGHTEN_MIN_SPEED"));
    check("jobs/route.ts forwards punchZoom to createVideoJob and enqueueBrollRerender", jobsRouteSrc.includes("punchZoom"));

    const step1Src = readFileSync("src/app/(dashboard)/video-editor/_v2/Step1Script.tsx", "utf8");
    check("Step1Script.tsx exposes tighten and punchZoom toggles in upload mode", step1Src.includes("p.setTighten") && step1Src.includes("p.setPunchZoom"));

    const step2Src = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
    check("Step2Elements.tsx exposes TTS speed selector", step2Src.includes("p.setTtsSpeed"));

    console.log(`verify-mcp-wave1-backlog: ${passed} assertions passed`);
  } finally {
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
