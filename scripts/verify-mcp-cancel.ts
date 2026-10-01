// verify-mcp-cancel.ts — T10 (ADR 0063): cancel_video_job.
//
// Plan: docs/plans/2026-10-01-mcp-upgrade-p0-p1.md (T10). The web DELETE
// /api/videos/jobs/[id] cancel body is extracted into a shared core
// (src/lib/mcp/video-job-cancel-core.ts: cancelVideoJobCore, chain-export-free — fix round 1
// A5) so web behavior stays byte-identical. A chain-aware wrapper (cancelMcpVideoJob, in
// video-job-cancel.ts) backs the new MCP
// `cancel_video_job({id})` tool: it accepts either the preview or the export id, cancels
// whichever half is in flight, and — when the preview is done but the export was never
// enqueued (the gap) — writes a canceled terminal marker under the chain key so neither
// get_video_status nor the watchdog ever enqueues one afterwards (T8's chain-export.ts).
//
// Self-contained: always builds its own throwaway SQLite, even when DATABASE_URL is preset.
//
// Fix round 1 adds: A1 (preview-finish race falls through, not a false not_cancelable), A2
// (the enqueue-wins gap race never strands the project on "exporting"), A3 (MCP read-path
// cancel copy is one fixed Thai sentence), A4 (the marker-loses "exists" branch, and a
// handler-level web DELETE test with a stubbed getCurrentUser — node:test's mock.module,
// hence --experimental-test-module-mocks below), A5/A6 (web DELETE's import graph and log
// prefix restored to their pre-T10 shape).
//
// Run: node --conditions=react-server --experimental-test-module-mocks --import tsx scripts/verify-mcp-cancel.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "mcp-cancel-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

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

/**
 * Test-only: intercept exactly ONE call to `obj[method]` whose args satisfy `when`, running
 * `before` (handed the untouched original function) first, then always delegating to the
 * real implementation. Reproduces a specific interleaving deterministically — no timing, no
 * flakiness — by making the "concurrent" write actually happen against the DB first, through
 * genuine application code, before the call under test proceeds.
 */
