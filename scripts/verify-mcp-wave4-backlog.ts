import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPresenterStitchFfmpegFilter,
  computeStitchedDurationMs,
  MAX_STITCH_CLIPS,
} from "@/lib/presenter-stitch";
import {
  probeClipInfoViaFfmpeg,
  stitchPresenterVideoFiles,
} from "@/lib/presenter-stitch.server";
import { createVideoJobInputSchema } from "@/lib/mcp/create-video-input";

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  passed += 1;
}

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(
    process.cwd(),
    "node_modules",
    "@ffmpeg-installer",
    `${process.platform}-${process.arch}`,
    `ffmpeg${ext}`,
  );
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), args, { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg synth failed: ${err.message} ${String(stderr || "").slice(-300)}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave4-backlog-"));
  const dbPath = path.join(tmp, "wave4.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const { prisma } = await import("@/lib/prisma");
  const {
    clipFieldsRequested,
    parseClipJobArgs,
    settleClipImportJob,
    startClipImport,
  } = await import("@/lib/mcp/clip-video-job");
  const { decideVideoQuote, prepareVideoQuote } = await import("@/lib/mcp/video-quote.server");
  const { requestVideoJob } = await import("@/lib/mcp/video-budget.server");

  // ── 1. Pure Multi-Clip Stitch Duration & Cut-Time Planning ────────────────
  const singlePlan = computeStitchedDurationMs([4200]);
  assert(singlePlan.totalDurationMs === 4200, "single clip totalDurationMs === 4200");
  assert(singlePlan.totalDurationSec === 4.2, "single clip totalDurationSec === 4.2");
  assert(singlePlan.stitchCutTimesSec.length === 0, "single clip has 0 stitch cuts");

  const multiPlan = computeStitchedDurationMs([3200, 4800, 2500]);
  assert(multiPlan.totalDurationMs === 10500, "3-clip stitched durationMs === 10500");
  assert(multiPlan.totalDurationSec === 10.5, "3-clip stitched durationSec === 10.5");
  assert(
    JSON.stringify(multiPlan.stitchCutTimesSec) === JSON.stringify([3.2, 8]),
    `3-clip stitchCutTimesSec expected [3.2, 8], got ${JSON.stringify(multiPlan.stitchCutTimesSec)}`,
  );

  // ── 2. Pure FFmpeg Filter Graph Generation ────────────────────────────────
  const filter3 = buildPresenterStitchFfmpegFilter([
    { durationSec: 3.2, hasAudio: true },
    { durationSec: 4.8, hasAudio: false },
    { durationSec: 2.5, hasAudio: true },
  ]);
  assert(
    filter3.includes("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p"),
    "filter normalizes each video stream to 1080x1920 @ 30fps yuv420p",
  );
  assert(
    filter3.includes("afade=t=out:st=3.188:d=0.012"),
    "first clip has 12ms audio fade-out at tail",
  );
  assert(
    filter3.includes("anullsrc=r=48000:cl=stereo,atrim=0:4.8"),
    "clip without audio gets synthesized stereo silence matching its duration",
  );
  assert(
    filter3.includes("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][aout]"),
    "filter concatenates all 3 normalized video+audio streams",
  );

  // ── 3. Real FFmpeg Multi-Clip Presenter Stitch ────────────────────────────
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const clipAName = `presenter-import-${Date.now()}-11111111-1111-4111-8111-111111111111.mp4`;
  const clipBName = `presenter-import-${Date.now()}-22222222-2222-4222-8222-222222222222.mp4`;
  const clipAPath = path.join(rendersDir, clipAName);
  const clipBPath = path.join(rendersDir, clipBName);
  const cleanupPaths: string[] = [clipAPath, clipBPath];

  try {
    // Synthesize Clip A: 720x1280 @ 24fps, 1.2s with 440Hz sine wave
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=720x1280:r=24:d=1.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=1.2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      clipAPath,
    ]);

    // Synthesize Clip B: 1080x1920 @ 30fps, 1.5s with 660Hz sine wave
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=teal:s=1080x1920:r=30:d=1.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000:duration=1.5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      clipBPath,
    ]);

    const stitched = await stitchPresenterVideoFiles({
      clipUrls: [`/api/renders/${clipAName}`, `/api/renders/${clipBName}`],
    });
    const stitchedAbsPath = path.join(
      rendersDir,
      path.basename(stitched.clipUrl),
    );
    cleanupPaths.push(stitchedAbsPath);

    assert(stitched.stitched === true, "stitchPresenterVideoFiles marks stitched=true for 2 clips");
    assert(stitched.clipCount === 2, "stitchPresenterVideoFiles reports clipCount=2");
    assert(
      stitched.stitchCutTimesSec.length === 1 &&
        Math.abs(stitched.stitchCutTimesSec[0]! - 1.2) <= 0.15,
      `stitchCutTimesSec[0] near 1.2s, got ${JSON.stringify(stitched.stitchCutTimesSec)}`,
    );

    const probed = await probeClipInfoViaFfmpeg(stitchedAbsPath);
    assert(probed.width === 1080 && probed.height === 1920, `stitched output normalized to 1080x1920, got ${probed.width}x${probed.height}`);
    assert(probed.hasAudio === true, "stitched output has audio track");
    assert(
      Math.abs(probed.durationSec - 2.7) <= 0.25,
      `stitched output duration ~2.7s, got ${probed.durationSec}s`,
    );

    // ── 4. MCP Input Schema & parseClipJobArgs Validation ─────────────────────
    assert(
      clipFieldsRequested({ clipUrls: ["https://example.com/a.mp4"] }) === true,
      "clipFieldsRequested detects clipUrls",
    );
    assert(
      clipFieldsRequested({ clipUploadIds: ["imp_1", "imp_2"] }) === true,
      "clipFieldsRequested detects clipUploadIds",
    );

    const schemaOk = createVideoJobInputSchema.safeParse({
      clipUploadIds: ["imp_1", "imp_2"],
      tighten: true,
      punchZoom: true,
    });
    assert(schemaOk.success === true, "createVideoJobInputSchema accepts clipUploadIds");

    const schemaTooMany = createVideoJobInputSchema.safeParse({
      clipUploadIds: Array.from({ length: MAX_STITCH_CLIPS + 1 }, (_, i) => `imp_${i}`),
    });
    assert(schemaTooMany.success === false, "createVideoJobInputSchema rejects >10 clipUploadIds");

    const parsedMultiUrls = parseClipJobArgs({
      clipUrls: ["https://example.com/take1.mp4", "https://example.com/take2.mp4"],
      cutawayLayout: "auto",
    });
    assert(
      parsedMultiUrls.ok === true &&
        parsedMultiUrls.clip?.source.kind === "url" &&
        parsedMultiUrls.clip.source.urls?.length === 2,
      "parseClipJobArgs parses 2 https clipUrls",
    );

    const parsedMultiUploads = parseClipJobArgs({
      clipUploadIds: ["up_1", "up_2", "up_3"],
    });
    assert(
      parsedMultiUploads.ok === true &&
        parsedMultiUploads.clip?.source.kind === "upload" &&
        parsedMultiUploads.clip.source.ids?.length === 3,
      "parseClipJobArgs parses 3 clipUploadIds",
    );

    const parsedConflict = parseClipJobArgs({
      clipUrl: "https://example.com/take1.mp4",
      clipUrls: ["https://example.com/take1.mp4", "https://example.com/take2.mp4"],
    });
    assert(
      parsedConflict.ok === false && parsedConflict.failure.code === "invalid_input",
      "parseClipJobArgs refuses clipUrl + clipUrls together",
    );

    const parsedHttp = parseClipJobArgs({
      clipUrls: ["https://example.com/take1.mp4", "http://example.com/take2.mp4"],
    });
    assert(
      parsedHttp.ok === false && parsedHttp.failure.code === "url_not_https",
      "parseClipJobArgs refuses non-https URL inside clipUrls",
    );

    // ── 5. End-to-End Multi-Clip Quote, Job Creation & Settle ─────────────────
    const now = new Date();
    const email = `wave4-stitch-${Date.now()}@heroai.test`;
    const user = await prisma.user.create({
      data: {
        clerkId: `clerk_wave4_${Date.now()}`,
        email,
        name: "Wave 4 Stitch Tester",
        plan: "PRO",
        minutesLimit: 80,
        minutesUsed: 0,
        usagePeriodStartedAt: now,
        trialEndsAt: null,
        usageLimit: 100,
        usageCount: 0,
        subStatus: "active",
        stripeSubscriptionId: `sub_wave4_${Date.now()}`,
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: user.id,
        stripeSessionId: `cs_wave4_${Date.now()}`,
        plan: "PRO",
        amount: 59_900,
        status: "PAID",
        periodDays: 30,
        paidAt: now,
      },
    });

    try {
      const impA = await prisma.mediaImport.create({
        data: {
          userId: user.id,
          source: "upload",
          purpose: "presenter",
          status: "ready",
          durationMs: 4000,
          resultSrc: `/api/renders/${clipAName}`,
          deadlineAt: new Date(Date.now() + 3600_000),
        },
      });
      const impB = await prisma.mediaImport.create({
        data: {
          userId: user.id,
          source: "upload",
          purpose: "presenter",
          status: "ready",
          durationMs: 6000,
          resultSrc: `/api/renders/${clipBName}`,
          deadlineAt: new Date(Date.now() + 3600_000),
        },
      });

      const started = await startClipImport(user.id, {
        kind: "upload",
        id: impA.id,
        ids: [impA.id, impB.id],
      });
      assert(
        started.ok === true &&
          started.started.importIds?.length === 2 &&
          started.started.importIds[0] === impA.id &&
          started.started.importIds[1] === impB.id,
        "startClipImport resolves multi-upload presenter imports in order",
      );

      const quote = await prepareVideoQuote(user, {
        clipUploadIds: [impA.id, impB.id],
        tighten: true,
        tightenSpeed: 1.25,
        punchZoom: true,
        bgmFile: "none",
      });
      assert("quoteId" in quote, `prepareVideoQuote succeeded for clipUploadIds, got ${JSON.stringify(quote)}`);
      assert(
        quote.durationSeconds === 8 && quote.exactDuration === true,
        `stitched 10s tightened at 1.25x quotes 8s exactDuration, got ${quote.durationSeconds}s`,
      );

      const approved = await decideVideoQuote(user.id, quote.quoteId, "approve");
      assert("status" in approved && approved.status === "approved", "multi-clip quote approved");

      const created = await requestVideoJob(user, { quoteId: quote.quoteId });
      assert("jobId" in created && typeof created.jobId === "string", "requestVideoJob created multi-clip job");

      const jobRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } });
      const jobInput = JSON.parse(jobRow.inputJson) as Record<string, unknown>;
      assert(jobInput.mode === "upload", "jobInput.mode === 'upload'");
      assert(
        JSON.stringify(jobInput.clipImportIds) === JSON.stringify([impA.id, impB.id]),
        "jobInput.clipImportIds preserves [impA.id, impB.id]",
      );
      assert(
        JSON.stringify(jobInput.clipUrls) ===
          JSON.stringify([`/api/renders/${clipAName}`, `/api/renders/${clipBName}`]),
        "jobInput.clipUrls preserves both presenter resultSrc paths",
      );
      assert(jobInput.tighten === true && jobInput.punchZoom === true, "jobInput preserves tighten + punchZoom");

      // Verify settleClipImportJob on a waiting_import multi-clip job
      const waitingJob = await prisma.videoJob.create({
        data: {
          userId: user.id,
          type: "create",
          status: "waiting_import",
          inputJson: JSON.stringify({
            mode: "upload",
            clipImportId: impA.id,
            clipImportIds: [impA.id, impB.id],
          }),
        },
      });
      const settledOutcome = await settleClipImportJob(waitingJob.id, user.id);
      assert(settledOutcome === "queued", `settleClipImportJob moved multi-clip job to queued, got ${settledOutcome}`);
      const settledRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: waitingJob.id } });
      const settledInput = JSON.parse(settledRow.inputJson) as Record<string, unknown>;
      assert(
        JSON.stringify(settledInput.clipUrls) ===
          JSON.stringify([`/api/renders/${clipAName}`, `/api/renders/${clipBName}`]),
        "settleClipImportJob populates allowlisted clipUrls array",
      );
    } finally {
      await prisma.videoJob.deleteMany({ where: { userId: user.id } });
      await prisma.mcpVideoQuote.deleteMany({ where: { userId: user.id } });
      await prisma.editorProject.deleteMany({ where: { userId: user.id } });
      await prisma.mediaImport.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  } finally {
    for (const p of cleanupPaths) {
      fs.rmSync(p, { force: true });
    }
  }

  console.log(`verify-mcp-wave4-backlog passed (${passed} assertions)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
