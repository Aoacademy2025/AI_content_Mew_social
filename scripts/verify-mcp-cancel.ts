// verify-mcp-cancel.ts — T10 (ADR 0063): cancel_video_job.
//
// Plan: docs/plans/2026-10-01-mcp-upgrade-p0-p1.md (T10). The web DELETE
// /api/videos/jobs/[id] cancel body is extracted into a shared core
// (src/lib/mcp/video-job-cancel.ts: cancelVideoJobCore) so web behavior stays byte-identical.
// A chain-aware wrapper (cancelMcpVideoJob) in the same file backs the new MCP
// `cancel_video_job({id})` tool: it accepts either the preview or the export id, cancels
// whichever half is in flight, and — when the preview is done but the export was never
// enqueued (the gap) — writes a canceled terminal marker under the chain key so neither
// get_video_status nor the watchdog ever enqueues one afterwards (T8's chain-export.ts).
//
// Self-contained: always builds its own throwaway SQLite, even when DATABASE_URL is preset.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-cancel.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { cancelVideoJobCore, cancelMcpVideoJob } = await import("../src/lib/mcp/video-job-cancel");
  const { mcpChainExportKey } = await import("../src/lib/mcp/chain-key");
  const { resolveMcpChain } = await import("../src/lib/mcp/chain-export");
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

  // ── A: plain (non-chain) job cancel — the extracted web core ──────────────────────────
  await section("A: plain job cancel (web core, byte-identical semantics)", async () => {
    // A1: queued create job, no project → canceled, no settlement needed.
    const u1 = await makeUser();
    const j1 = await makeJob(u1.id, { status: "queued" });
    const r1 = await cancelVideoJobCore(u1.id, j1.id);
    check("A1: queued create job cancels", r1.kind === "canceled" && r1.kind === "canceled" && r1.settlementPending === false);
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
    check("A7: cancel still reports canceled with settlementPending=true", r7.kind === "canceled" && r7.kind === "canceled" && r7.settlementPending === true);
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
    check("F1: DELETE calls the extracted shared core", routeSource.includes("cancelVideoJobCore(user.id, id)"));
    check("F2: the not_cancelable shape and 409 status are unchanged",
      routeSource.includes('{ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }, { status: 409 }'));
    check("F3: the success shape is unchanged",
      routeSource.includes("{ ok: true, settlementPending: result.settlementPending }"));
    check("F4: the route no longer inlines the settlement imports (moved to the shared core)",
      !routeSource.includes("refundVideoJobFunding") && !routeSource.includes("cancelHeroVoiceGeneration"));
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
