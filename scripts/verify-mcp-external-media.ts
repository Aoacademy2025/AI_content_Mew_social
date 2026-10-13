/* eslint-disable @typescript-eslint/no-explicit-any -- fixture inspects heterogeneous public tool/worker JSON, asserted at each boundary */
/** External ordinary-USER path. Real quote, worker, placeholders, shared editor/export model.
 * TTS/render/composite and URL transport are stubs; imports use real ffmpeg and upload PUT. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "mcp-external-"));
mkdirSync(join(dir, "temp")); process.env.TMPDIR = join(dir, "temp");
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.MINUTE_QUOTA = "1"; process.env.CREDITS_LIVE = "1";
process.env.MCP_EDITOR_PROJECT_PUBLIC = "1"; process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT = "1";
process.env.RENDER_VIA_QUEUE = "1";
globalThis.fetch = async () => { throw new Error("External network forbidden"); };
execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { stdio: "pipe", env: process.env });
const rendersRoot = join(dir, "renders"); mkdirSync(rendersRoot);
let failed = 0;
function check(name: string, value: unknown) { if (!value) { failed++; console.error(`FAIL ${name}`); } else console.log(`PASS ${name}`); }
const captions = Array.from({ length: 4 }, (_, i) => ({ text: `ประโยคที่ ${i + 1} วันนี้เรามาเรียนรู้สิ่งใหม่ด้วยกัน`, startMs: i * 4000, endMs: (i + 1) * 4000, tag: i === 0 ? "hook" : "body" }));
const SCRIPT = captions.map(c => c.text).join(" ");
async function main() {
 const { prisma } = await import("../src/lib/prisma");
 const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
 const { prepareVideoQuote, decideVideoQuote } = await import("../src/lib/mcp/video-quote.server");
 const { consumeVideoQuote } = await import("../src/lib/mcp/video-budget.server");
 const { transferVideoJobFundingToRender } = await import("../src/lib/mcp/video-job-funding");
 const { recordChargedClip, isBurnAlreadyPaid } = await import("../src/lib/clip-charge");
 const { rerenderSkipEligible } = await import("../src/lib/broll-rerender");
 const edit = await import("../src/lib/mcp/edit-tools");
 const draft = await import("../src/lib/mcp/pending-edit-draft");
 const { enqueueEditorExport, enqueueBrollRerender } = await import("../src/lib/editor-export-enqueue");
 const { getFfmpegPath } = await import("../src/lib/ffmpeg-path");
 const { createMediaImportLane } = await import("../src/lib/media-import/lane");
 const { createUploadUrlTool } = await import("../src/lib/mcp/media-import-tools");
 const uploadRoute = await import("../src/app/api/mcp-uploads/[token]/route");
 const { mediaImportTempDir } = await import("../src/lib/media-import/fetch");
 const { normalizeWebPendingEdit, webPendingWindowEdits } = await import("../src/app/(dashboard)/video-editor/_v2/pending-edit-view");
 const ff = (args: string[]) => execFileSync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
 ff(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", join(dir, "image.png")]);
 ff(["-f", "lavfi", "-i", "testsrc=size=90x160:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "video.mp4")]);
 const stocksDir = join(dir, "stocks"); mkdirSync(stocksDir);
 const importedAssets: Array<{ id: string; resultSrc: string; kind: "image" | "video" }> = [];
 async function runLane() {
  const lane = createMediaImportLane({ pollMs: 10, watchdogMs: 3600000, stocksDir, fetchMedia: async (url, options) => {
   const kind = url.endsWith(".png") ? "image" : "video"; const ext = kind === "image" ? "png" : "mp4";
   assert.ok(options.accept[kind]); const bytes = readFileSync(join(dir, `${kind}.${ext}`));
   const temp = mediaImportTempDir(); mkdirSync(temp, { recursive: true, mode: 0o700 });
   const path = join(temp, `media-import-${randomUUID()}.${ext}`); writeFileSync(path, bytes, { mode: 0o600 });
   return { path, kind, ext, mime: kind === "image" ? "image/png" : "video/mp4", bytes: bytes.length };
  }, log: { info: () => {}, error: console.error } });
  lane.start(); const deadline = Date.now() + 120000;
  while (Date.now() < deadline && (await prisma.mediaImport.count({ where: { status: { in: ["pending", "processing"] } } }) || lane.inFlight)) await new Promise(r => setTimeout(r, 30));
  await lane.stop();
 }
 const user = await prisma.user.create({ data: { email: "external@example.test", name: "External owner", role: "USER", plan: "PRO", minutesLimit: 100, usagePeriodStartedAt: new Date(), planExpiresAt: new Date(Date.now() + 86400000), geminiKey: "fixture" } });
 await prisma.payment.create({ data: { userId: user.id, stripeSessionId: "external-paid", plan: "PRO", amount: 100, status: "PAID", paidAt: new Date() } });
 await prisma.creditBalance.create({ data: { userId: user.id, purchased: 100 } });
 const presenter = await prisma.mediaImport.create({ data: { userId: user.id, purpose: "presenter", source: "upload", status: "ready", resultSrc: "/api/renders/presenter.mp4", durationMs: 16000, deadlineAt: new Date(Date.now() + 86400000) } });
 const fixtureRequire = createRequire(join(process.cwd(), "scripts/verify-mcp-external-media.ts"));
 const projectRoutePath = "src/app/api/editor-projects/[id]/route.ts";
 const projectModule = { exports: {} as { GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> } };
 new Function("require", "module", "exports", ts.transpileModule(readFileSync(projectRoutePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: projectRoutePath }).outputText)((id: string) => {
  if (id === "@/lib/clerk-auth") return { getCurrentUser: async () => user };
  return fixtureRequire(id.startsWith("@/") ? join(process.cwd(), "src", id.slice(2)) : id);
 }, projectModule, projectModule.exports);
 const configRoutePath = "src/app/api/videos/generate-config/route.ts";
 const configModule = { exports: {} as { POST: (r: Request) => Promise<Response> } };
 new Function("require", "module", "exports", ts.transpileModule(readFileSync(configRoutePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: configRoutePath }).outputText)((id: string) => {
  if (id === "@/lib/clerk-auth") return { getCurrentUser: async () => user };
  return fixtureRequire(id.startsWith("@/") ? join(process.cwd(), "src", id.slice(2)) : id);
 }, configModule, configModule.exports);
 async function readWebProject(id: string) {
  const response = await projectModule.exports.GET(new Request(`https://studio.example.test/api/editor-projects/${id}`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200); return (await response.json()).project;
 }
 let seq = 0, stockCalls = 0;
 const caller = {
  async post<T>(path: string, body?: unknown): Promise<T> {
   const b = body as Record<string, any>;
   if (path.includes("fetch-stock") || path.includes("generate-image")) { stockCalls++; throw new Error("Forbidden provider"); }
   if (path.includes("tts")) return { voiceUrl: "/api/renders/voice.wav", audioDurationMs: 16000, timing: { provider: "gemini", segments: captions.map(c => ({ text: c.text, startMs: c.startMs, durationMs: c.endMs-c.startMs })), chars: null } } as T;
   if (path.endsWith("split-script")) return { cards: null } as T;
   if (path.endsWith("transcribe")) return { captions, fullText: SCRIPT, words: captions.map(c => ({ word: c.text, startMs: c.startMs, endMs: c.endMs })), audioDurationMs: 16000, speechCoverage: { source: "silence_analysis", spokenEndMs: 16000 } } as T;
   if (path.endsWith("generate-config")) {
    const response = await configModule.exports.POST(new Request("https://studio.example.test/api/videos/generate-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as T;
   }
   if (path.endsWith("/render")) {
    const burn = !!b.subtitleOverlayConfig;
    const id = `external-render-${++seq}`; const videoUrl = `/api/renders/${id}.mp4`;
    let free = burn && await isBurnAlreadyPaid(user.id, b.subtitleOverlayConfig.videoUrl);
    if (b.rerenderOf) { const src = await prisma.videoJob.findUniqueOrThrow({ where: { id: b.rerenderOf.sourceJobId } }); const output = JSON.parse(src.outputJson!); free = await isBurnAlreadyPaid(user.id, output.videoUrl) && rerenderSkipEligible({ sourceConfig: output.preview.config, incomingConfig: b.shortVideoConfig }); }
    if (!free) { const transfer = await transferVideoJobFundingToRender(b.parentJobId, user.id, 1); assert.ok(transfer.transferred); }
    await prisma.renderJob.create({ data: { id, userId: user.id, parentJobId: b.parentJobId, type: burn ? "BURN" : "RENDER", status: "DONE", payload: "{}", videoUrl, reservedQuota: !free, reservedMinutes: free ? null : 1 } });
    await recordChargedClip(user.id, videoUrl, free ? 0 : 1); writeFileSync(join(rendersRoot, `${id}.mp4`), "fixture"); return { jobId: id } as T;
   }
   if (path.endsWith("/composite")) { const videoUrl = `/api/renders/composite-${++seq}.mp4`; await recordChargedClip(user.id, videoUrl, 0); writeFileSync(join(rendersRoot, `composite-${seq}.mp4`), "fixture"); return { videoUrl } as T; }
   if (path === "/api/videos") return { id: `gallery-${++seq}` } as T;
   throw new Error(`Unexpected POST ${path}`);
  },
  async get<T>(path: string): Promise<T> { const id = new URL(path, "http://fixture").searchParams.get("jobId")!; const r = await prisma.renderJob.findUniqueOrThrow({ where: { id } }); return { progress: 100, videoUrl: r.videoUrl, error: null, stage: "done" } as T; },
  async patch<T>(): Promise<T> { return {} as T; },
 };
 for (const mode of ["script", "presenter"] as const) {
  const q = await prepareVideoQuote(user, { ...(mode === "script" ? { script: SCRIPT } : { clipUploadId: presenter.id }), brollSource: "external" });
  assert.ok("quoteId" in q, JSON.stringify(q)); assert.equal(q.imageCreditCeiling, 0);
  await decideVideoQuote(user.id, q.quoteId, "approve"); const created = await consumeVideoQuote(user.id, q.quoteId); assert.ok(created.jobId, JSON.stringify(created));
  await prisma.videoJob.update({ where: { id: created.jobId }, data: { status: "processing" } });
  await runOrchestrator(created.jobId, user.id, { caller, sleep: async () => {}, refundOneClip: async () => {}, rendersRoot });
  const root = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } }); assert.equal(root.status, "done", String(root.errorMessage));
  const output = JSON.parse(root.outputJson!); const config = output.preview.config;
  check(`${mode}: held usable windows`, config.bgVideos.length >= 2 && JSON.parse(root.inputJson).mcpHold === true);
  check(`${mode}: durable external policy`, config.externalMedia?.source === "external");
  await prisma.editorProject.update({ where: { id: root.projectId! }, data: { draftJson: JSON.stringify({ stockSource: "both", brollSource: "stock", externalMedia: { slots: [] } }) } });
  const opened = await readWebProject(root.projectId!);
  check(`${mode}: web source survives hostile draft reset`, opened.draft.stockSource === "none" && opened.draft.brollSource === "external");
  const states = await edit.getEditStateTool(user.id, root.id) as any;
  check(`${mode}: required slots reported`, states.windows?.some((w: any) => w.required && w.state === "unfilled"));
  if (mode === "script") check("faceless first window is B-roll", states.windows?.[0]?.owner === "broll");
  const refused = await edit.exportVideoTool(user, root.id) as any;
  check(`${mode}: empty required export refused`, refused.error === "external_media_required" && refused.next && refused.windowIndices?.length);
  const rawExport = await prisma.videoJob.create({ data: { userId: user.id, projectId: root.projectId, type: "export", status: "processing", inputJson: JSON.stringify({ mode: "export", sourceJobId: root.id, subtitleOverlayConfig: { videoUrl: output.videoUrl, durationInFrames: 480, externalMedia: { slots: [] } } }) } });
  await runOrchestrator(rawExport.id, user.id, { caller, sleep: async () => {}, refundOneClip: async () => {}, rendersRoot });
  const rawDone = await prisma.videoJob.findUniqueOrThrow({ where: { id: rawExport.id } });
  check(`${mode}: direct worker burn bypass refused`, rawDone.status === "failed" && rawDone.errorCode === "external_media_required");
  const direct = await enqueueEditorExport({ user, brandVisualAccess: { canUse: false }, sourceJobId: root.id, subtitleOverlayConfig: { videoUrl: output.videoUrl, durationInFrames: 480, externalMedia: { slots: [] }, bgVideos: [{ src: "/api/stocks/forged.mp4" }] }, idempotencyKey: `hostile-${mode}` });
  check(`${mode}: web hostile overlay cannot bypass`, !direct.ok && direct.error === "external_media_required");
  if (mode === "script") {
   const imported = await prisma.mediaImport.create({ data: { userId: user.id, purpose: "broll_image", source: "upload", status: "ready", resultSrc: "/api/stocks/owned-image.mp4", durationMs: 5000, deadlineAt: new Date(Date.now() + 86400000) } });
   await edit.replaceBrollWindowTool(user, { jobId: root.id, windowIndex: 0, uploadId: imported.id });
   const project = await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } });
   const resolved = (draft as any).pendingEditForWebResolved;
   const web = resolved ? await resolved(user.id, project) : draft.pendingEditForWeb(project);
   check("web projects owned ready pending replacements", web?.draft?.windowEdits?.[0]?.src === imported.resultSrc);
  }
  // Each external mode consumes the same four real owned imports, through shared edits.
  const required = config.externalMedia.slots.filter((w: any) => w.required).map((w: any) => w.index) as number[];
  if (mode === "script") {
   for (const transport of ["url", "upload"] as const) for (const kind of ["image", "video"] as const) {
    const index = required[importedAssets.length % required.length]; let id: string;
    if (transport === "url") {
     const reply = await edit.replaceBrollWindowTool(user, { jobId: root.id, windowIndex: index, url: `https://media.example/${kind}.${kind === "image" ? "png" : "mp4"}` }) as any;
     assert.equal(reply.ok, true, JSON.stringify(reply)); id = reply.importId;
    } else {
     const link = await createUploadUrlTool(user.id, { kind }); assert.ok("uploadId" in link);
     id = link.uploadId; const token = new URL(link.uploadUrl).pathname.split("/").pop()!;
     const bytes = readFileSync(join(dir, `${kind}.${kind === "image" ? "png" : "mp4"}`));
     const response = await uploadRoute.PUT(new Request(link.uploadUrl, { method: "PUT", headers: { "content-length": String(bytes.length) }, body: new Uint8Array(bytes) }), { params: Promise.resolve({ token }) });
     assert.equal(response.status, 202, await response.clone().text());
     const replay = await uploadRoute.PUT(new Request(link.uploadUrl, { method: "PUT", body: new Uint8Array(bytes) }), { params: Promise.resolve({ token }) });
     check(`${kind}: upload token one-use`, replay.status >= 400);
     const reply = await edit.replaceBrollWindowTool(user, { jobId: root.id, windowIndex: index, uploadId: id }) as any; assert.equal(reply.ok, true, JSON.stringify(reply));
    }
    const pending = await edit.exportVideoTool(user, root.id) as any;
    check(`${transport}-${kind}: pending refuses export`, pending.error === "external_media_required");
    const before = await draft.pendingEditForWebResolved(user.id, await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } }));
    check(`${transport}-${kind}: web sees pending`, before?.draft.windowMedia?.some(w => w.index === index && w.status === "pending"));
    await runLane(); const row = await prisma.mediaImport.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, "ready", String(row.errorCode)); assert.ok(row.resultSrc);
    importedAssets.push({ id, resultSrc: row.resultSrc, kind });
    check(`${transport}-${kind}: real import normalized`, readFileSync(join(stocksDir, row.resultSrc.split("/").pop()!)).length > 100);
   }
  }
  for (const [i, index] of required.entries()) {
   const imported = importedAssets[i % importedAssets.length];
   const reply = await edit.replaceBrollWindowTool(user, { jobId: root.id, windowIndex: index, uploadId: imported.id }) as any; assert.equal(reply.ok, true, JSON.stringify(reply));
  }
  const project = await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } });
  const web = await draft.pendingEditForWebResolved(user.id, project);
  const parsedWeb = normalizeWebPendingEdit(web); const local = webPendingWindowEdits(parsedWeb?.draft ?? null);
  check(`${mode}: shared web projection parity`, local.size === required.length && [...local.values()].every(w => !!w.src));
  const preApply = await enqueueEditorExport({ user, brandVisualAccess: { canUse: false }, sourceJobId: root.id, subtitleOverlayConfig: { videoUrl: output.videoUrl, durationInFrames: 480 }, idempotencyKey: `unapplied-${mode}` });
  check(`${mode}: direct export cannot skip ready pending edits`, !preApply.ok && preApply.error === "external_media_required");
  // Corrupt/foreign/missing import identity never satisfies a required slot or leaks its src.
  const targetIndex = required[0];
  const storedBefore = draft.parsePendingEditDraft(project.pendingEditJson)!;
  for (const status of ["pending", "failed"] as const) {
   await prisma.mediaImport.update({ where: { id: importedAssets[0].id }, data: { status, errorCode: status === "failed" ? "fetch_failed" : null } });
   const rejected = await edit.exportVideoTool(user, root.id) as any;
   check(`${mode}: ${status} import refuses`, rejected.error === "external_media_required" && rejected.windowIndices.includes(targetIndex));
   const webFailure = await draft.pendingEditForWebResolved(user.id, project);
   check(`${mode}: web reports ${status}`, webFailure?.draft.windowMedia?.some(w => w.index === targetIndex && w.status === status));
  }
  await prisma.mediaImport.update({ where: { id: importedAssets[0].id }, data: { status: "ready", errorCode: null } });
  const foreign = await prisma.user.create({ data: { email: `foreign-${mode}@example.test`, name: "Foreign" } });
  const foreignImport = await prisma.mediaImport.create({ data: { userId: foreign.id, purpose: "broll_video", source: "upload", status: "ready", resultSrc: "/api/stocks/foreign.mp4", durationMs: 5000, deadlineAt: new Date() } });
  for (const id of ["missing-import", foreignImport.id]) {
   const now = await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } });
   const changed = { ...storedBefore, windowEdits: storedBefore.windowEdits.map(w => w.index === targetIndex ? { ...w, importId: id } : w) };
   assert.ok(await draft.savePendingEditDraft(user.id, root.projectId!, now.pendingEditRevision, changed));
   const rejected = await edit.exportVideoTool(user, root.id) as any;
   check(`${mode}: missing/foreign import refuses`, rejected.error === "external_media_required" && rejected.windowIndices.includes(targetIndex));
   const view = await draft.pendingEditForWebResolved(user.id, await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } }));
   check(`${mode}: unavailable foreign path not exposed`, !JSON.stringify(view).includes("foreign.mp4"));
  }
  const restore = await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } });
  assert.ok(await draft.savePendingEditDraft(user.id, root.projectId!, restore.pendingEditRevision, storedBefore));
  project.pendingEditRevision = restore.pendingEditRevision + 1;
  const foreignApply = await enqueueBrollRerender({ user, sourceJobId: root.id, windowEdits: [{ index: targetIndex, src: foreignImport.resultSrc, enabled: true }], expectedPendingRevision: project.pendingEditRevision, idempotencyKey: `foreign-web-${mode}` });
  check(`${mode}: web cannot borrow foreign ready source`, !foreignApply.ok && foreignApply.error === "external_media_required");
  if (mode === "presenter") {
   const hook = await edit.replaceBrollWindowTool(user, { jobId: root.id, windowIndex: 0, uploadId: importedAssets[0].id }) as any;
   check("actual presenter hook protected", hook.error === "window_locked_presenter_hook");
  }
  const beforeMinutes = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).minutesUsed;
  let rrId: string;
  if (mode === "script") {
   const reply = await edit.exportVideoTool(user, root.id) as any; assert.equal(reply.status, "rerendering", JSON.stringify(reply)); rrId = reply.rerenderJobId;
  } else {
   const stale = await enqueueBrollRerender({ user, sourceJobId: root.id, windowEdits: web!.draft.windowEdits, expectedPendingRevision: project.pendingEditRevision - 1, idempotencyKey: "stale-web-apply" });
   check("web Apply CAS refuses stale revision", !stale.ok && stale.error === "stale_revision");
   const apply = await enqueueBrollRerender({ user, sourceJobId: root.id, windowEdits: web!.draft.windowEdits, expectedPendingRevision: project.pendingEditRevision, idempotencyKey: "web-apply" }); assert.ok(apply.ok, JSON.stringify(apply)); rrId = apply.job.id;
  }
  await prisma.videoJob.update({ where: { id: rrId }, data: { status: "processing" } });
  await runOrchestrator(rrId, user.id, { caller, sleep: async () => {}, refundOneClip: async () => {}, rendersRoot });
  const rr = await prisma.videoJob.findUniqueOrThrow({ where: { id: rrId } }); assert.equal(rr.status, "done", String(rr.errorMessage));
  const rrPreview = JSON.parse(rr.outputJson!).preview;
  check(`${mode}: rerender preserves policy and imported assets`, rrPreview.config.externalMedia.slots.length === config.externalMedia.slots.length && required.every((index, i) => rrPreview.config.bgVideos[index].src === importedAssets[i % importedAssets.length].resultSrc));
  const reopened = await draft.pendingEditForWebResolved(user.id, await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } }));
  check(`${mode}: reopen after apply keeps rendered requirements`, reopened?.draft.requiredWindows?.filter(w => w.required).every(w => w.state === "ready"));
  let ex = await prisma.videoJob.findFirst({ where: { userId: user.id, type: "export", status: "queued", inputJson: { contains: rrId } } });
  if (!ex) {
   const projectNow = await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } });
   const stored = draft.parsePendingEditDraft(projectNow.pendingEditJson)!;
   const result = await enqueueEditorExport({ user, brandVisualAccess: { canUse: false }, sourceJobId: rrId, subtitleOverlayConfig: draft.toBurnConfig(stored, { videoUrl: JSON.parse(rr.outputJson!).videoUrl, preview: rrPreview }), editorSnapshot: draft.toEditorSnapshotDraft(stored), expectedPendingRevision: projectNow.pendingEditRevision, idempotencyKey: `web-export-${mode}` }); assert.ok(result.ok, JSON.stringify(result)); ex = result.job;
  }
  await prisma.videoJob.update({ where: { id: ex.id }, data: { status: "processing" } });
  await runOrchestrator(ex.id, user.id, { caller, sleep: async () => {}, refundOneClip: async () => {}, rendersRoot });
  const completed = await prisma.videoJob.findUniqueOrThrow({ where: { id: ex.id } });
  check(`${mode}: export succeeds`, completed.status === "done");
  check(`${mode}: budget context follows descendants`, completed.budgetQuoteId === root.budgetQuoteId && rr.budgetQuoteId === root.budgetQuoteId);
  check(`${mode}: free edit/export ledger`, (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).minutesUsed === beforeMinutes);
  const again = await edit.exportVideoTool(user, root.id) as any;
  check(`${mode}: re-export accepted with required policy`, typeof again.exportJobId === "string");
  if (again.exportJobId) {
   await prisma.videoJob.update({ where: { id: again.exportJobId }, data: { status: "processing" } });
   await runOrchestrator(again.exportJobId, user.id, { caller, sleep: async () => {}, refundOneClip: async () => {}, rendersRoot });
   check(`${mode}: re-export done/free`, (await prisma.videoJob.findUniqueOrThrow({ where: { id: again.exportJobId } })).status === "done" && (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).minutesUsed === beforeMinutes);
  }
  const reset = await edit.replaceBrollWindowTool(user, { jobId: root.id, windowIndex: required[0], source: "original" }) as any; check(`${mode}: original reset accepted`, reset.ok);
  const resetExport = await edit.exportVideoTool(user, root.id) as any; check(`${mode}: original does not waive requirement`, resetExport.error === "external_media_required");
  await edit.discardEditsTool(user.id, root.id);
  const afterDiscard = await edit.getEditStateTool(user.id, root.id) as any;
  check(`${mode}: discard preserves required policy`, afterDiscard.windows.filter((w: any) => w.required).length === required.length);
  // Remove accidental baseline exports so the second fixture can run without inflight cap.
  await prisma.videoJob.updateMany({ where: { userId: user.id, status: "queued" }, data: { status: "canceled" } });
 }
 const optionalQuote = await prepareVideoQuote(user, { clipUploadId: presenter.id, brollSource: "external", cutawayLayout: "fillYourself" });
 assert.ok("quoteId" in optionalQuote); await decideVideoQuote(user.id, optionalQuote.quoteId, "approve");
 const optionalJob = await consumeVideoQuote(user.id, optionalQuote.quoteId); assert.ok(optionalJob.jobId);
 await prisma.videoJob.update({ where: { id: optionalJob.jobId }, data: { status: "processing" } });
 await runOrchestrator(optionalJob.jobId, user.id, { caller, sleep: async () => {}, refundOneClip: async () => {}, rendersRoot });
 const optionalState = await edit.getEditStateTool(user.id, optionalJob.jobId) as any;
 check("explicit fillYourself presenter spans stay valid", optionalState.windows.every((w: any) => w.owner === "presenter" && !w.required));
 const optionalExport = await edit.exportVideoTool(user, optionalJob.jobId) as any;
 check("explicit presenter-owned spans export without mandatory imports", typeof optionalExport.exportJobId === "string");
 check("zero stock/image calls", stockCalls === 0);
 check("zero image-generation ledger", await prisma.aiGenerationJob.count({ where: { userId: user.id } }) === 0);
 await prisma.$disconnect();
 if (failed) throw new Error(`${failed} external media regressions`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => rmSync(dir, { recursive: true, force: true }));
