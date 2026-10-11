// verify-mcp-edit-persist-export.ts — EP5 backlog #7 / #15 (ADR 0064 "re-exporting starts from
// that Export's edits", ADR 0066 "every draft field survives Export and is readable by the web").
//
// Regression: after `export_video` the headline set by `set_headline_hook` read back as null and a
// second export dropped it; B-roll window replacements read back as `replaced:false`, so the agent
// replayed every `replace_broll_window` before the next export.
//
// Every MCP call goes through the REAL route handler (only Clerk + the network key preflight are
// stubbed — same harness shape as verify-mcp-edit-tools.ts / verify-mcp-broll-window-edits.ts).
// The render stub mirrors /api/videos/render's free paths (burn of a paid base; `rerenderOf` skip)
// and CHARGES anything else, so a regression that leaves the free path shows up as money moving.
// Window media are ready Media Import rows, so no ffmpeg is needed.
//
// Covers:
//   A. headline: export → get_edit_state still shows it; the web reads it from the project draft;
//      a re-export burns it with no replay; discard_edits reseeds to it; other draft keys survive.
//   A2. a headline switched off survives export as off; the web-export G12 clear (no root link)
//      never writes the project draft (the web autosaves its own headline).
//   B. headline concurrency: an edit that lands while the export runs wins (nothing persisted
//      under it); an open web session's stale autosave is refused (stale_revision), never clobbering;
//      a web autosave racing the clear itself makes it retry, and a second race clears nothing.
//   C. windows: export → get_edit_state shows them replaced (pending:false); a re-export keeps
//      them with no replay; a later single-window edit re-renders from the base that carries the
//      earlier replacements; the web resumes onto the replaced windows; source:"original" clears.
//   D. no charge anywhere above.
//
// Self-contained: its own throwaway SQLite.
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-edit-persist-export.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "mcp-edit-persist-export-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "NEXT_PUBLIC_BROLL_WINDOW_EDIT",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
  "MANAGED_GEMINI",
  "GEMINI_SERVER_KEY",
]) delete process.env[key];
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(`\n${name}`);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const CARD0_TEXT = "อยาก กินข้าวเย็นนี้";
const CARD1_TEXT = "ที่ร้านโปรด ของฉัน";
const SCRIPT = `${CARD0_TEXT} ${CARD1_TEXT}`;
const TIMING = {
  provider: "gemini",
  segments: [
    { text: CARD0_TEXT, startMs: 0, durationMs: 2_000 },
    { text: CARD1_TEXT, startMs: 2_000, durationMs: 2_000 },
  ],
};
const VOICE_FILE = "/api/renders/persist-voice.wav";
const ORIGINAL_SRC = ["/api/stocks/persist-original-a.mp4", "/api/stocks/persist-original-b.mp4"];
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: ORIGINAL_SRC[0], start: 0, end: 2, sourceIndex: 0, clipDuration: 4, provider: "pexels" },
    { src: ORIGINAL_SRC[1], start: 2, end: 4, sourceIndex: 1, clipDuration: 4, provider: "pexels" },
  ],
};
const HEADLINE = "พาดหัวที่ต้องอยู่รอด";

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-edit-persist-export.ts"));
  const fromSrc = (p: string) => realRequire(join(ROOT, "src", p));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const { parseVideoJobOutput } = fromSrc("lib/mcp/video-job") as typeof import("../src/lib/mcp/video-job");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { isBurnAlreadyPaid, recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const { rerenderSkipEligible } = fromSrc("lib/broll-rerender") as typeof import("../src/lib/broll-rerender");
  const budget = fromSrc("lib/rerender-skip-budget") as typeof import("../src/lib/rerender-skip-budget");
  const draftLib = fromSrc("lib/mcp/pending-edit-draft") as typeof import("../src/lib/mcp/pending-edit-draft");
  const editorProjects = fromSrc("lib/editor-projects") as typeof import("../src/lib/editor-projects");
  const { normalizeHeadlineHook } = fromSrc("lib/headline-hook") as typeof import("../src/lib/headline-hook");
  const { restorePostExportEditorState } = fromSrc("app/(dashboard)/video-editor/_v2/export-edit-state") as
    typeof import("../src/app/(dashboard)/video-editor/_v2/export-edit-state");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");

  // ── REAL MCP route, compiled; only Clerk + the network key preflight are stubbed ──
  const routeRequire = (specifier: string): unknown => {
    if (specifier === "@clerk/nextjs/server") return { auth: async () => { throw new Error("no Clerk in this test"); } };
    if (specifier === "@clerk/mcp-tools/next") return { verifyClerkToken: async () => undefined };
    if (specifier === "@/lib/key-preflight") {
      return {
        ...keyPreflight,
        preflightElevenLabs: async () => null,
        preflightStockProviders: async () => ({ block: null, providers: [] }),
      };
    }
    if (specifier.startsWith("@/")) return fromSrc(specifier.slice(2));
    return realRequire(specifier);
  };
  const routePath = "src/app/api/[transport]/route.ts";
  const routeModule = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", compile(readFileSync(routePath, "utf8"), routePath))(
    routeRequire, routeModule, routeModule.exports,
  );
  const ROUTE_POST = routeModule.exports.POST as (request: Request) => Promise<Response>;

  let rpcSeq = 0;
  async function callTool(token: string, name: string, args: Json): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "verify-mcp-edit-persist-export/1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq, method: "tools/call", params: { name, arguments: args } }),
    }));
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    const message = JSON.parse(dataLine ? dataLine.slice(6) : body) as Json;
    const text = (message.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
    if (!text) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    return JSON.parse(text) as Json;
  }

  // ── fixtures ──
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
      data: { userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900, status: "PAID", periodDays: 30, paidAt: now },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    const { token } = await createMcpToken(id, "verify-mcp-edit-persist-export");
    return { user, token };
  }
  // Internal-tester emails pass the MCP Editor Project gate and the B-roll window-edit beta.
  const headlineUser = await makeUser("u-persist-h", "qa-persist-h@aoacademy.co");
  const windowUser = await makeUser("u-persist-w", "qa-persist-w@aoacademy.co");

  let renderSeq = 0;
  let gallerySeq = 0;
  const renderCalls: Array<{ rerenderOf?: { sourceJobId?: string }; config?: Json; burnOf?: string; overlay?: Json; free: boolean }> = [];
  function makeCaller(userId: string) {
    return {
      async post<T>(p: string, body?: unknown): Promise<T> {
        if (p === "/api/videos/tts-gemini" || p === "/api/videos/tts") {
          return { voiceUrl: VOICE_FILE, audioDurationMs: 4_000, timing: TIMING } as T;
        }
        if (p === "/api/videos/split-script") return { cards: null } as T;
        if (p === "/api/videos/transcribe") {
          return {
            captions: [
              { text: CARD0_TEXT, startMs: 0, endMs: 2_000, tag: "hook" },
              { text: CARD1_TEXT, startMs: 2_000, endMs: 4_000, tag: "body" },
            ],
            words: [{ word: CARD0_TEXT, startMs: 0, endMs: 2_000 }, { word: CARD1_TEXT, startMs: 2_000, endMs: 4_000 }],
            fullText: SCRIPT,
            audioDurationMs: 4_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_000 },
          } as T;
        }
        if (p === "/api/videos/extract-keywords") {
          return { keywords: ["food"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (p === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "food" }] } as T;
        if (p === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (p === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as {
            subtitleOverlayConfig?: Json & { videoUrl?: string };
            shortVideoConfig?: Json;
            parentJobId?: string;
            rerenderOf?: { sourceJobId?: string };
          };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-persist-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          let free = false;
          if (isBurn) {
            free = await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
          } else if (request.rerenderOf?.sourceJobId) {
            const source = await prisma.videoJob.findFirst({ where: { id: request.rerenderOf.sourceJobId, userId } });
            const output = parseVideoJobOutput(source?.outputJson ?? null);
            free = !!source
              && await isBurnAlreadyPaid(userId, output?.videoUrl)
              && rerenderSkipEligible({ sourceConfig: output?.preview?.config as Json, incomingConfig: request.shortVideoConfig })
              && budget.tryConsumeRerenderRate(userId);
          }
          renderCalls.push({
            ...(request.rerenderOf ? { rerenderOf: request.rerenderOf } : {}),
            ...(request.shortVideoConfig ? { config: structuredClone(request.shortVideoConfig) } : {}),
            ...(isBurn ? { burnOf: request.subtitleOverlayConfig?.videoUrl, overlay: structuredClone(request.subtitleOverlayConfig) } : {}),
            free,
          });
          await prisma.renderJob.create({
            data: {
              id, userId, parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER", status: "DONE",
              payload: "{}", videoUrl,
              reservedQuota: !free, reservedMinutes: free ? null : 1,
            },
          });
          if (!free) {
            await prisma.user.update({ where: { id: userId }, data: { minutesUsed: { increment: 1 } } });
            await recordChargedClip(userId, videoUrl, 1);
          } else if (!isBurn) {
            await recordChargedClip(userId, videoUrl, 0); // the route records a free rerender's new base
          }
          return { jobId: id } as T;
        }
        if (p.startsWith("/api/videos/render-cancel")) return {} as T;
        if (p === "/api/videos") { gallerySeq += 1; return { id: `gallery-persist-${gallerySeq}` } as T; }
        throw new Error(`stub caller: unexpected POST ${p}`);
      },
      async patch<T>(): Promise<T> { return {} as T; },
      async get<T>(p: string): Promise<T> {
        if (p.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(p)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          return { progress: 100, videoUrl: rj?.videoUrl ?? null, error: null, stage: "done" } as T;
        }
        if (p === "/api/music") return { tracks: [], userTracks: [] } as T;
        throw new Error(`stub caller: unexpected GET ${p}`);
      },
    };
  }
  async function runJob(jobId: string, userId: string) {
    await prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ["queued", "waiting_provider"] } },
      data: { status: "processing", startedAt: new Date(), providerNextPollAt: null },
    });
    await runOrchestrator(jobId, userId, { caller: makeCaller(userId) as never, sleep: async () => {} });
    return prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } });
  }
  const inputOf = (row: { inputJson: string }) => JSON.parse(row.inputJson) as Json;
  async function money(userId: string) {
    const [paidClips, reservedRenders, user, ledger] = await Promise.all([
      prisma.chargedClip.count({ where: { userId, OR: [{ chargedMinutes: null }, { chargedMinutes: { gt: 0 } }, { creditsSpent: { gt: 0 } }] } }),
      prisma.renderJob.count({ where: { userId, reservedQuota: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { minutesUsed: true, usageCount: true } }),
      prisma.creditLedger.count({ where: { userId } }),
    ]);
    return JSON.stringify({ paidClips, reservedRenders, minutesUsed: user.minutesUsed, usageCount: user.usageCount, creditLedger: ledger });
  }
  async function projectRow(projectId: string) {
    return prisma.editorProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { pendingEditJson: true, pendingEditRevision: true, activeJobId: true, activeExportJobId: true, draftJson: true, draftRevision: true, status: true },
    });
  }
  let heldSeq = 0;
  async function heldRootVia(who: { user: { id: string }; token: string }) {
    heldSeq += 1;
    const reply = await callTool(who.token, "create_video_job", {
      script: SCRIPT, voiceProvider: "gemini", exportMode: "hold", idempotencyKey: `persist-held-${heldSeq}`,
    });
    if (typeof reply.jobId !== "string") throw new Error(`fixture: hold create failed: ${JSON.stringify(reply)}`);
    const root = await runJob(reply.jobId, who.user.id);
    if (root.status !== "done" || !root.projectId) throw new Error(`fixture: held root ended ${root.status}: ${root.errorMessage}`);
    return { root, projectId: root.projectId };
  }
  /** What GET /api/editor-projects/:id hands the web editor (`project.draft` + `project.pendingEdit`). */
  async function webProjectView(userId: string, projectId: string) {
    const project = await editorProjects.getEditorProjectWithMediaState(userId, projectId);
    const row = await projectRow(projectId);
    return { project, pendingEdit: draftLib.pendingEditForWeb(row) };
  }
  /** A ready B-roll Media Import (what create_upload_url + PUT + the lane leave behind). */
  async function readyImport(userId: string, name: string) {
    return prisma.mediaImport.create({
      data: {
        userId, purpose: "broll_video", source: "upload", status: "ready",
        resultSrc: `/api/stocks/broll-upload-${name}.mp4`, durationMs: 3_000, deadlineAt: new Date(Date.now() + 60_000),
      },
    });
  }
  /** export_video when the draft holds window edits: rerender → (hop) chained export → done. */
  async function exportThroughRerender(who: { user: { id: string }; token: string }, rootId: string) {
    const exported = await callTool(who.token, "export_video", { jobId: rootId });
    if (exported.status !== "rerendering") throw new Error(`fixture: expected rerendering, got ${JSON.stringify(exported)}`);
    const rerenderId = String(exported.rerenderJobId);
    const rr = await runJob(rerenderId, who.user.id);
    if (rr.status !== "done") throw new Error(`fixture: rerender ended ${rr.status}: ${rr.errorMessage}`);
    const ex = await prisma.videoJob.findFirst({ where: { userId: who.user.id, type: "export", inputJson: { contains: `"sourceJobId":"${rerenderId}"` } } });
    if (!ex) throw new Error("fixture: the hop did not enqueue the chained export");
    const done = await runJob(ex.id, who.user.id);
    if (done.status !== "done") throw new Error(`fixture: chained export ended ${done.status}: ${done.errorMessage}`);
    return { rerender: rr, exportJob: done };
  }

  // ── A: the headline survives an export ──
  await section("A) headline: survives export_video for MCP re-export, get_edit_state, discard and the web editor", async () => {
    const { root, projectId } = await heldRootVia(headlineUser);
    const moneyBefore = await money(headlineUser.user.id);
    const set = await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: HEADLINE, preset: "news" });
    check("fixture: set_headline_hook accepted", set.ok === true && (set.headlineHook as Json)?.headline === HEADLINE, JSON.stringify(set));
    const draftRevisionBefore = (await projectRow(projectId)).draftRevision;

    const first = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    check("export_video enqueued", first.status === "exporting" && typeof first.exportJobId === "string", JSON.stringify(first));
    const firstRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(first.exportJobId) } });
    check("the first export burns the headline", ((inputOf(firstRow).subtitleOverlayConfig as Json)?.headlineHook as Json)?.headline === HEADLINE);
    const firstDone = await runJob(firstRow.id, headlineUser.user.id);
    check("first export done", firstDone.status === "done", String(firstDone.errorMessage));

    const afterExport = await projectRow(projectId);
    check("G12 unchanged: the applied draft was cleared", afterExport.pendingEditJson === null);
    const draft = JSON.parse(afterExport.draftJson ?? "{}") as Json;
    check("#7: the exported headline is persisted on the project (EditorProject.draftJson.headlineHook)",
      (draft.headlineHook as Json)?.headline === HEADLINE && (draft.headlineHook as Json)?.enabled === true
        && (draft.headlineHook as Json)?.preset === "news", JSON.stringify(draft.headlineHook));
    check("other project-draft keys are kept (createdVia: mcp)", draft.createdVia === "mcp", JSON.stringify(draft));
    check("the project-draft write bumps draftRevision (an open web session sees a newer server draft)",
      afterExport.draftRevision === draftRevisionBefore + 1, `${draftRevisionBefore} → ${afterExport.draftRevision}`);

    const state = await callTool(headlineUser.token, "get_edit_state", { jobId: root.id });
    check("#7: get_edit_state after the export still shows the headline",
      (state.headlineHook as Json | null)?.headline === HEADLINE && (state.headlineHook as Json | null)?.enabled === true,
      JSON.stringify(state.headlineHook));

    const web = await webProjectView(headlineUser.user.id, projectId);
    check("web: no pending agent draft is left to load (cleared)", web.pendingEdit === null);
    const webHook = normalizeHeadlineHook((web.project?.draft as Json | null)?.headlineHook);
    check("web: the editor's project draft carries the same headline (useV2Project reads project.draft.headlineHook)",
      webHook?.headline === HEADLINE && webHook.enabled === true && webHook.preset === "news", JSON.stringify(webHook));
    check("web: draftRevision reported to the editor is the bumped one", web.project?.draftRevision === afterExport.draftRevision);

    const second = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    check("re-export enqueued with no replay", second.status === "exporting" && second.exportJobId !== first.exportJobId, JSON.stringify(second));
    const secondRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(second.exportJobId) } });
    const secondHook = (inputOf(secondRow).subtitleOverlayConfig as Json)?.headlineHook as Json | undefined;
    check("#7: the second export burns the same headline without set_headline_hook being replayed",
      secondHook?.headline === HEADLINE && secondHook?.enabled === true, JSON.stringify(secondHook));
    const secondDone = await runJob(secondRow.id, headlineUser.user.id);
    check("second export done", secondDone.status === "done", String(secondDone.errorMessage));
    check("an unchanged headline is not rewritten (no extra draftRevision bump)",
      (await projectRow(projectId)).draftRevision === afterExport.draftRevision);

    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, headline: "พาดหัวที่ยังไม่ส่งออก" });
    const discarded = await callTool(headlineUser.token, "discard_edits", { jobId: root.id });
    check("fixture: discard accepted", discarded.ok === true, JSON.stringify(discarded));
    const reseeded = await callTool(headlineUser.token, "get_edit_state", { jobId: root.id });
    check("ADR 0064: discard reseeds from the last export's headline, not from nothing",
      (reseeded.headlineHook as Json | null)?.headline === HEADLINE, JSON.stringify(reseeded.headlineHook));
    check("D: no charge for set/export/re-export/discard", (await money(headlineUser.user.id)) === moneyBefore);
  });

  // ── A2: turning the headline off survives too; the web-export clear never writes the project draft ──
  await section("A2) a disabled headline survives export; a web export's G12 clear leaves the project draft alone", async () => {
    const { root, projectId } = await heldRootVia(headlineUser);
    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: HEADLINE });
    const on = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    await runJob(String(on.exportJobId), headlineUser.user.id);
    const off = await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, enabled: false });
    check("fixture: headline switched off", off.ok === true && (off.headlineHook as Json)?.enabled === false, JSON.stringify(off));
    const exportOff = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    const offRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(exportOff.exportJobId) } });
    check("the export with the headline off burns none", (inputOf(offRow).subtitleOverlayConfig as Json)?.headlineHook === undefined);
    const offDone = await runJob(offRow.id, headlineUser.user.id);
    check("export (headline off) done", offDone.status === "done", String(offDone.errorMessage));
    const persisted = (JSON.parse((await projectRow(projectId)).draftJson ?? "{}") as Json).headlineHook as Json | undefined;
    check("the project draft records the headline as off (text kept)", persisted?.enabled === false && persisted?.headline === HEADLINE, JSON.stringify(persisted));
    const state = await callTool(headlineUser.token, "get_edit_state", { jobId: root.id });
    check("get_edit_state shows it off, not the earlier on", (state.headlineHook as Json | null)?.enabled === false, JSON.stringify(state.headlineHook));
    const again = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    const againRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(again.exportJobId) } });
    check("a re-export keeps it off", (inputOf(againRow).subtitleOverlayConfig as Json)?.headlineHook === undefined);
    await runJob(againRow.id, headlineUser.user.id);

    // A web export of a loaded agent draft reaches the same G12 clear WITHOUT the root link: the web
    // autosaves its own headline, so the server must not overwrite the project draft from the
    // stored (agent) draft — the creator may already have changed the headline in the editor.
    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: "พาดหัวของเอเจนต์" });
    const before = await projectRow(projectId);
    const cleared = await draftLib.clearPendingEditDraftIfRevision(headlineUser.user.id, projectId, before.pendingEditRevision);
    const after = await projectRow(projectId);
    check("web-export clear: the draft is cleared as before", cleared === true && after.pendingEditJson === null);
    check("web-export clear: the project draft and its revision are untouched",
      after.draftJson === before.draftJson && after.draftRevision === before.draftRevision, JSON.stringify({ before: before.draftRevision, after: after.draftRevision }));
    const wire = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
    check("wire: the worker persists the headline only for an MCP export (server-set root link)",
      /persistHeadlineHook: typeof input\.mcpRootJobId === "string"/.test(wire));
  });

  // ── B: concurrency ──
  await section("B) headline concurrency: a newer agent edit wins; a stale web autosave is refused", async () => {
    const { root, projectId } = await heldRootVia(headlineUser);
    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: "พาดหัวเอ" });
    const exported = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    // The agent edits again while the export runs: the export's clear must miss (G12) and the
    // project draft must not be written with the older value the export applied.
    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, headline: "พาดหัวบี" });
    const draftRevisionBefore = (await projectRow(projectId)).draftRevision;
    const done = await runJob(String(exported.exportJobId), headlineUser.user.id);
    check("export done", done.status === "done", String(done.errorMessage));
    const row = await projectRow(projectId);
    check("the newer pending edit is kept (clear missed)", draftLib.parsePendingEditDraft(row.pendingEditJson)?.headlineHook?.headline === "พาดหัวบี");
    check("nothing is persisted under a newer pending edit", row.draftRevision === draftRevisionBefore
      && (JSON.parse(row.draftJson ?? "{}") as Json).headlineHook === undefined, JSON.stringify(row.draftJson));
    const state = await callTool(headlineUser.token, "get_edit_state", { jobId: root.id });
    check("get_edit_state shows the newer edit", (state.headlineHook as Json | null)?.headline === "พาดหัวบี");

    // Export B; an open web session that loaded the project before it now autosaves stale state.
    const webBefore = await webProjectView(headlineUser.user.id, projectId);
    const loadedRevision = Number(webBefore.project?.draftRevision);
    const exportedB = await callTool(headlineUser.token, "export_video", { jobId: root.id });
    const doneB = await runJob(String(exportedB.exportJobId), headlineUser.user.id);
    check("export B done", doneB.status === "done", String(doneB.errorMessage));
    const persisted = JSON.parse((await projectRow(projectId)).draftJson ?? "{}") as Json;
    check("export B persisted its headline", (persisted.headlineHook as Json)?.headline === "พาดหัวบี", JSON.stringify(persisted.headlineHook));
    let staleCode = "";
    try {
      await editorProjects.updateEditorProject(headlineUser.user.id, projectId, {
        draft: { createdVia: "mcp" },
        draftRevision: loadedRevision + 1,
        expectedDraftRevision: loadedRevision,
      });
    } catch (error) {
      staleCode = String((error as { code?: unknown }).code ?? "");
    }
    check("a web autosave from before the export is refused with stale_revision (never clobbers)", staleCode === "stale_revision", staleCode);
    const still = JSON.parse((await projectRow(projectId)).draftJson ?? "{}") as Json;
    check("…and the persisted headline is still there", (still.headlineHook as Json)?.headline === "พาดหัวบี");

    // A web autosave that lands between the clear's read and its write: the project-draft CAS
    // misses, the clear rolls back and retries on the fresh draft; a second miss gives up WITHOUT
    // clearing, so the agent's headline stays in the pending draft (never lost).
    type TxFn = typeof prisma.$transaction;
    const realTransaction = prisma.$transaction;
    async function clearWithWebAutosaves(autosaves: number) {
      const before = await projectRow(projectId);
      let raced = 0;
      (prisma as unknown as { $transaction: TxFn }).$transaction = (async (...args: Parameters<TxFn>) => {
        if (raced < autosaves) {
          raced += 1;
          await prisma.editorProject.update({
            where: { id: projectId },
            data: { draftJson: JSON.stringify({ createdVia: "mcp", webKey: `autosave-${raced}` }), draftRevision: { increment: 1 } },
          });
        }
        return (realTransaction as (...a: Parameters<TxFn>) => ReturnType<TxFn>).apply(prisma, args);
      }) as TxFn;
      try {
        const cleared = await draftLib.clearPendingEditDraftIfRevision(headlineUser.user.id, projectId, before.pendingEditRevision, { persistHeadlineHook: true });
        return { before, cleared, after: await projectRow(projectId) };
      } finally {
        (prisma as unknown as { $transaction: TxFn }).$transaction = realTransaction;
      }
    }
    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, headline: "พาดหัวซี" });
    const once = await clearWithWebAutosaves(1);
    const onceDraft = JSON.parse(once.after.draftJson ?? "{}") as Json;
    check("one racing autosave: the retry clears and persists onto the fresh draft (its other keys kept)",
      once.cleared === true && once.after.pendingEditJson === null && (onceDraft.headlineHook as Json)?.headline === "พาดหัวซี"
        && onceDraft.webKey === "autosave-1" && once.after.draftRevision === once.before.draftRevision + 2,
      JSON.stringify({ cleared: once.cleared, draft: onceDraft, rev: [once.before.draftRevision, once.after.draftRevision] }));
    await callTool(headlineUser.token, "set_headline_hook", { jobId: root.id, headline: "พาดหัวดี" });
    const twice = await clearWithWebAutosaves(2);
    check("two racing autosaves: nothing is cleared, the pending draft (and its headline) is kept",
      twice.cleared === false && twice.after.pendingEditRevision === twice.before.pendingEditRevision
        && draftLib.parsePendingEditDraft(twice.after.pendingEditJson)?.headlineHook?.headline === "พาดหัวดี",
      JSON.stringify({ cleared: twice.cleared, rev: [twice.before.pendingEditRevision, twice.after.pendingEditRevision] }));
    check("…and the web's own autosave is left as written", (JSON.parse(twice.after.draftJson ?? "{}") as Json).webKey === "autosave-2");
  });

  // ── C: window replacements survive an export ──
  await section("C) windows: replacements read back after export, re-export keeps them with no replay, the web sees them", async () => {
    const { root, projectId } = await heldRootVia(windowUser);
    const moneyBefore = await money(windowUser.user.id);
    const w0 = await readyImport(windowUser.user.id, "persist-w0");
    const w1 = await readyImport(windowUser.user.id, "persist-w1");
    for (const [windowIndex, row] of [[0, w0], [1, w1]] as const) {
      const reply = await callTool(windowUser.token, "replace_broll_window", { jobId: root.id, windowIndex, uploadId: row.id });
      check(`fixture: window ${windowIndex} replacement accepted`, reply.ok === true, JSON.stringify(reply));
    }
    let windows = (await callTool(windowUser.token, "get_edit_state", { jobId: root.id })).windows as Json[];
    check("before export: both windows replaced and pending", windows.every((w) => w.replaced === true && w.pending === true), JSON.stringify(windows));

    renderCalls.length = 0;
    const first = await exportThroughRerender(windowUser, root.id);
    check("first export burned the rerender (the replacements)", renderCalls.some((c) => c.burnOf === parseVideoJobOutput(first.rerender.outputJson)?.videoUrl));
    const project = await projectRow(projectId);
    check("fixture: the rerender is the project's base and the draft was cleared",
      project.activeJobId === first.rerender.id && project.pendingEditJson === null, JSON.stringify(project));

    windows = (await callTool(windowUser.token, "get_edit_state", { jobId: root.id })).windows as Json[];
    check("#15: get_edit_state after the export shows both windows replaced (applied), not reset",
      windows[0]?.replaced === true && windows[1]?.replaced === true, JSON.stringify(windows));
    check("…and nothing pending (export_video will not re-render them again)",
      windows.every((w) => w.pending === false && w.importStatus === null), JSON.stringify(windows));

    renderCalls.length = 0;
    const again = await callTool(windowUser.token, "export_video", { jobId: root.id });
    check("#15: a re-export with no new edits does not re-render (no replay)", again.status === "exporting" && !again.rerenderJobId, JSON.stringify(again));
    const againRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(again.exportJobId) } });
    check("…it burns the base that already carries the replacements", inputOf(againRow).sourceJobId === first.rerender.id, String(inputOf(againRow).sourceJobId));
    const againDone = await runJob(againRow.id, windowUser.user.id);
    check("re-export done", againDone.status === "done", String(againDone.errorMessage));
    check("…and no render other than the free burn ran", renderCalls.length === 1 && !!renderCalls[0].burnOf && renderCalls[0].free, JSON.stringify(renderCalls));

    // Round 2: change ONE window; the other keeps its earlier replacement without a replay.
    const w1b = await readyImport(windowUser.user.id, "persist-w1b");
    const swap = await callTool(windowUser.token, "replace_broll_window", { jobId: root.id, windowIndex: 1, uploadId: w1b.id });
    check("fixture: round-2 replacement accepted", swap.ok === true, JSON.stringify(swap));
    windows = (await callTool(windowUser.token, "get_edit_state", { jobId: root.id })).windows as Json[];
    check("round 2: window 0 replaced (applied), window 1 replaced (pending)",
      windows[0]?.replaced === true && windows[0]?.pending === false && windows[1]?.replaced === true && windows[1]?.pending === true,
      JSON.stringify(windows));
    renderCalls.length = 0;
    const second = await exportThroughRerender(windowUser, root.id);
    const rr2Input = inputOf(second.rerender);
    check("round 2 re-renders from the base that carries round 1", rr2Input.sourceJobId === first.rerender.id, String(rr2Input.sourceJobId));
    check("round 2 re-renders only the changed window", (rr2Input.windowEdits as Json[]).length === 1 && (rr2Input.windowEdits as Json[])[0].index === 1,
      JSON.stringify(rr2Input.windowEdits));
    const rendered = (renderCalls.find((c) => c.rerenderOf)?.config?.bgVideos ?? []) as Json[];
    check("#15: window 0 keeps its round-1 replacement; window 1 is the new one",
      rendered[0]?.src === w0.resultSrc && rendered[1]?.src === w1b.resultSrc, JSON.stringify(rendered.map((w) => w.src)));

    // The web editor reopening the exported project resumes onto the replaced windows.
    const web = await webProjectView(windowUser.user.id, projectId);
    check("web: project points at the round-2 rerender and its export",
      web.project?.activeJobId === second.rerender.id && web.project?.activeExportJobId === second.exportJob.id, JSON.stringify(web.project));
    const exportOutput = parseVideoJobOutput(second.exportJob.outputJson);
    const restored = restorePostExportEditorState({
      phase: "done", jobId: second.exportJob.id, jobType: "export", projectId, currentStep: "save", progress: 100,
      queuePosition: null, errorMessage: null, errorCode: null, errorProvider: null,
      output: exportOutput, mediaState: { status: "available" },
    } as unknown as Parameters<typeof restorePostExportEditorState>[0], web.project?.activeJobId ?? null);
    const webWindows = ((restored?.output?.preview?.config as Json | undefined)?.bgVideos ?? []) as Json[];
    check("web: the editor resumes on the rerender with both replaced windows",
      restored?.jobId === second.rerender.id && webWindows[0]?.src === w0.resultSrc && webWindows[1]?.src === w1b.resultSrc,
      JSON.stringify({ jobId: restored?.jobId, srcs: webWindows.map((w) => w.src) }));

    // source:"original" puts window 0 back; it then reads as not replaced.
    const back = await callTool(windowUser.token, "replace_broll_window", { jobId: root.id, windowIndex: 0, source: "original" });
    check("fixture: original accepted", back.ok === true, JSON.stringify(back));
    await exportThroughRerender(windowUser, root.id);
    windows = (await callTool(windowUser.token, "get_edit_state", { jobId: root.id })).windows as Json[];
    check("after restoring window 0: window 0 not replaced, window 1 still replaced",
      windows[0]?.replaced === false && windows[0]?.pending === false && windows[1]?.replaced === true && windows[1]?.pending === false,
      JSON.stringify(windows));
    check("D: no charge across 3 rerenders + 4 exports", (await money(windowUser.user.id)) === moneyBefore);
  });

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error("FAIL: threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("❌ MCP edit persistence across export FAILED");
      process.exit(1);
    }
    console.log("✅ MCP edit persistence across export: all checks passed");
    process.exit(0);
  });