function hideOnce<Args extends unknown[], Ret>(
  obj: Record<string, (...args: Args) => Promise<Ret>>,
  method: string,
  when: (args: Args) => boolean,
  before: (original: (...args: Args) => Promise<Ret>, args: Args) => Promise<unknown>,
): () => void {
  const original = obj[method].bind(obj) as (...args: Args) => Promise<Ret>;
  let used = false;
  obj[method] = async (...args: Args) => {
    if (!used && when(args)) {
      used = true;
      await before(original, args);
    }
    return original(...args);
  };
  return () => { obj[method] = original; };
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  // Fix round 1 (A5): cancelVideoJobCore now lives in its own chain-export-free module;
  // cancelMcpVideoJob (the chain router) stays in video-job-cancel.ts.
  const { cancelVideoJobCore } = await import("../src/lib/mcp/video-job-cancel-core");
  const { cancelMcpVideoJob } = await import("../src/lib/mcp/video-job-cancel");
  const { mcpChainExportKey } = await import("../src/lib/mcp/chain-key");
  const { resolveMcpChain, enqueueMcpChainExport } = await import("../src/lib/mcp/chain-export");
  const { getVideoJobStatusTool } = await import("../src/lib/mcp/tools");
  const { sweepStalledVideoJobs } = await import("../src/lib/mcp/video-job-watchdog");
  const { checkMinuteQuota } = await import("../src/lib/minute-limits");
  const { recordChargedClip, isBurnAlreadyPaid } = await import("../src/lib/clip-charge");
  const { createEditorProject } = await import("../src/lib/editor-projects");

  const now = new Date();
  let userSeq = 0;
  async function makeUser(minutesUsed = 0) {
    userSeq += 1;
    const id = `u-cancel-${userSeq}`;
    // A real Payment + active subscription, or syncUserEntitlement resets minutesUsed on
    // its very next read (no backing entitlement to preserve).
    const user = await prisma.user.create({
      data: {
        id, name: id, email: `${id}@example.com`,
        plan: "PRO", minutesLimit: 80, minutesUsed,
        usagePeriodStartedAt: now,
        subStatus: "active",
        stripeSubscriptionId: `sub_${id}`,
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: { userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900, status: "PAID", periodDays: 30, paidAt: now },
    });
    return user;
  }

  let projSeq = 0;
  async function makeProject(userId: string) {
    projSeq += 1;
    return createEditorProject(userId, { title: `Project ${projSeq}`, draft: { createdVia: "mcp" } });
  }

  let jobSeq = 0;
  async function makeJob(userId: string, data: {
    type?: string;
    status?: string;
    projectId?: string | null;
    inputJson?: Record<string, unknown>;
    idempotencyKey?: string | null;
    finishedAt?: Date | null;
  } = {}) {
    jobSeq += 1;
    return prisma.videoJob.create({
      data: {
        id: `job-${jobSeq}`,
        userId,
        type: data.type ?? "create",
        status: data.status ?? "processing",
        projectId: data.projectId ?? null,
        inputJson: JSON.stringify(data.inputJson ?? { script: "สวัสดีค่ะ" }),
        idempotencyKey: data.idempotencyKey ?? null,
        finishedAt: data.finishedAt ?? null,
      },
    });
  }

  async function makeChainPreview(userId: string, projectId: string, opts: { status?: string; finishedAt?: Date | null } = {}) {
    return makeJob(userId, {
      type: "create",
      status: opts.status ?? "done",
      projectId,
      inputJson: { script: "สวัสดีค่ะ", previewMode: true, mcpChainExport: true },
      finishedAt: opts.finishedAt ?? (opts.status === "done" || opts.status === undefined ? now : null),
    });
  }

  async function makeChainExport(userId: string, previewId: string, projectId: string, status: string) {
    return makeJob(userId, {
      type: "export",
      status,
      projectId,
      inputJson: { mode: "export", sourceJobId: previewId, mcpChainExport: true },
      idempotencyKey: mcpChainExportKey(previewId),
    });
  }

  async function keyRowCount(userId: string, previewId: string) {
    return prisma.videoJob.count({ where: { userId, idempotencyKey: mcpChainExportKey(previewId) } });
  }

  /** A DONE chain preview with just enough output for planChainExport/enqueueMcpChainExport
   *  to succeed for real (minimal v2 preview shape — one caption, a base video, a voice). */
  async function makeEnqueueReadyPreview(userId: string, projectId: string) {
    const preview = await makeChainPreview(userId, projectId, { status: "done" });
    await prisma.videoJob.update({
      where: { id: preview.id },
      data: {
        outputJson: JSON.stringify({
          version: 2,
          videoUrl: "/api/renders/race-base.mp4",
          preview: {
            captions: [{ text: "สวัสดีค่ะ", startMs: 0, endMs: 2000, tag: "hook" }],
            config: {},
            voiceUrl: "/api/renders/race-voice.wav",
            audioDurationMs: 2000,
          },
        }),
      },
    });
    await prisma.editorProject.update({ where: { id: projectId }, data: { activeJobId: preview.id, status: "post" } });
    return preview;
  }

  // ── A: plain (non-chain) job cancel — the extracted web core ──────────────────────────
  await section("A: plain job cancel (web core, byte-identical semantics)", async () => {
    // A1: queued create job, no project → canceled, no settlement needed.
    const u1 = await makeUser();
    const j1 = await makeJob(u1.id, { status: "queued" });
    const r1 = await cancelVideoJobCore(u1.id, j1.id);
    check("A1: queued create job cancels", r1.kind === "canceled" && r1.settlementPending === false);
    const row1 = await prisma.videoJob.findUniqueOrThrow({ where: { id: j1.id } });
    check("A1: status canceled, reason recorded, refund flag cleared",
      row1.status === "canceled"
        && row1.errorMessage === "canceled by user (editor v2)"
        && row1.reservationRefundPending === false
        && row1.reservationRefundReason === null);

    // A2: processing EXPORT job on a project → project transitions to "post".
    const u2 = await makeUser();
    const p2 = await makeProject(u2.id);
    const j2 = await makeJob(u2.id, { type: "export", status: "processing", projectId: p2.id });
    await prisma.editorProject.update({ where: { id: p2.id }, data: { activeExportJobId: j2.id, status: "exporting" } });
    const r2 = await cancelVideoJobCore(u2.id, j2.id);
    check("A2: export job cancels", r2.kind === "canceled");
    const proj2 = await prisma.editorProject.findUniqueOrThrow({ where: { id: p2.id } });
    check("A2: project status -> post (export cancel)", proj2.status === "post");

    // A3: processing CREATE job on a project → project transitions to "draft".
    const u3 = await makeUser();
    const p3 = await makeProject(u3.id);
    const j3 = await makeJob(u3.id, { type: "create", status: "processing", projectId: p3.id });
    await prisma.editorProject.update({ where: { id: p3.id }, data: { activeJobId: j3.id, status: "rendering" } });
    const r3 = await cancelVideoJobCore(u3.id, j3.id);
    check("A3: create job cancels", r3.kind === "canceled");
    const proj3 = await prisma.editorProject.findUniqueOrThrow({ where: { id: p3.id } });
    check("A3: project status -> draft (create cancel)", proj3.status === "draft");

    // A4: already-terminal job → not_cancelable, nothing changes.
    const u4 = await makeUser();
    const j4 = await makeJob(u4.id, { status: "done" });
    const r4 = await cancelVideoJobCore(u4.id, j4.id);
    check("A4: terminal job is not_cancelable", r4.kind === "not_cancelable");
    const row4 = await prisma.videoJob.findUniqueOrThrow({ where: { id: j4.id } });
    check("A4: terminal job untouched", row4.status === "done");

    // A5: foreign user's job id → not_cancelable (owner scoping, IDOR).
    const u5 = await makeUser();
    const other5 = await makeUser();
    const j5 = await makeJob(u5.id, { status: "processing" });
    const r5 = await cancelVideoJobCore(other5.id, j5.id);
    check("A5: foreign id is not_cancelable", r5.kind === "not_cancelable");
    const row5 = await prisma.videoJob.findUniqueOrThrow({ where: { id: j5.id } });
    check("A5: foreign cancel attempt left the job untouched", row5.status === "processing");

    // A6: nonexistent id → not_cancelable.
    const u6 = await makeUser();
    const r6 = await cancelVideoJobCore(u6.id, "no-such-job");
    check("A6: nonexistent id is not_cancelable", r6.kind === "not_cancelable");

    // A7: settlementPending propagates when a render settlement is still in flight.
    const u7 = await makeUser();
    const j7 = await makeJob(u7.id, { status: "processing" });
    await prisma.renderJob.create({
      data: { id: "rj-inflight", userId: u7.id, parentJobId: j7.id, type: "RENDER", status: "QUEUED", payload: "{}", reservedQuota: true },
    });
    const r7 = await cancelVideoJobCore(u7.id, j7.id);
    check("A7: cancel still reports canceled with settlementPending=true", r7.kind === "canceled" && r7.settlementPending === true);
    const row7 = await prisma.videoJob.findUniqueOrThrow({ where: { id: j7.id } });
    check("A7: refund flag stays pending for retry when settlement is in flight", row7.reservationRefundPending === true);

    // A8: cancelMcpVideoJob on a plain (non-chain) id behaves exactly like cancelVideoJobCore.
    const u8 = await makeUser();
    const jA = await makeJob(u8.id, { status: "queued" });
    const jB = await makeJob(u8.id, { status: "queued" });
    const rA = await cancelVideoJobCore(u8.id, jA.id);
    const rB = await cancelMcpVideoJob(u8.id, jB.id);
    check("A8: cancelMcpVideoJob matches cancelVideoJobCore for a plain job", rA.kind === rB.kind
      && (rA.kind !== "canceled" || rB.kind !== "canceled" || rA.settlementPending === rB.settlementPending));
  });

  // ── B: MCP chain — cancel during the preview half (in flight) ─────────────────────────
  await section("B: chain preview in flight", async () => {
    const u = await makeUser();
    const proj = await makeProject(u.id);
    const preview = await makeChainPreview(u.id, proj.id, { status: "processing", finishedAt: null });
    await prisma.editorProject.update({ where: { id: proj.id }, data: { activeJobId: preview.id, status: "rendering" } });

    const r = await cancelMcpVideoJob(u.id, preview.id);
    check("B1: canceling an in-flight preview succeeds", r.kind === "canceled" && r.settlementPending === false);
    const row = await prisma.videoJob.findUniqueOrThrow({ where: { id: preview.id } });
    check("B1: preview row is canceled", row.status === "canceled");
    const proj1 = await prisma.editorProject.findUniqueOrThrow({ where: { id: proj.id } });
    check("B1: project falls back to draft (preview cancel, web semantics)", proj1.status === "draft");
    check("B1: no export row was ever created for this chain", await keyRowCount(u.id, preview.id) === 0);

    const r2 = await cancelMcpVideoJob(u.id, preview.id);
    check("B2: canceling the same (now terminal) preview again is not_cancelable", r2.kind === "not_cancelable");
  });

  // ── C: MCP chain — cancel during the export half (in flight); Q10 base stays charged ──
  await section("C: chain export in flight (Q10: base render stays charged)", async () => {
    const u = await makeUser(3); // 2 minutes for the base render + 1 for the export's own burn
    const proj = await makeProject(u.id);
    const baseUrl = "/api/renders/cancel-base.mp4";
    const preview = await makeChainPreview(u.id, proj.id, { status: "done" });
    await prisma.renderJob.create({
      data: { id: "rj-base-c", userId: u.id, parentJobId: preview.id, type: "RENDER", status: "DONE", payload: "{}", videoUrl: baseUrl, reservedQuota: true, reservedMinutes: 2 },
    });
    await recordChargedClip(u.id, baseUrl, 2);

    const exportJob = await makeChainExport(u.id, preview.id, proj.id, "processing");
    await prisma.editorProject.update({ where: { id: proj.id }, data: { activeExportJobId: exportJob.id, status: "exporting" } });
    const exportUrl = "/api/renders/cancel-export.mp4";
    await prisma.renderJob.create({
      data: { id: "rj-export-c", userId: u.id, parentJobId: exportJob.id, type: "BURN", status: "DONE", payload: "{}", videoUrl: exportUrl, reservedQuota: true, reservedMinutes: 1 },
    });

    // Cancel by the PREVIEW id — resolveMcpChain must route to the real in-flight export row.
    const r = await cancelMcpVideoJob(u.id, preview.id);
    check("C1: cancel-by-preview-id routes to the in-flight export and succeeds", r.kind === "canceled" && r.settlementPending === false);

    const exportRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    check("C1: the export row (not the preview) is canceled", exportRow.status === "canceled");
    const previewRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: preview.id } });
    check("C1: the preview stays done — only the export half was canceled", previewRow.status === "done");

    const proj1 = await prisma.editorProject.findUniqueOrThrow({ where: { id: proj.id } });
    check("C1: project falls back to post (export cancel, web semantics)", proj1.status === "post");

    // Q10: the completed base render stays charged.
    check("C1 (Q10): the base RenderJob reservation is untouched", (await prisma.renderJob.findUniqueOrThrow({ where: { id: "rj-base-c" } })).reservedQuota === true);
    check("C1 (Q10): the base minute charge still stands", (await checkMinuteQuota(u.id)).used === 2);
    check("C1 (Q10): isBurnAlreadyPaid still true for the base video", await isBurnAlreadyPaid(u.id, baseUrl) === true);

    // The export's OWN reservation settles exactly once.
    check("C1: the export's own reservation was refunded", (await prisma.renderJob.findUniqueOrThrow({ where: { id: "rj-export-c" } })).reservedQuota === false);
    check("C1: minutesUsed reflects only the base charge after the export refund (not double-refunded)", (await checkMinuteQuota(u.id)).used === 2);

    // Re-cancel (by the export id this time) is a no-op, not a second settlement.
    const r2 = await cancelMcpVideoJob(u.id, exportJob.id);
    check("C2: re-canceling the now-terminal export is not_cancelable", r2.kind === "not_cancelable");
    check("C2: settlement was not applied twice", (await checkMinuteQuota(u.id)).used === 2);
  });

  // ── D: MCP chain — the gap between preview finish and export enqueue ──────────────────
  await section("D: the gap (preview done, export never enqueued)", async () => {
    const u = await makeUser();
    const proj = await makeProject(u.id);
    const preview = await makeChainPreview(u.id, proj.id, { status: "done" });
    await prisma.editorProject.update({ where: { id: proj.id }, data: { activeJobId: preview.id, status: "post" } });

    check("D0: no row holds the chain key yet", await keyRowCount(u.id, preview.id) === 0);
    const r = await cancelMcpVideoJob(u.id, preview.id);
    check("D1: canceling in the gap succeeds with nothing to settle", r.kind === "canceled" && r.settlementPending === false);
    check("D1: exactly one (marker) row now holds the chain key", await keyRowCount(u.id, preview.id) === 1);

    const chain = await resolveMcpChain(u.id, preview.id);
    check("D1: the chain now resolves to a canceled export half", chain?.exportJob?.status === "canceled" && chain.conflict === false);
    const proj1 = await prisma.editorProject.findUniqueOrThrow({ where: { id: proj.id } });
    check("D1: the project stays post — the completed base render is still there (Q10)", proj1.status === "post");

    // get_video_status must read this as canceled, and must NOT enqueue a real export.
    const status = await getVideoJobStatusTool(u.id, preview.id) as { status?: string } | null;
    check("D2: get_video_status reports canceled for the preview id", status?.status === "canceled");
    const statusByExportId = await getVideoJobStatusTool(u.id, (chain!.exportJob as { id: string }).id) as { status?: string; jobId?: string } | null;
    check("D2: get_video_status reports canceled for the export(marker) id too", statusByExportId?.status === "canceled");
    check("D2: both ids resolve to the same chain (jobId is always the preview id)", statusByExportId?.jobId === preview.id);
    check("D2: get_video_status never enqueued a second row under the key", await keyRowCount(u.id, preview.id) === 1);

    // The watchdog sweep must never enqueue a real export for this chain either.
    const sweep = await sweepStalledVideoJobs();
    check("D3: the watchdog sweep recovers nothing for this chain", !sweep.recoveredChainExports.includes(preview.id));
    check("D3: still exactly one (the same marker) row under the key after the sweep", await keyRowCount(u.id, preview.id) === 1);
    const stillMarker = await prisma.videoJob.findFirst({ where: { userId: u.id, idempotencyKey: mcpChainExportKey(preview.id) } });
    check("D3: the row under the key is still the canceled marker, not a real export", stillMarker?.status === "canceled");

    // Re-canceling after the marker is a no-op (the export "row" it points at is terminal).
    const r2 = await cancelMcpVideoJob(u.id, preview.id);
    check("D4: re-canceling after the marker is not_cancelable", r2.kind === "not_cancelable");
  });

  // ── E: terminal ids and foreign ids return the identical not_cancelable shape ──────────
  await section("E: terminal and foreign ids share one shape (no existence oracle)", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const proj = await makeProject(u.id);

    // Plain terminal vs plain foreign.
    const terminalJob = await makeJob(u.id, { status: "failed" });
    const foreignJob = await makeJob(other.id, { status: "processing" });
    const rTerminal = await cancelMcpVideoJob(u.id, terminalJob.id);
    const rForeign = await cancelMcpVideoJob(u.id, foreignJob.id);
    check("E1: plain terminal id is not_cancelable", rTerminal.kind === "not_cancelable");
    check("E2: plain foreign id is not_cancelable", rForeign.kind === "not_cancelable");
    check("E3: terminal and foreign give byte-identical results", JSON.stringify(rTerminal) === JSON.stringify(rForeign));

    // Chain terminal (preview already failed, no export) vs chain foreign (owned by other user).
    const terminalPreview = await makeChainPreview(u.id, proj.id, { status: "failed", finishedAt: now });
    const otherProj = await makeProject(other.id);
    const foreignPreview = await makeChainPreview(other.id, otherProj.id, { status: "processing", finishedAt: null });
    const rChainTerminal = await cancelMcpVideoJob(u.id, terminalPreview.id);
    const rChainForeign = await cancelMcpVideoJob(u.id, foreignPreview.id);
    check("E4: chain terminal preview id is not_cancelable", rChainTerminal.kind === "not_cancelable");
    check("E5: chain foreign preview id is not_cancelable (never reveals it's a chain)", rChainForeign.kind === "not_cancelable");
    check("E6: chain-terminal and chain-foreign give byte-identical results", JSON.stringify(rChainTerminal) === JSON.stringify(rChainForeign));

    // A random nonexistent id.
    const rNone = await cancelMcpVideoJob(u.id, "totally-made-up-id");
    check("E7: a nonexistent id is not_cancelable, same shape as the rest", JSON.stringify(rNone) === JSON.stringify(rTerminal));
  });

  // ── F: web DELETE route — extraction kept the response byte-identical ─────────────────
  await section("F: web DELETE route delegates to the shared core, unchanged shapes", async () => {
    const routeSource = readFileSync("src/app/api/videos/jobs/[id]/route.ts", "utf8");
    check("F1: DELETE calls the extracted shared core with its original log prefix (A6)",
      routeSource.includes('cancelVideoJobCore(user.id, id, "[api/videos/jobs/:id]")'));
    check("F2: the not_cancelable shape and 409 status are unchanged",
      routeSource.includes('{ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }, { status: 409 }'));
    check("F3: the success shape is unchanged",
      routeSource.includes("{ ok: true, settlementPending: result.settlementPending }"));
    check("F4: the route no longer inlines the settlement imports (moved to the shared core)",
      !routeSource.includes("refundVideoJobFunding") && !routeSource.includes("cancelHeroVoiceGeneration"));
    check("F5 (A5): the route imports the core from its own chain-export-free module",
      routeSource.includes('from "@/lib/mcp/video-job-cancel-core"') && !routeSource.includes('"@/lib/mcp/video-job-cancel"'));
    const coreSource = readFileSync("src/lib/mcp/video-job-cancel-core.ts", "utf8");
    check("F6 (A5): the core itself never imports chain-export (web's import graph is restored)",
      !/from\s+"@\/lib\/mcp\/chain-export"/.test(coreSource));
  });

  // ── G: MCP tool registration ────────────────────────────────────────────────────────
  await section("G: cancel_video_job tool registration", async () => {
    const mcpRoute = readFileSync("src/app/api/[transport]/route.ts", "utf8");
    check("G1: the tool is registered", mcpRoute.includes('"cancel_video_job"'));
    check("G2: it takes a single string id", /cancel_video_job[\s\S]{0,300}inputSchema:\s*\{\s*id:\s*z\.string\(\)\.min\(1\)\s*\}/.test(mcpRoute));
    check("G3: it is wrapped by the owner/plan-gated runTool", /runTool\(\s*"cancel_video_job"/.test(mcpRoute));
    check("G4: it calls the chain-aware cancel helper", mcpRoute.includes("cancelMcpVideoJob(p.userId, args.id)"));
    check("G5: the not_cancelable shape matches the web route's", mcpRoute.includes('{ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }'));
    const descMatch = mcpRoute.match(/"cancel_video_job"[\s\S]{0,400}description:\s*"([^"]+)"/);
    check("G6: the description is Thai and factual", !!descMatch && /[ก-๙]/.test(descMatch[1]) && descMatch[1].length < 220);
  });

  // ── H: A1 — the preview-finish race falls through instead of a false not_cancelable ────
  await section("H: A1 (fix round 1) — preview-finish race falls through", async () => {
    // Variant 1: the preview finishes (for real) between our read and the core's updateMany,
    // and no export has been enqueued yet — cancelMcpVideoJob must fall through to the gap
    // marker, not report a false "already finished, cannot cancel".
    const u1 = await makeUser();
    const proj1 = await makeProject(u1.id);
    const preview1 = await makeChainPreview(u1.id, proj1.id, { status: "processing", finishedAt: null });
    await prisma.editorProject.update({ where: { id: proj1.id }, data: { activeJobId: preview1.id, status: "rendering" } });

    const restore1 = hideOnce(
      prisma.videoJob as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
      "updateMany",
      (args) => {
        const a = args[0] as { where?: { id?: string }; data?: { status?: string } };
        return a?.where?.id === preview1.id && a?.data?.status === "canceled";
      },
      async (original) => {
        // The real race: the preview's own finish commits first, through the genuine
        // updateMany call (unpatched), so the core's own conditional update below
        // naturally matches zero rows — exactly like a concurrent finish winning.
        await original({ where: { id: preview1.id }, data: { status: "done", finishedAt: new Date() } });
      },
    );
    let r1: Awaited<ReturnType<typeof cancelMcpVideoJob>>;
    try {
      r1 = await cancelMcpVideoJob(u1.id, preview1.id);
    } finally {
      restore1();
    }
    check("H1: falls through to the gap marker instead of a false not_cancelable", r1.kind === "canceled" && r1.settlementPending === false);
    const row1 = await prisma.videoJob.findUniqueOrThrow({ where: { id: preview1.id } });
    check("H2: the preview itself is untouched by OUR cancel — it really finished on its own", row1.status === "done" && row1.errorMessage === null);
    check("H3: a canceled marker now holds the chain key (nothing was ever created to settle)", await keyRowCount(u1.id, preview1.id) === 1);

    // Variant 2: by the time we re-resolve, the chain's own post-finish enqueue has ALSO
    // already run and the export is for real in flight — cancelMcpVideoJob must cancel it.
    const u2 = await makeUser();
    const proj2 = await makeProject(u2.id);
    const preview2 = await makeChainPreview(u2.id, proj2.id, { status: "processing", finishedAt: null });
    await prisma.editorProject.update({ where: { id: proj2.id }, data: { activeJobId: preview2.id, status: "rendering" } });

    const restore2 = hideOnce(
      prisma.videoJob as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
      "updateMany",
      (args) => {
        const a = args[0] as { where?: { id?: string }; data?: { status?: string } };
        return a?.where?.id === preview2.id && a?.data?.status === "canceled";
      },
      async (original) => {
        await original({ where: { id: preview2.id }, data: { status: "done", finishedAt: new Date() } });
        await makeChainExport(u2.id, preview2.id, proj2.id, "processing");
      },
    );
    let r2: Awaited<ReturnType<typeof cancelMcpVideoJob>>;
    try {
      r2 = await cancelMcpVideoJob(u2.id, preview2.id);
    } finally {
      restore2();
    }
    check("H4: falls through and cancels the now-real in-flight export", r2.kind === "canceled" && r2.settlementPending === false);
    const exportRow2 = await prisma.videoJob.findFirst({ where: { userId: u2.id, idempotencyKey: mcpChainExportKey(preview2.id) } });
    check("H5: the export row (a real row, not a marker) is canceled", exportRow2?.status === "canceled" && exportRow2?.type === "export");
    check("H6: exactly one row holds the key — no duplicate enqueue", await keyRowCount(u2.id, preview2.id) === 1);
  });

  // ── I: A2 — the enqueue-wins gap race never strands the project on "exporting" ─────────
  await section("I: A2 (fix round 1) — enqueue's project write skips a canceled export", async () => {
    const u = await makeUser();
    const proj = await makeProject(u.id);
    const preview = await makeEnqueueReadyPreview(u.id, proj.id);

    // The project write lives inside a NEW transaction client (`tx`, a separate Prisma
    // Client instance `enqueueMcpChainExport` constructs via `prisma.$transaction`), so a
    // patch on `prisma.editorProject.updateMany` never sees it. Patch `$transaction` itself
    // instead — but `enqueueMcpChainExport` itself already runs two EARLIER unrelated
    // transactions first (createEditorProject's revision check, createVideoJob's funding
    // reservation), so `when` matches on the target callback's own source text (tsx's
    // transform keeps it readable) rather than taking the first `$transaction` call blindly.
    // Before the real transaction starts (which re-reads the export's status from the
    // committed DB), commit a real concurrent cancel of the just-inserted export — the same
    // interleaving as K, one step later.
    const restore = hideOnce(
      prisma as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
      "$transaction",
      (args) => String(args[0]).includes("activeExportJobId"),
      async () => {
        const freshKey = await prisma.videoJob.findFirst({
          where: { userId: u.id, idempotencyKey: mcpChainExportKey(preview.id) },
          select: { id: true },
        });
        if (freshKey) await cancelVideoJobCore(u.id, freshKey.id);
      },
    );
    let result: Awaited<ReturnType<typeof enqueueMcpChainExport>>;
    try {
      result = await enqueueMcpChainExport({ previewJobId: preview.id, userId: u.id });
    } finally {
      restore();
    }
    check("I1: the enqueue still reports the export it created", result.kind === "enqueued");
    const exportRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: (result as { exportJobId: string }).exportJobId } });
    check("I2: the export itself is canceled (the race's cancel won)", exportRow.status === "canceled");
    const projAfter = await prisma.editorProject.findUniqueOrThrow({ where: { id: proj.id } });
    check("I3: the project never lands on \"exporting\" pointing at the canceled export", projAfter.status !== "exporting");
    check("I4: the project's activeExportJobId was never set to the canceled export", projAfter.activeExportJobId !== exportRow.id);
  });

  // ── J: A3 — MCP read-path cancel copy is one fixed Thai sentence ──────────────────────
  await section("J: A3 (fix round 1) — get_video_status cancel copy", async () => {
    const CANCEL_COPY = "งานนี้ถูกยกเลิกแล้ว";

    // A real-row cancel (export half canceled while in flight).
    const u1 = await makeUser();
    const proj1 = await makeProject(u1.id);
    const preview1 = await makeChainPreview(u1.id, proj1.id, { status: "done" });
    const export1 = await makeChainExport(u1.id, preview1.id, proj1.id, "processing");
    const r1 = await cancelMcpVideoJob(u1.id, preview1.id);
    check("J1: the real-row cancel succeeded", r1.kind === "canceled");
    const status1 = await getVideoJobStatusTool(u1.id, preview1.id) as { status?: string; error?: string | null } | null;
    check("J2: get_video_status.error is the one fixed Thai sentence (real-row cancel)", status1?.status === "canceled" && status1?.error === CANCEL_COPY);
    const row1 = await prisma.videoJob.findUniqueOrThrow({ where: { id: export1.id } });
    check("J3: the stored errorMessage is UNCHANGED (web still reads this verbatim)", row1.errorMessage === "canceled by user (editor v2)");

    // The gap marker.
    const u2 = await makeUser();
    const proj2 = await makeProject(u2.id);
    const preview2 = await makeChainPreview(u2.id, proj2.id, { status: "done" });
    const r2 = await cancelMcpVideoJob(u2.id, preview2.id);
    check("J4: the gap cancel succeeded", r2.kind === "canceled");
    const status2 = await getVideoJobStatusTool(u2.id, preview2.id) as { status?: string; error?: string | null } | null;
    check("J5: get_video_status.error is the SAME fixed Thai sentence (gap marker)", status2?.status === "canceled" && status2?.error === CANCEL_COPY);
    const marker2 = await prisma.videoJob.findFirst({ where: { userId: u2.id, idempotencyKey: mcpChainExportKey(preview2.id) } });
    check("J6: the marker's own errorMessage is UNCHANGED", marker2?.errorMessage === "canceled by user (mcp)");

    // A plain (non-chain) job's canceled status is untouched by A3 — only the chain path.
    const u3 = await makeUser();
    const job3 = await makeJob(u3.id, { status: "queued" });
    await cancelVideoJobCore(u3.id, job3.id);
    const status3 = await getVideoJobStatusTool(u3.id, job3.id) as { status?: string; error?: string | null } | null;
    check("J7: a plain job's canceled status still reads its raw errorMessage (A3 is chain-only)",
      status3?.status === "canceled" && status3?.error === "canceled by user (editor v2)");
  });

  // ── K: A4 — the marker-loses "exists" branch, reproduced deterministically ─────────────
  await section("K: A4 (fix round 1) — the gap-cancel marker loses to a real concurrent enqueue", async () => {
    const u = await makeUser();
    const proj = await makeProject(u.id);
    const preview = await makeChainPreview(u.id, proj.id, { status: "done" });

    const restore = hideOnce(
      prisma.videoJob as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
      "create",
      (args) => {
        const a = args[0] as { data?: { idempotencyKey?: string } };
        return a?.data?.idempotencyKey === mcpChainExportKey(preview.id);
      },
      async (original) => {
        // Simulate a concurrent real enqueue winning the race: insert the real export row
        // FIRST (through the unpatched create), so the marker's own create attempt right
        // after this hits the genuine unique-constraint P2002 and returns "exists".
        await original({
          data: {
            userId: u.id,
            type: "export",
            status: "processing",
            projectId: proj.id,
            inputJson: JSON.stringify({ mode: "export", sourceJobId: preview.id, mcpChainExport: true }),
            idempotencyKey: mcpChainExportKey(preview.id),
          },
        });
      },
    );
    let r: Awaited<ReturnType<typeof cancelMcpVideoJob>>;
    try {
      r = await cancelMcpVideoJob(u.id, preview.id);
    } finally {
      restore();
    }
    check("K1: the exists branch still cancels the real (now-visible) export", r.kind === "canceled" && r.settlementPending === false);
    const exportRow = await prisma.videoJob.findFirst({ where: { userId: u.id, idempotencyKey: mcpChainExportKey(preview.id) } });
    check("K2: exactly one row holds the key and it is the real export, now canceled", exportRow?.status === "canceled" && exportRow?.type === "export");
    check("K3: no duplicate/marker row was created under the key", await keyRowCount(u.id, preview.id) === 1);
  });

  // ── L: A4 — handler-level web DELETE test (stubbed auth) ───────────────────────────────
  await section("L: A4 (fix round 1) — web DELETE handler, stubbed auth, status codes + bodies", async () => {
    const authed = await makeUser();
    const other = await makeUser();
    const owned = await makeJob(authed.id, { status: "queued" });
    const foreign = await makeJob(other.id, { status: "processing" });

    const ctx = mock.module("@/lib/clerk-auth", {
      namedExports: { getCurrentUser: async () => authed },
    });
    let DELETE: typeof import("../src/app/api/videos/jobs/[id]/route").DELETE;
    try {
      ({ DELETE } = await import("../src/app/api/videos/jobs/[id]/route"));

      const res1 = await DELETE(new Request("http://x/api/videos/jobs/" + owned.id, { method: "DELETE" }), {
        params: Promise.resolve({ id: owned.id }),
      });
      const body1 = await res1.json();
      check("L1: canceling an owned queued job → 200 { ok: true, settlementPending: false }",
        res1.status === 200 && JSON.stringify(body1) === JSON.stringify({ ok: true, settlementPending: false }));

      const res2 = await DELETE(new Request("http://x/api/videos/jobs/" + owned.id, { method: "DELETE" }), {
        params: Promise.resolve({ id: owned.id }),
      });
      const body2 = await res2.json();
      check("L2: re-canceling the now-terminal job → 409 not_cancelable", res2.status === 409
        && JSON.stringify(body2) === JSON.stringify({ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }));

      const res3 = await DELETE(new Request("http://x/api/videos/jobs/" + foreign.id, { method: "DELETE" }), {
        params: Promise.resolve({ id: foreign.id }),
      });
      const body3 = await res3.json();
      check("L3: another user's job id → 409, byte-identical to the terminal-id shape (no oracle)",
        res3.status === 409 && JSON.stringify(body3) === JSON.stringify(body2));
      const foreignRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: foreign.id } });
      check("L4: the foreign job itself is untouched", foreignRow.status === "processing");
    } finally {
      ctx.restore();
    }
  });

  // ── M: fix round 2 advisory — canceled export half carries refunded/refundPending ──────
  await section("M: fix round 2 — canceled chain-export-half settlement fields", async () => {
    // A real export canceled AFTER a paid, completed preview: the base charge is kept (the
    // preview row settled, not refunded/none), so the chain must NOT read as refunded.
    const u1 = await makeUser();
    const proj1 = await makeProject(u1.id);
    const preview1 = await makeChainPreview(u1.id, proj1.id, { status: "done" });
    await prisma.videoJob.update({ where: { id: preview1.id }, data: { fundingState: "settled" } });
    const export1 = await makeChainExport(u1.id, preview1.id, proj1.id, "processing");
    const r1 = await cancelMcpVideoJob(u1.id, preview1.id);
    check("M1: the real-row cancel succeeded", r1.kind === "canceled");
    const status1 = await getVideoJobStatusTool(u1.id, preview1.id) as
      { status?: string; refunded?: boolean; refundPending?: boolean } | null;
    check("M2: canceled export half reports refunded: false — the base charge is kept",
      status1?.status === "canceled" && status1?.refunded === false && status1?.refundPending === false,
      JSON.stringify(status1));
    void export1;

    // The gap marker, same paid preview: still nothing to refund FOR THE EXPORT, but the
    // base charge is still kept — refunded must stay false, not flip to true just because
    // the marker row (which was never funded) looks clean on its own.
    const u2 = await makeUser();
    const proj2 = await makeProject(u2.id);
    const preview2 = await makeChainPreview(u2.id, proj2.id, { status: "done" });
    await prisma.videoJob.update({ where: { id: preview2.id }, data: { fundingState: "settled" } });
    const r2 = await cancelMcpVideoJob(u2.id, preview2.id);
    check("M3: the gap cancel succeeded", r2.kind === "canceled");
    const status2 = await getVideoJobStatusTool(u2.id, preview2.id) as
      { status?: string; refunded?: boolean; refundPending?: boolean } | null;
    check("M4: gap-marker cancel still reports refunded: false (base charge kept)",
      status2?.status === "canceled" && status2?.refunded === false && status2?.refundPending === false,
      JSON.stringify(status2));

    // A preview that was NEVER funded (fundingState stays "none", the makeChainPreview
    // fixture default): nothing was ever charged, so the canceled export half IS refunded.
    const u3 = await makeUser();
    const proj3 = await makeProject(u3.id);
    const preview3 = await makeChainPreview(u3.id, proj3.id, { status: "done" });
    const export3 = await makeChainExport(u3.id, preview3.id, proj3.id, "processing");
    const r3 = await cancelMcpVideoJob(u3.id, preview3.id);
    check("M5: the real-row cancel succeeded", r3.kind === "canceled");
    const status3 = await getVideoJobStatusTool(u3.id, preview3.id) as
      { status?: string; refunded?: boolean; refundPending?: boolean } | null;
    check("M6: an unfunded preview's canceled export half reports refunded: true",
      status3?.status === "canceled" && status3?.refunded === true && status3?.refundPending === false,
      JSON.stringify(status3));
    void export3;

    // Scope check: a still-IN-FLIGHT export (not canceled) carries no refunded/refundPending
    // at all — these fields are specific to the canceled-export-half case added here.
    const u4 = await makeUser();
    const proj4 = await makeProject(u4.id);
    const preview4 = await makeChainPreview(u4.id, proj4.id, { status: "done" });
    await makeChainExport(u4.id, preview4.id, proj4.id, "processing");
    const status4 = await getVideoJobStatusTool(u4.id, preview4.id) as
      { status?: string; refunded?: boolean; refundPending?: boolean } | null;
    check("M7: an in-flight (not canceled) export half carries no refunded/refundPending keys",
      status4?.status === "processing" && !("refunded" in (status4 ?? {})) && !("refundPending" in (status4 ?? {})),
      JSON.stringify(status4));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
