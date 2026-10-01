// verify-mcp-chain-export.ts — T8 (ADR 0063): Agent-created Project, Preview and a
// server-chained Export.
//
// Plan: docs/plans/2026-10-01-mcp-upgrade-p0-p1.md (T8). With the MCP Editor Project flag on,
// create_video_job opens an EditorProject (draft {createdVia:"mcp"}) and queues a Preview
// Mode job marked `mcpChainExport`. When — and only when — that preview finishes, the server
// enqueues ONE `mode:"export"` job keyed `mcp-chain:<previewJobId>` whose overlay and
// editorSnapshot come from the persisted resolved subtitle design and the preview captions.
// The burn reuses the preview's paid base (isBurnAlreadyPaid): exactly one active charge
// across the whole chain. get_video_status reports the chain as one job.
//
// Self-contained: always builds its own throwaway SQLite, even when DATABASE_URL is preset.
// Providers are stubbed; the stub /api/videos/render mirrors the real route's charge rule
// (a base render reserves + records a ChargedClip, a burn of a paid base is free) and the
// stub composite records a ChargedClip for its output exactly like /api/heygen/composite.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-chain-export.ts

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mcp-chain-export-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
]) delete process.env[key];
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const rendersRoot = join(dir, "renders");
mkdirSync(rendersRoot, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const SCRIPT = "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน เนื้อบางเบามาก ซึมไวสุดๆ";
const TIMING = {
  provider: "gemini",
  segments: [
    { text: "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน ", startMs: 0, durationMs: 2600 },
    { text: "เนื้อบางเบามาก ซึมไวสุดๆ", startMs: 2600, durationMs: 2400 },
  ],
};

type StubOptions = { failBaseRender?: boolean; failBurn?: boolean };
let renderSeq = 0;
let gallerySeq = 0;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { createVideoJob, finishJobWithTransition, parseVideoJobOutput, deriveFailedJobFields } =
    await import("../src/lib/mcp/video-job");
  const { getVideoJobStatusTool } = await import("../src/lib/mcp/tools");
  const { isBurnAlreadyPaid, recordChargedClip } = await import("../src/lib/clip-charge");
  const { refundVideoJobTerminalRenderReservations } = await import("../src/lib/render/reservation-settlement");
  const { getEditorProjectWithMediaState } = await import("../src/lib/editor-projects");
  const { sweepStalledVideoJobs } = await import("../src/lib/mcp/video-job-watchdog");
  const { restorePostExportEditorState } = await import("../src/app/(dashboard)/video-editor/_v2/export-edit-state");
  const { DEFAULT_V2_SUB } = await import("../src/app/(dashboard)/video-editor/_v2/subtitle-style");
  const { buildBurnConfig, v2SubConfigToHeroDesign, RENDER_FPS } = await import("../src/lib/mcp/orchestrator-steps");
  const chain = await import("../src/lib/mcp/chain-export");
  const billing = await import("../src/lib/mcp/billing-receipt");

  const now = new Date();
  async function makeUser(id: string, email: string) {
    await prisma.user.create({
      data: {
        id, name: id, email,
        plan: "PRO", minutesLimit: 80, minutesUsed: 0,
        usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
        geminiVoiceName: "Aoede", geminiKey: "g", pexelsKey: "p",
        subStatus: "active",
        stripeSubscriptionId: `sub_${id}`,
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900,
        status: "PAID", periodDays: 30, paidAt: now,
      },
    });
    return prisma.user.findUniqueOrThrow({ where: { id } });
  }
  const owner = await makeUser("u-chain", "chain-owner@example.com");
  const tester = await makeUser("u-tester", "qa-chain@aoacademy.co");
  const other = await makeUser("u-other", "chain-other@example.com");

  function makeCaller(userId: string, opts: StubOptions = {}) {
    const log: Array<{ method: string; path: string; body?: unknown }> = [];
    const caller = {
      async post<T>(path: string, body?: unknown): Promise<T> {
        log.push({ method: "POST", path, body });
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          return { voiceUrl: "/api/renders/chain-voice.wav", audioDurationMs: 5000, timing: TIMING } as T;
        }
        if (path === "/api/videos/split-script") return { cards: null } as T;
        if (path === "/api/videos/transcribe") {
          const requested = typeof (body as { script?: unknown })?.script === "string"
            ? String((body as { script: string }).script).trim()
            : SCRIPT;
          return {
            captions: [{ text: requested, startMs: 100, endMs: 4_800, tag: "hook" }],
            words: [{ word: requested, startMs: 100, endMs: 4_800 }],
            fullText: requested,
            audioDurationMs: 5_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_800 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["sunscreen"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [5], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "sunscreen" }] } as T;
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 150, voiceFile: "/api/renders/chain-voice.wav", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          // Mirrors /api/videos/render: a burn is free IFF it references a base this user paid for.
          const paid = isBurn && await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
          const reserve = !paid;
          const failing = isBurn ? !!opts.failBurn : !!opts.failBaseRender;
          await prisma.renderJob.create({
            data: {
              id, userId, parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER",
              status: failing ? "FAILED" : "DONE",
              payload: "{}", videoUrl: failing ? null : videoUrl,
              reservedQuota: reserve, reservedMinutes: reserve ? 1 : null,
            },
          });
          if (reserve) {
            await prisma.user.update({ where: { id: userId }, data: { minutesUsed: { increment: 1 } } });
            if (!failing) await recordChargedClip(userId, videoUrl, 1);
          }
          if (!failing) writeFileSync(join(rendersRoot, `${id}-${isBurn ? "burned" : "base"}.mp4`), "x");
          return { jobId: id } as T;
        }
        if (path.startsWith("/api/videos/render-cancel")) return {} as T;
        if (path === "/api/videos") { gallerySeq += 1; return { id: `gallery-${gallerySeq}` } as T; }
        if (path === "/api/videos/trim-audio") return { audioUrl: "/api/renders/chain-intro.wav" } as T;
        if (path === "/api/heygen/generate-with-bg") return { videoId: "qa-heygen-video" } as T;
        if (path === "/api/videos/poll-avatar") {
          return { status: "completed", videoUrl: "https://avatar.example/qa.mp4", thumbnailUrl: null, errorMsg: null } as T;
        }
        if (path === "/api/heygen/composite") {
          renderSeq += 1;
          const compositeUrl = `/api/renders/composite-${renderSeq}.mp4`;
          // Mirrors /api/heygen/composite:795 — the composite output is a paid clip.
          await recordChargedClip(userId, compositeUrl);
          writeFileSync(join(rendersRoot, `composite-${renderSeq}.mp4`), "x");
          return { videoUrl: compositeUrl, usedMode: "chromakey" } as T;
        }
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(path: string, body?: unknown): Promise<T> {
        log.push({ method: "PATCH", path, body });
        return {} as T;
      },
      async get<T>(path: string): Promise<T> {
        log.push({ method: "GET", path });
        if (path.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(path)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          if (!rj || rj.status === "FAILED") {
            return { progress: -1, videoUrl: null, error: "stub render failed", stage: "error" } as T;
          }
          return { progress: 100, videoUrl: rj.videoUrl, error: null, stage: "done" } as T;
        }
        if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
        throw new Error(`stub caller: unexpected GET ${path}`);
      },
    };
    return { caller, log };
  }

  async function runJob(jobId: string, userId: string, opts: StubOptions = {}) {
    await prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ["queued", "waiting_provider"] } },
      data: { status: "processing", startedAt: new Date(), providerNextPollAt: null },
    });
    const { caller, log } = makeCaller(userId, opts);
    await runOrchestrator(jobId, userId, { caller: caller as never, sleep: async () => {} });
    return log;
  }

  const customDesign = {
    ...DEFAULT_V2_SUB,
    fontSize: 64,
    textColor: "#111111",
    accentColor: "#00FF88",
    verticalPos: 30,
  };
  const baseInput = (extra: Record<string, unknown> = {}) => ({
    script: SCRIPT,
    title: "คลิปจากเอเจนต์",
    voiceProvider: "gemini",
    subtitleDesign: customDesign,
    subtitleCardLen: "sentence",
    ...extra,
  });
  const keyFor = (previewId: string) => `mcp-chain:${previewId}`;
  // Fix round 1 (A2): the one session-authored sentence appended for an export-half FAILURE.
  const RETRY_EXPORT_SENTENCE = "งานเรนเดอร์หลักเสร็จแล้ว — เปิดลิงก์ editorUrl เพื่อสั่ง export ใหม่ได้";
  const editorUrlFor = (projectId: string | null | undefined) =>
    `https://studio.example.test/video-editor?projectId=${projectId}`;
  const chainRows = (userId: string, previewId: string) =>
    prisma.videoJob.findMany({ where: { userId, idempotencyKey: keyFor(previewId) } });
  const activeCharges = (userId: string, ids: string[]) =>
    prisma.renderJob.count({ where: { userId, parentJobId: { in: ids }, reservedQuota: true } });

  async function createChain(user: { id: string; email: string }, extra: Record<string, unknown> = {}, key?: string) {
    const result = await chain.createMcpVideoJob(user, baseInput(extra), key, { title: "คลิปจากเอเจนต์" });
    if (result.kind !== "created") throw new Error(`createMcpVideoJob refused: ${result.kind}`);
    return result;
  }

  // ── A. create: flag gate, project + preview + chain marker ────────────────────────────
  await section("A) create_video_job: flag off = PR-A, flag on = Project + Preview + chain marker", async () => {
    check("flag off for a non-tester without MCP_EDITOR_PROJECT_PUBLIC", chain.mcpEditorProjectEnabledFor(owner) === false);
    check("flag on for an internal tester (isInternalAiBetaEnabledFor)", chain.mcpEditorProjectEnabledFor(tester) === true);

    const off = await chain.createMcpVideoJob(owner, baseInput(), "off-key-1", { title: "x" });
    check("flag off: created", off.kind === "created");
    if (off.kind === "created") {
      const row = await prisma.videoJob.findUniqueOrThrow({ where: { id: off.job.id } });
      const input = JSON.parse(row.inputJson) as Record<string, unknown>;
      check("flag off: no project, no previewMode, no chain marker (PR-A byte-identical input)",
        row.projectId === null && off.projectId === null && !("previewMode" in input) && !("mcpChainExport" in input)
        && row.type === "create" && row.idempotencyKey === "off-key-1");
      check("flag off: no EditorProject was created", (await prisma.editorProject.count({ where: { userId: owner.id } })) === 0);
      await prisma.videoJob.delete({ where: { id: off.job.id } });
    }

    process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
    check("flag on for anyone with MCP_EDITOR_PROJECT_PUBLIC=1", chain.mcpEditorProjectEnabledFor(owner) === true);
    const on = await chain.createMcpVideoJob(owner, baseInput(), "on-key-1", { title: "คลิปจากเอเจนต์" });
    delete process.env.MCP_EDITOR_PROJECT_PUBLIC;
    check("flag on: created", on.kind === "created" && typeof on.projectId === "string");
    if (on.kind === "created" && on.projectId) {
      const row = await prisma.videoJob.findUniqueOrThrow({ where: { id: on.job.id } });
      const input = JSON.parse(row.inputJson) as Record<string, unknown>;
      const project = await prisma.editorProject.findUniqueOrThrow({ where: { id: on.projectId } });
      check("flag on: job is type create, linked to the project, previewMode + mcpChainExport",
        row.type === "create" && row.projectId === project.id && input.previewMode === true && input.mcpChainExport === true);
      check("flag on: resolved design persisted (T4)",
        JSON.stringify(input.subtitleDesign) === JSON.stringify(customDesign) && input.subtitleCardLen === "sentence");
      check("flag on: project title from `title`, draft {createdVia:'mcp'}, rendering, activeJobId",
        project.title === "คลิปจากเอเจนต์" && JSON.parse(project.draftJson ?? "null")?.createdVia === "mcp"
        && project.status === "rendering" && project.activeJobId === row.id && project.userId === owner.id);
      check("MCP_PROJECT_CREATED_VIA is the draft marker T9 reads", chain.MCP_PROJECT_CREATED_VIA === "mcp");

      process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
      const projectsBefore = await prisma.editorProject.count({ where: { userId: owner.id } });
      let duplicateCode: string | undefined;
      try {
        await chain.createMcpVideoJob(owner, baseInput(), "on-key-1", { title: "dup" });
      } catch (error) {
        duplicateCode = (error as { code?: string }).code;
      }
      delete process.env.MCP_EDITOR_PROJECT_PUBLIC;
      check("flag on: a duplicate idempotencyKey surfaces P2002 (route maps it to `duplicate`)", duplicateCode === "P2002");
      check("flag on: the duplicate leaves no orphan project",
        (await prisma.editorProject.count({ where: { userId: owner.id } })) === projectsBefore);
      await prisma.videoJob.delete({ where: { id: row.id } });
      await prisma.editorProject.delete({ where: { id: project.id } });
    }

    for (const flag of [false, true]) {
      if (flag) process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
      const reserved = await chain.createMcpVideoJob(owner, baseInput(), "mcp-chain:anything", { title: "x" });
      delete process.env.MCP_EDITOR_PROJECT_PUBLIC;
      check(`reserved mcp-chain: idempotencyKey is refused (flag ${flag ? "on" : "off"})`, reserved.kind === "reserved_key");
    }
    check("reserved key refusal created nothing",
      (await prisma.videoJob.count({ where: { userId: owner.id } })) === 0
      && (await prisma.editorProject.count({ where: { userId: owner.id } })) === 0);

    const routeSrc = readFileSync("src/app/api/[transport]/route.ts", "utf8");
    check("route: create_video_job goes through createMcpVideoJob",
      routeSrc.includes("createMcpVideoJob(") && !/createVideoJob\(\s*p\.userId/.test(routeSrc));
    check("route: reserved key maps to the existing duplicate copy",
      /reserved_key[\s\S]{0,200}idempotencyKey นี้ถูกใช้แล้ว/.test(routeSrc));
    const chainSrc = readFileSync("src/lib/mcp/chain-export.ts", "utf8");
    check("flag = isInternalAiBetaEnabledFor(user, MCP_EDITOR_PROJECT_PUBLIC === \"1\")",
      /isInternalAiBetaEnabledFor\(\s*user,\s*process\.env\.MCP_EDITOR_PROJECT_PUBLIC === "1"\s*\)/.test(chainSrc));
  });

  // ── B. non-avatar chain end-to-end ─────────────────────────────────────────────────────
  let bPreviewId = "";
  let bExportId = "";
  let bProjectId = "";
  await section("B) non-avatar: preview → server-chained export → one charge, status, Post reopen", async () => {
    const created = await createChain(tester, {}, "b-key");
    bPreviewId = created.job.id;
    bProjectId = created.projectId!;

    const queued = await getVideoJobStatusTool(tester.id, bPreviewId);
    check("queued preview reads as queued, progress 0", queued?.status === "queued" && queued?.progress === 0);

    await runJob(bPreviewId, tester.id);
    const preview = await prisma.videoJob.findUniqueOrThrow({ where: { id: bPreviewId } });
    check(`preview done (got ${preview.status} ${preview.errorCode ?? ""})`, preview.status === "done");
    const previewOut = parseVideoJobOutput(preview.outputJson);
    check("preview output is v2 preview mode", previewOut?.version === 2 && !!previewOut.preview);

    const rows = await chainRows(tester.id, bPreviewId);
    check(`exactly one export enqueued under mcp-chain:<previewId> (got ${rows.length})`, rows.length === 1);
    const exportRow = rows[0];
    bExportId = exportRow?.id ?? "";
    const exportInput = exportRow ? JSON.parse(exportRow.inputJson) as Record<string, unknown> : {};
    check("export row: type export, queued, mode export, sourceJobId = preview, chain marker, same project",
      exportRow?.type === "export" && exportRow.status === "queued" && exportInput.mode === "export"
      && exportInput.sourceJobId === bPreviewId && exportInput.mcpChainExport === true
      && exportRow.projectId === bProjectId);

    const captions = previewOut!.preview!.captions.map((caption, index) => ({
      ...caption,
      tag: (caption.tag === "hook" || caption.tag === "body" || caption.tag === "cta"
        ? caption.tag : (index === 0 ? "hook" : "body")) as "hook" | "body" | "cta",
    }));
    const expectedOverlay = buildBurnConfig(
      previewOut!.videoUrl!, captions, previewOut!.preview!.audioDurationMs, v2SubConfigToHeroDesign(customDesign), RENDER_FPS,
    );
    check("overlay = buildHeroSubtitleOverlayConfig(resolved design, preview captions) on the preview base",
      JSON.stringify(exportInput.subtitleOverlayConfig) === JSON.stringify(expectedOverlay),
      JSON.stringify(exportInput.subtitleOverlayConfig).slice(0, 300));
    const snapshot = exportInput.editSnapshot as Record<string, unknown> | undefined;
    check("editorSnapshot: subtitleConfig = resolved design, cardLen = resolved mode, original = preview captions",
      JSON.stringify(snapshot?.subtitleConfig) === JSON.stringify(customDesign) && snapshot?.cardLen === "sentence"
      // The snapshot contract keeps {text,startMs,endMs,tag} per card (normalizeCaptions).
      && JSON.stringify(snapshot?.originalCaptions)
        === JSON.stringify(captions.map(({ text, startMs, endMs, tag }) => ({ text, startMs, endMs, tag })))
      && snapshot?.videoUrl === previewOut!.videoUrl,
      JSON.stringify({ cfg: snapshot?.subtitleConfig, cardLen: snapshot?.cardLen, orig: snapshot?.originalCaptions, captions, url: snapshot?.videoUrl }).slice(0, 1200));

    const project = await prisma.editorProject.findUniqueOrThrow({ where: { id: bProjectId } });
    check("project points at the export (exporting)", project.activeExportJobId === bExportId && project.status === "exporting");

    const midway = await getVideoJobStatusTool(tester.id, bPreviewId);
    check(`preview done + export queued → processing, progress 85 (got ${midway?.status} ${midway?.progress})`,
      midway?.status === "processing" && midway?.progress === 85);

    const exportLog = await runJob(bExportId, tester.id);
    const exportDone = await prisma.videoJob.findUniqueOrThrow({ where: { id: bExportId } });
    check(`export done (got ${exportDone.status} ${exportDone.errorCode ?? ""} ${exportDone.errorMessage ?? ""})`, exportDone.status === "done");
    const burnCalls = exportLog.filter((call) => call.path === "/api/videos/render");
    check("export burns exactly once, linked to the export job",
      burnCalls.length === 1 && (burnCalls[0].body as { parentJobId?: string }).parentJobId === bExportId);

    const burn = await prisma.renderJob.findFirst({ where: { parentJobId: bExportId, type: "BURN" } });
    check("burn hit isBurnAlreadyPaid (no reservation of its own)", burn?.reservedQuota === false);
    check("exactly ONE active charge across the chain", (await activeCharges(tester.id, [bPreviewId, bExportId])) === 1);
    check("customer minutes charged once",
      (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed === 1);

    const receipt = await billing.getVideoJobChainBillingReceipt({ videoJobIds: [bPreviewId, bExportId], userId: tester.id });
    check("chain receipt sums both jobs → settled, one charge", receipt.status === "settled");
    const exportOut = parseVideoJobOutput(exportDone.outputJson);
    check("release gate ran on the chain: export output carries the settled chain receipt",
      exportOut?.billingReceipt?.status === "settled");

    const done = await getVideoJobStatusTool(tester.id, bPreviewId);
    check("status(preview) → done", done?.status === "done" && done?.progress === 100);
    check("status: absolute videoUrl of the burned export",
      done?.videoUrl === `https://studio.example.test${exportOut?.videoUrl}`);
    check("status: videoId of the Gallery row", typeof (done as { videoId?: unknown })?.videoId === "string"
      && (done as { videoId?: string }).videoId === exportOut?.videoId);
    check("status: absolute editorUrl via the app-origin helper",
      (done as { editorUrl?: string })?.editorUrl === `https://studio.example.test/video-editor?projectId=${bProjectId}`);
    check("status: subtitleQa + billingReceipt from the export", !!done?.subtitleQa && done?.billingReceipt?.status === "settled");
    const byExport = await getVideoJobStatusTool(tester.id, bExportId);
    check("status(export id) returns the same shape and values", JSON.stringify(byExport) === JSON.stringify(done),
      `${JSON.stringify(byExport)?.slice(0, 200)} vs ${JSON.stringify(done)?.slice(0, 200)}`);

    // Post reopen: the project loads the finished export and the editor starts from the resolved look.
    const loaded = await getEditorProjectWithMediaState(tester.id, bProjectId, { rendersRoot });
    check("project loads: exported, active export = the chain export, media available",
      loaded?.status === "exported" && loaded?.activeExportJobId === bExportId
      && loaded?.previewMediaState?.status === "available");
    const restored = restorePostExportEditorState({ output: exportOut } as never, null);
    check("Post reopen: a done job with preview data",
      restored?.phase === "done" && restored.jobId === bPreviewId && (restored.output?.preview?.captions?.length ?? 0) > 0
      && restored.output?.videoUrl === previewOut!.videoUrl);
    check("Post reopen: initial subtitle config = resolved design, card length = resolved mode",
      JSON.stringify(restored?.output?.editSnapshot?.subtitleConfig) === JSON.stringify(customDesign)
      && restored?.output?.editSnapshot?.cardLen === "sentence");
  });

  // ── C. avatar chain (provider wait → resume site) ──────────────────────────────────────
  await section("C) avatar: the resume-site preview finish chains the export; still one charge", async () => {
    const created = await createChain(tester, { avatarMode: "full", avatarId: "qa-avatar" }, "c-key");
    await runJob(created.job.id, tester.id);
    const parked = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.job.id } });
    check(`avatar preview parks at the provider (got ${parked.status})`, parked.status === "waiting_provider");
    const waiting = await getVideoJobStatusTool(tester.id, created.job.id);
    check("waiting preview → processing, progress ≤ 85",
      waiting?.status === "processing" && (waiting?.progress ?? 999) <= 85);
    check("no export while the preview waits", (await chainRows(tester.id, created.job.id)).length === 0);

    await runJob(created.job.id, tester.id);
    const preview = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.job.id } });
    check(`avatar preview done after resume (got ${preview.status} ${preview.errorMessage ?? ""})`, preview.status === "done");
    const rows = await chainRows(tester.id, created.job.id);
    check("resume site enqueued exactly one export", rows.length === 1);
    if (rows[0]) {
      await runJob(rows[0].id, tester.id);
      const exportDone = await prisma.videoJob.findUniqueOrThrow({ where: { id: rows[0].id } });
      check(`avatar export done (got ${exportDone.status} ${exportDone.errorMessage ?? ""})`, exportDone.status === "done");
      const burn = await prisma.renderJob.findFirst({ where: { parentJobId: rows[0].id, type: "BURN" } });
      check("avatar burn of the composite is free (composite ChargedClip)", burn?.reservedQuota === false);
      check("avatar chain: exactly one active charge", (await activeCharges(tester.id, [created.job.id, rows[0].id])) === 1);
      const status = await getVideoJobStatusTool(tester.id, created.job.id);
      check("avatar chain status done with editorUrl", status?.status === "done"
        && (status as { editorUrl?: string }).editorUrl === `https://studio.example.test/video-editor?projectId=${created.projectId}`);
    }
  });

  // ── D. failure in each half settles exactly once ───────────────────────────────────────
  await section("D) failure in each half settles once", async () => {
    const minutesBefore = (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed;
    const previewFail = await createChain(tester, {}, "d-preview-fail");
    await runJob(previewFail.job.id, tester.id, { failBaseRender: true });
    const pf = await prisma.videoJob.findUniqueOrThrow({ where: { id: previewFail.job.id } });
    check(`preview-half failure → failed (got ${pf.status})`, pf.status === "failed");
    check("preview-half failure never enqueues an export", (await chainRows(tester.id, pf.id)).length === 0);
    check("preview-half failure refunded its base reservation", (await activeCharges(tester.id, [pf.id])) === 0
      && (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed === minutesBefore);
    const again = await refundVideoJobTerminalRenderReservations({ videoJobId: pf.id, userId: tester.id, reason: "replay" });
    check("a second settlement is a no-op (settles once)", again.kind === "settled" && again.refundedJobs === 0
      && (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed === minutesBefore);
    const pfStatus = await getVideoJobStatusTool(tester.id, pf.id);
    check("status: preview-half failure → failed with T6 fields, refunded",
      pfStatus?.status === "failed" && typeof pfStatus?.errorCode === "string" && pfStatus?.refunded === true
      && pfStatus?.refundPending === false && !("editorUrl" in (pfStatus ?? {})));
    check("A2: a preview-half failure carries neither editorUrl nor the retry-export sentence",
      !("editorUrl" in (pfStatus ?? {})) && !String(pfStatus?.userAction ?? "").includes(RETRY_EXPORT_SENTENCE));
    await sweepStalledVideoJobs(new Date());
    check("watchdog never chains a failed preview", (await chainRows(tester.id, pf.id)).length === 0);

    const exportFail = await createChain(tester, {}, "d-export-fail");
    await runJob(exportFail.job.id, tester.id);
    const [efExport] = await chainRows(tester.id, exportFail.job.id);
    const minutesAfterPreview = (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed;
    await runJob(efExport.id, tester.id, { failBurn: true });
    const ef = await prisma.videoJob.findUniqueOrThrow({ where: { id: efExport.id } });
    check(`export-half failure → failed (got ${ef.status})`, ef.status === "failed");
    check("export-half failure: the preview's single charge stands, the free burn charged nothing",
      (await activeCharges(tester.id, [exportFail.job.id, ef.id])) === 1
      && (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed === minutesAfterPreview);
    const efStatus = await getVideoJobStatusTool(tester.id, exportFail.job.id);
    check("status: export-half failure comes from the export row, export copy",
      efStatus?.status === "failed" && efStatus?.errorCode === ef.errorCode
      && efStatus?.message === "ส่งออกวิดีโอไม่สำเร็จ" && efStatus?.refunded === false);
    check("A2: an export-half failure carries the absolute editorUrl of the Agent-created Project",
      (efStatus as { editorUrl?: string } | null)?.editorUrl === editorUrlFor(exportFail.projectId),
      JSON.stringify(efStatus));
    check("A2: an export-half failure appends exactly the retry-export sentence to userAction",
      String(efStatus?.userAction ?? "").endsWith(` ${RETRY_EXPORT_SENTENCE}`)
      && String(efStatus?.userAction ?? "").split(RETRY_EXPORT_SENTENCE).length === 2,
      String(efStatus?.userAction));
    check("status(export id) on a failed chain = same shape",
      JSON.stringify(await getVideoJobStatusTool(tester.id, ef.id)) === JSON.stringify(efStatus));

    // Duplicate finish → still one export (unique (userId, idempotencyKey)).
    const dup = await createChain(tester, {}, "d-dup");
    await runJob(dup.job.id, tester.id);
    const replay = await finishJobWithTransition(dup.job.id, { videoUrl: "/api/renders/ignored.mp4" });
    check("a duplicate finish does not transition again", replay.transitioned === false);
    const [r1, r2] = await Promise.all([
      chain.enqueueMcpChainExport({ previewJobId: dup.job.id, userId: tester.id }),
      chain.enqueueMcpChainExport({ previewJobId: dup.job.id, userId: tester.id }),
    ]);
    check("duplicate/concurrent enqueues are no-ops", r1.kind === "exists" && r2.kind === "exists");
    check("duplicate finish enqueues once", (await chainRows(tester.id, dup.job.id)).length === 1);
  });

  // ── E. lost-enqueue recovery + permanent refusal marker ────────────────────────────────
  await section("E) lost enqueue: get_video_status and the watchdog re-enqueue idempotently", async () => {
    const loseEnqueue = async (previewId: string, projectId: string) => {
      await prisma.videoJob.deleteMany({ where: { idempotencyKey: keyFor(previewId) } });
      await prisma.editorProject.update({ where: { id: projectId }, data: { activeExportJobId: null, status: "post" } });
    };
    const viaStatus = await createChain(tester, {}, "e-status");
    await runJob(viaStatus.job.id, tester.id);
    await loseEnqueue(viaStatus.job.id, viaStatus.projectId!);
    const recovered = await getVideoJobStatusTool(tester.id, viaStatus.job.id);
    check("status read re-enqueues the lost export", (await chainRows(tester.id, viaStatus.job.id)).length === 1);
    check("status read reports processing at 85", recovered?.status === "processing" && recovered?.progress === 85);
    await getVideoJobStatusTool(tester.id, viaStatus.job.id);
    check("a second status read does not enqueue again", (await chainRows(tester.id, viaStatus.job.id)).length === 1);

    const viaWatchdog = await createChain(tester, {}, "e-watchdog");
    await runJob(viaWatchdog.job.id, tester.id);
    await loseEnqueue(viaWatchdog.job.id, viaWatchdog.projectId!);
    const sweep = await sweepStalledVideoJobs(new Date());
    check("watchdog recovers the lost export",
      (sweep as { recoveredChainExports?: string[] }).recoveredChainExports?.includes(viaWatchdog.job.id) === true
      && (await chainRows(tester.id, viaWatchdog.job.id)).length === 1);
    const sweepAgain = await sweepStalledVideoJobs(new Date());
    check("a second sweep is a no-op",
      ((sweepAgain as { recoveredChainExports?: string[] }).recoveredChainExports ?? ["missing"]).length === 0
      && (await chainRows(tester.id, viaWatchdog.job.id)).length === 1);

    // A permanent refusal (the project moved on to a newer render) writes a terminal marker so
    // neither recovery path retries forever, and the chain reads as a failed export.
    const stale = await createChain(tester, {}, "e-stale");
    await runJob(stale.job.id, tester.id);
    await loseEnqueue(stale.job.id, stale.projectId!);
    const newer = await prisma.videoJob.create({
      data: { userId: tester.id, projectId: stale.projectId, type: "create", status: "done", inputJson: "{}",
        createdAt: new Date(Date.now() + 60_000) },
    });
    await prisma.editorProject.update({ where: { id: stale.projectId! }, data: { activeJobId: newer.id } });
    const refused = await chain.enqueueMcpChainExport({ previewJobId: stale.job.id, userId: tester.id });
    check("stale source → refused with the existing code", refused.kind === "refused" && refused.code === "stale_export_source");
    const marker = await chainRows(tester.id, stale.job.id);
    check("refusal writes ONE terminal failed marker under the chain key",
      marker.length === 1 && marker[0].status === "failed" && marker[0].errorCode === "stale_export_source");
    const staleStatus = await getVideoJobStatusTool(tester.id, stale.job.id);
    check("status: refused chain → failed, export copy (exportMode=true)",
      staleStatus?.status === "failed" && staleStatus?.errorCode === "stale_export_source"
      && staleStatus?.message === "ส่งออกวิดีโอไม่สำเร็จ");
    check("A2: a refused export (marker) is an export-half failure → editorUrl + retry sentence",
      (staleStatus as { editorUrl?: string } | null)?.editorUrl === editorUrlFor(stale.projectId)
      && String(staleStatus?.userAction ?? "").endsWith(` ${RETRY_EXPORT_SENTENCE}`));
    const sweepStale = await sweepStalledVideoJobs(new Date());
    check("watchdog never retries a refused chain",
      !((sweepStale as { recoveredChainExports?: string[] }).recoveredChainExports ?? []).includes(stale.job.id)
      && (await chainRows(tester.id, stale.job.id)).length === 1);

    // T10 seam: a canceled marker stops recovery the same way.
    const canceled = await createChain(tester, {}, "e-cancel");
    await runJob(canceled.job.id, tester.id);
    await loseEnqueue(canceled.job.id, canceled.projectId!);
    const mark = await chain.writeMcpChainTerminalMarker({
      userId: tester.id, previewJobId: canceled.job.id, status: "canceled", code: "canceled", message: "canceled by user (mcp)",
    });
    check("T10 marker writer: canceled marker written", mark.kind === "written");
    const canceledStatus = await getVideoJobStatusTool(tester.id, canceled.job.id);
    check("canceled marker → chain reads canceled; recovery does not enqueue",
      canceledStatus?.status === "canceled" && (await chainRows(tester.id, canceled.job.id)).length === 1);
  });

  // ── F. web re-renders / web previews / exports never chain ─────────────────────────────
  await section("F) a web render on an Agent-created Project never chains", async () => {
    const agent = await createChain(tester, {}, "f-agent");
    await runJob(agent.job.id, tester.id);
    const webPreview = await createVideoJob(tester.id, { script: SCRIPT, previewMode: true, voiceProvider: "gemini" }, "f-web", { projectId: agent.projectId });
    await runJob(webPreview.id, tester.id);
    const webDone = await prisma.videoJob.findUniqueOrThrow({ where: { id: webPreview.id } });
    check(`web preview on the agent project finished (got ${webDone.status})`, webDone.status === "done");
    check("web preview on an Agent-created Project does not chain", (await chainRows(tester.id, webPreview.id)).length === 0);
    const rerender = await prisma.videoJob.create({
      data: { userId: tester.id, projectId: agent.projectId, type: "create", status: "done",
        inputJson: JSON.stringify({ mode: "broll-rerender", previewMode: true, sourceJobId: agent.job.id, windowEdits: [] }),
        outputJson: webDone.outputJson, finishedAt: new Date() },
    });
    check("B-roll re-render is not a chain preview", chain.isMcpChainPreview(rerender) === false);
    check("enqueue on a B-roll re-render → not_chain",
      (await chain.enqueueMcpChainExport({ previewJobId: rerender.id, userId: tester.id })).kind === "not_chain");
    const [agentExport] = await chainRows(tester.id, agent.job.id);
    check("an export never triggers a chain (type export)", chain.isMcpChainPreview(agentExport) === false);
    await sweepStalledVideoJobs(new Date());
    check("watchdog ignores web jobs",
      (await chainRows(tester.id, webPreview.id)).length === 0 && (await chainRows(tester.id, rerender.id)).length === 0);
    const orchestratorSrc = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
    check("chain-following keys on job data (input.mcpChainExport), never the live flag",
      orchestratorSrc.includes("input.mcpChainExport === true") && !orchestratorSrc.includes("MCP_EDITOR_PROJECT_PUBLIC"));
    check("enqueue never runs inside onTransition", !/onTransition[\s\S]{0,600}enqueueMcpChainExport/.test(orchestratorSrc));
    const processingPreview = await createChain(tester, {}, "f-processing");
    await prisma.videoJob.update({ where: { id: processingPreview.job.id }, data: { status: "processing" } });
    check("enqueue before the finish commits is impossible (preview not done → not_ready)",
      (await chain.enqueueMcpChainExport({ previewJobId: processingPreview.job.id, userId: tester.id })).kind === "not_ready"
      && (await chainRows(tester.id, processingPreview.job.id)).length === 0);
  });

  // ── G. IDOR ───────────────────────────────────────────────────────────────────────────
  await section("G) IDOR: another user's chain ids are not found", async () => {
    check("status(preview id) as another user → not found", (await getVideoJobStatusTool(other.id, bPreviewId)) === null);
    check("status(export id) as another user → not found", (await getVideoJobStatusTool(other.id, bExportId)) === null);
    check("resolveMcpChain as another user → null", (await chain.resolveMcpChain(other.id, bPreviewId)) === null);
    check("enqueue as another user → not_chain, nothing written",
      (await chain.enqueueMcpChainExport({ previewJobId: bPreviewId, userId: other.id })).kind === "not_chain"
      && (await prisma.videoJob.count({ where: { userId: other.id } })) === 0);
    const foreignMarker = await chain.writeMcpChainTerminalMarker({
      userId: other.id, previewJobId: bPreviewId, status: "canceled", code: "canceled", message: "x",
    });
    check("marker writer refuses another user's preview", foreignMarker.kind === "not_chain"
      && (await prisma.videoJob.count({ where: { userId: other.id } })) === 0);
  });

  // ── H. status mapping on hand-built rows ──────────────────────────────────────────────
  await section("H) status mapping", async () => {
    const created = await createChain(tester, {}, "h-map");
    const id = created.job.id;
    await prisma.videoJob.update({ where: { id }, data: { status: "processing", progress: 40, currentStep: "render" } });
    const running = await getVideoJobStatusTool(tester.id, id);
    check(`preview running → processing, progress scaled 0–85 (got ${running?.progress})`,
      running?.status === "processing" && running?.progress === 34 && running?.currentStep === "render");
    await prisma.videoJob.update({ where: { id }, data: { status: "waiting_provider", progress: 84 } });
    check("preview waiting_provider → processing", (await getVideoJobStatusTool(tester.id, id))?.status === "processing");
    await prisma.videoJob.update({ where: { id }, data: { status: "canceled", errorMessage: "canceled by user" } });
    const previewCanceled = await getVideoJobStatusTool(tester.id, id);
    check("preview canceled → canceled, no editorUrl (A2 is export-half only)",
      previewCanceled?.status === "canceled" && !("editorUrl" in (previewCanceled ?? {})));

    const shell = await createChain(tester, {}, "h-shell");
    const doneOut = (await prisma.videoJob.findUniqueOrThrow({ where: { id: bPreviewId } })).outputJson;
    await prisma.videoJob.update({ where: { id: shell.job.id }, data: { status: "done", progress: 100, outputJson: doneOut, finishedAt: new Date() } });
    const exp = await prisma.videoJob.create({
      data: { userId: tester.id, projectId: shell.projectId, type: "export", status: "processing", progress: 60, currentStep: "burn",
        idempotencyKey: keyFor(shell.job.id),
        inputJson: JSON.stringify({ mode: "export", sourceJobId: shell.job.id, mcpChainExport: true }) },
    });
    const exporting = await getVideoJobStatusTool(tester.id, shell.job.id);
    check(`export running → processing, progress 85–100 (got ${exporting?.progress})`,
      exporting?.status === "processing" && exporting?.progress === 94 && exporting?.currentStep === "burn");
    check("query by export id while running = same shape",
      JSON.stringify(await getVideoJobStatusTool(tester.id, exp.id)) === JSON.stringify(exporting));
    await prisma.videoJob.update({ where: { id: exp.id }, data: { status: "canceled", errorMessage: "canceled by user" } });
    const exportCanceled = await getVideoJobStatusTool(tester.id, shell.job.id);
    check("export canceled → canceled with the absolute editorUrl (A2), no retry sentence",
      exportCanceled?.status === "canceled"
      && (exportCanceled as { editorUrl?: string } | null)?.editorUrl === editorUrlFor(shell.projectId)
      && !JSON.stringify(exportCanceled).includes(RETRY_EXPORT_SENTENCE));
    check("query by export id while canceled = same shape",
      JSON.stringify(await getVideoJobStatusTool(tester.id, exp.id)) === JSON.stringify(exportCanceled));

    const squat = await createChain(tester, {}, "h-squat");
    await prisma.videoJob.update({ where: { id: squat.job.id }, data: { status: "done", progress: 100, outputJson: doneOut, finishedAt: new Date() } });
    await prisma.videoJob.create({
      data: { userId: tester.id, type: "create", status: "queued", idempotencyKey: keyFor(squat.job.id), inputJson: "{}" },
    });
    const squatted = await getVideoJobStatusTool(tester.id, squat.job.id);
    check("a non-export row squatting the chain key → failed (idempotency_conflict), never stuck",
      squatted?.status === "failed" && squatted?.errorCode === "idempotency_conflict");

    const plain = await createVideoJob(tester.id, { script: SCRIPT, voiceProvider: "gemini" }, "h-plain");
    const plainStatus = await getVideoJobStatusTool(tester.id, plain.id);
    check("a non-chain job keeps the PR-A shape (no editorUrl/videoId keys)",
      plainStatus?.jobId === plain.id && !("editorUrl" in (plainStatus ?? {})) && !("videoId" in (plainStatus ?? {})));
  });

  // ── I. chain receipt ──────────────────────────────────────────────────────────────────
  await section("I) chain billing receipt sums both jobs and requires exactly one active charge", async () => {
    const one = await billing.getVideoJobChainBillingReceipt({ videoJobIds: [bPreviewId, bExportId], userId: tester.id });
    check("one charge across preview+export → settled minutes", one.status === "settled" && one.funding === "minutes");
    check("other user sees no charge", (await billing.getVideoJobChainBillingReceipt({ videoJobIds: [bPreviewId, bExportId], userId: other.id })).status === "error");
    await prisma.renderJob.create({
      data: { id: "rj-extra", userId: tester.id, parentJobId: bExportId, type: "BURN", status: "DONE", payload: "{}",
        reservedQuota: true, reservedMinutes: 1 },
    });
    const two = await billing.getVideoJobChainBillingReceipt({ videoJobIds: [bPreviewId, bExportId], userId: tester.id });
    check("a second charge anywhere in the chain → multiple_active_charges",
      two.status === "error" && two.code === "multiple_active_charges" && two.activeCharges === 2);
    await prisma.renderJob.delete({ where: { id: "rj-extra" } });
    const single = await billing.getVideoJobBillingReceipt({ videoJobId: bPreviewId, userId: tester.id });
    check("single-job receipt unchanged", single.status === "settled");
  });

  // ── J. the release gate applies to the chain ──────────────────────────────────────────
  await section("J) release gate: a double charge across the chain blocks done and settles the extra once", async () => {
    const created = await createChain(tester, {}, "j-gate");
    await runJob(created.job.id, tester.id);
    const [exp] = await chainRows(tester.id, created.job.id);
    // Make the burn look unpaid → the stub render route charges it → 2 active charges.
    await prisma.chargedClip.deleteMany({ where: { userId: tester.id } });
    await runJob(exp.id, tester.id);
    const gated = await prisma.videoJob.findUniqueOrThrow({ where: { id: exp.id } });
    check(`gate blocks done on a double-charged chain (got ${gated.status})`,
      gated.status === "failed" && (gated.errorMessage ?? "").includes("multiple_active_charges"));
    check("the extra burn charge settled back once → one active charge left",
      (await activeCharges(tester.id, [created.job.id, exp.id])) === 1);
    const status = await getVideoJobStatusTool(tester.id, created.job.id);
    check("status reports the gated chain as failed", status?.status === "failed");
  });

  // ── K. errorProvider family match (R-T8-3) + exportMode copy (R-T8-2) ─────────────────
  await section("K) managed-provider omission by family; export-half copy", async () => {
    const mk = async (id: string, provider: string) => prisma.videoJob.create({
      data: { id, userId: tester.id, status: "failed", errorCode: "transient", errorProvider: provider,
        currentStep: "stock", inputJson: "{}" },
    });
    for (const provider of ["runpod", "RunPod", "runpod-hero-image", "runpod_serverless", "omnivoice", "omnivoice-hostinger", "OmniVoice-RunPod"]) {
      const row = await mk(`k-${provider}`, provider);
      const fields = await deriveFailedJobFields(row, [row.id]);
      check(`managed family '${provider}' → errorProvider omitted`, !("errorProvider" in fields));
    }
    for (const provider of ["heygen", "elevenlabs", "gemini"]) {
      const row = await mk(`k-${provider}`, provider);
      const fields = await deriveFailedJobFields(row, [row.id]);
      check(`BYOK '${provider}' → errorProvider kept`, fields.errorProvider === provider);
    }
    const nullStep = await prisma.videoJob.create({
      data: { id: "k-export-null-step", userId: tester.id, status: "failed", errorCode: "source_not_exportable",
        currentStep: null, inputJson: "{}" },
    });
    const create = await deriveFailedJobFields(nullStep, [nullStep.id]);
    const exportView = await deriveFailedJobFields(nullStep, [nullStep.id], { exportMode: true });
    check("default (create) copy unchanged", create.message === "สร้างวิดีโอไม่สำเร็จ");
    check("exportMode=true → export copy", exportView.message === "ส่งออกวิดีโอไม่สำเร็จ");
  });

  // ── L. R-T8-1: the export path never fails without a code ─────────────────────────────
  await section("L) export path failures carry explicit codes", async () => {
    const orchestratorSrc = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
    const start = orchestratorSrc.indexOf('if (input.mode === "export") {');
    const end = orchestratorSrc.indexOf("EDITOR V2 UPLOAD", start);
    const exportBlock = orchestratorSrc.slice(start, end);
    check("export block located", start > 0 && end > start);
    check("no bare-string failJob in the export block", !/failJob\(jobId, "/.test(exportBlock));
    for (const code of ["invalid_source", "invalid_export", "source_not_found", "source_not_ready", "source_not_exportable"]) {
      check(`export block uses existing code ${code}`, exportBlock.includes(`code: "${code}"`));
    }
    const notDone = await prisma.videoJob.create({
      data: { userId: tester.id, type: "create", status: "processing", inputJson: JSON.stringify({ script: SCRIPT }) },
    });
    const exportJob = await createVideoJob(tester.id, { mode: "export", sourceJobId: notDone.id, subtitleOverlayConfig: { videoUrl: "/api/renders/x.mp4", keywordPopups: [] } }, "l-export", { type: "export" });
    await runJob(exportJob.id, tester.id);
    const failedExport = await prisma.videoJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    check(`export of an unfinished source → source_not_ready (got ${failedExport.errorCode})`,
      failedExport.status === "failed" && failedExport.errorCode === "source_not_ready");
  });

  // ── P. Fix round 1 (L1): an unexpected enqueue error closes the chain; drain/SQLite stay retryable
  await section("P) enqueue errors: unexpected → terminal failed marker; drain / SQLite busy → retryable", async () => {
    const { RENDER_DEPLOY_DRAIN_KEY } = await import("../src/lib/render-deploy-drain");
    const loseEnqueue = async (previewId: string, projectId: string) => {
      await prisma.videoJob.deleteMany({ where: { idempotencyKey: keyFor(previewId) } });
      await prisma.editorProject.update({ where: { id: projectId }, data: { activeExportJobId: null, status: "post" } });
    };

    // Classifier: only the deploy drain and SQLite busy/locked/timeouts are retryable.
    const { RenderDeployDrainError } = await import("../src/lib/render-deploy-drain");
    const classify = (chain as { isRetryableMcpChainEnqueueError?: (e: unknown) => boolean }).isRetryableMcpChainEnqueueError;
    check("classifier exported", typeof classify === "function");
    if (typeof classify === "function") {
      check("drain refusal is retryable", classify(new RenderDeployDrainError()) === true);
      check("SQLite busy (P1008 / 'database is locked' / SQLITE_BUSY) is retryable",
        classify(Object.assign(new Error("Operations timed out"), { code: "P1008" }))
        && classify(new Error("SQLITE_BUSY: database is locked"))
        && classify(Object.assign(new Error("Transaction already closed"), { code: "P2028" })));
      check("anything else is permanent (TypeError, FK violation, plain Error)",
        !classify(new TypeError("Cannot read properties of null (reading 'trim')"))
        && !classify(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }))
        && !classify(new Error("boom")));
    }

    // Permanent: odd persisted preview data makes the server-side overlay build throw.
    const odd = await createChain(tester, {}, "p-odd");
    await runJob(odd.job.id, tester.id);
    await loseEnqueue(odd.job.id, odd.projectId!);
    const oddRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: odd.job.id } });
    const oddOut = JSON.parse(oddRow.outputJson ?? "{}") as { preview: { captions: Array<Record<string, unknown>> } };
    oddOut.preview.captions = [{ text: null, startMs: 0, endMs: 1000, tag: "hook" }];
    await prisma.videoJob.update({ where: { id: odd.job.id }, data: { outputJson: JSON.stringify(oddOut) } });
    const minutesBeforeOdd = (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed;
    const oddResult = await chain.enqueueMcpChainExport({ previewJobId: odd.job.id, userId: tester.id });
    check(`unexpected error → refused with the existing internal code (got ${JSON.stringify(oddResult)})`,
      oddResult.kind === "refused" && oddResult.code === "internal");
    const oddRows = await chainRows(tester.id, odd.job.id);
    check("unexpected error writes ONE terminal failed marker",
      oddRows.length === 1 && oddRows[0].status === "failed" && oddRows[0].errorCode === "internal");
    const oddStatus = await getVideoJobStatusTool(tester.id, odd.job.id);
    check("status leaves processing/85: failed, export copy, editorUrl + retry sentence",
      oddStatus?.status === "failed" && oddStatus?.errorCode === "internal"
      && oddStatus?.message === "ส่งออกวิดีโอไม่สำเร็จ"
      && (oddStatus as { editorUrl?: string } | null)?.editorUrl === editorUrlFor(odd.projectId)
      && String(oddStatus?.userAction ?? "").endsWith(` ${RETRY_EXPORT_SENTENCE}`),
      JSON.stringify(oddStatus));
    check("the marker settles nothing new: the preview's single charge stands, minutes unchanged",
      (await activeCharges(tester.id, [odd.job.id, oddRows[0]?.id ?? ""])) === 1
      && (await prisma.user.findUniqueOrThrow({ where: { id: tester.id } })).minutesUsed === minutesBeforeOdd);
    const oddSweep = await sweepStalledVideoJobs(new Date());
    check("watchdog never retries the closed chain",
      !(oddSweep.recoveredChainExports ?? []).includes(odd.job.id) && (await chainRows(tester.id, odd.job.id)).length === 1);

    // Retryable: deploy drain → deferred, no marker; lifting it lets recovery enqueue.
    const drained = await createChain(tester, {}, "p-drain");
    await runJob(drained.job.id, tester.id);
    await loseEnqueue(drained.job.id, drained.projectId!);
    await prisma.siteConfig.upsert({
      where: { key: RENDER_DEPLOY_DRAIN_KEY }, create: { key: RENDER_DEPLOY_DRAIN_KEY, value: "1" }, update: { value: "1" },
    });
    const drainResult = await chain.enqueueMcpChainExport({ previewJobId: drained.job.id, userId: tester.id });
    const drainStatus = await getVideoJobStatusTool(tester.id, drained.job.id);
    await prisma.siteConfig.update({ where: { key: RENDER_DEPLOY_DRAIN_KEY }, data: { value: "0" } });
    check(`drain → deferred, no marker (got ${JSON.stringify(drainResult)})`,
      drainResult.kind === "deferred" && drainResult.reason === "render_maintenance"
      && drainStatus?.status === "processing" && drainStatus?.progress === 85);
    check("drain wrote no row under the chain key", (await chainRows(tester.id, drained.job.id)).length <= 0);
    const afterDrain = await getVideoJobStatusTool(tester.id, drained.job.id);
    const afterDrainRows = await chainRows(tester.id, drained.job.id);
    check("after the drain lifts, recovery enqueues the real export",
      afterDrain?.status === "processing" && afterDrainRows.length === 1
      && afterDrainRows[0].status === "queued" && afterDrainRows[0].type === "export");

    // Retryable: SQLite busy while creating the export → deferred, no marker.
    const busy = await createChain(tester, {}, "p-busy");
    await runJob(busy.job.id, tester.id);
    await loseEnqueue(busy.job.id, busy.projectId!);
    const client = prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
    const realTransaction = client.$transaction;
    client.$transaction = async () => {
      throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "P1008" });
    };
    let busyResult: Awaited<ReturnType<typeof chain.enqueueMcpChainExport>> | null = null;
    try {
      busyResult = await chain.enqueueMcpChainExport({ previewJobId: busy.job.id, userId: tester.id });
    } finally {
      client.$transaction = realTransaction;
    }
    check(`SQLite busy → deferred, no marker (got ${JSON.stringify(busyResult)})`,
      busyResult?.kind === "deferred" && (await chainRows(tester.id, busy.job.id)).length === 0);
    await getVideoJobStatusTool(tester.id, busy.job.id);
    check("after SQLite recovers, recovery enqueues the real export",
      (await chainRows(tester.id, busy.job.id)).some((row) => row.status === "queued" && row.type === "export"));
  });

  // ── M. inflight cap bypass + CI wiring ────────────────────────────────────────────────
  await section("M) the server chain bypasses the inflight>=3 cap; CI runs this file", async () => {
    // A non-tester reaches the chain through the public flag (create time only).
    process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
    const created = await createChain(owner, {}, "m-cap");
    delete process.env.MCP_EDITOR_PROJECT_PUBLIC;
    await runJob(created.job.id, owner.id);
    await prisma.videoJob.deleteMany({ where: { idempotencyKey: keyFor(created.job.id) } });
    for (let index = 0; index < 3; index += 1) {
      await prisma.videoJob.create({ data: { userId: owner.id, status: "queued", inputJson: "{}" } });
    }
    const result = await chain.enqueueMcpChainExport({ previewJobId: created.job.id, userId: owner.id });
    check("3 in-flight jobs do not block the chained export", result.kind === "enqueued");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    check("verify:mcp-perfect (run by verify:subtitle-audio-sync in CI) includes this file",
      (pkg.scripts["verify:mcp-perfect"] ?? "").includes("scripts/verify-mcp-chain-export.ts")
      && (pkg.scripts["verify:subtitle-audio-sync"] ?? "").includes("verify:mcp-perfect"));
  });

  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
