// verify-mcp-edit-draft.ts — T6 (PR-A, plan docs/plans/2026-10-03-mcp-edit-before-export.md):
// the tracer bullet of MCP edit-before-export — the Pending Edit Draft (G10-G12),
// create_video_job exportMode:"hold" (G2/G6), get_edit_state, set_caption_text and
// export_video (G4/G7/G9), the Agent-neutral Tool contract (G13/G14) and the held export's
// fail-closed billing gate (session ruling, T5 deviation 7).
//
// Every MCP call goes through the REAL route handler (src/app/api/[transport]/route.ts:
// createMcpHandler + withMcpAuth + verifyToken with a real PAT), compiled with only the Clerk
// modules and the network key preflight stubbed. Jobs run through the REAL orchestrator with a
// stub pipeline caller whose /api/videos/render mirrors the real route's charge rule.
//
// Self-contained: builds its own throwaway SQLite.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-edit-draft.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "mcp-edit-draft-"));
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
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const NEW_TOOLS = ["get_edit_state", "set_caption_text", "export_video"] as const;
const SCRIPT = "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน เนื้อบางเบามาก ซึมไวสุดๆ";
const TIMING = {
  provider: "gemini",
  segments: [
    { text: "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน ", startMs: 0, durationMs: 2600 },
    { text: "เนื้อบางเบามาก ซึมไวสุดๆ", startMs: 2600, durationMs: 2400 },
  ],
};
const VOICE_FILE = "/api/renders/edit-draft-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 150,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/edit-a.mp4", start: 0, end: 2.5, sourceIndex: 0, clipDuration: 5 },
    { src: "/api/stocks/edit-b.mp4", start: 2.5, end: 5, sourceIndex: 1, clipDuration: 5 },
  ],
};
/** Pipeline paths that reach a paid provider (TTS / transcribe / Gemini / stock / HeyGen). */
const PROVIDER_PATH = /tts|transcribe|split-script|extract-keywords|fetch-stock|generate-config|heygen|gemini|elevenlabs/i;

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-edit-draft.ts"));
  const fromSrc = (path: string) => realRequire(join(ROOT, "src", path));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const videoJobModule = fromSrc("lib/mcp/video-job") as typeof import("../src/lib/mcp/video-job");
  const { parseVideoJobOutput } = videoJobModule;
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { isBurnAlreadyPaid, recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const { videoJobMustBeFree, MCP_RENDER_NOT_FREE_MESSAGE } = fromSrc("lib/mcp/render-free") as typeof import("../src/lib/mcp/render-free");
  const { sweepStalledVideoJobs } = fromSrc("lib/mcp/video-job-watchdog") as typeof import("../src/lib/mcp/video-job-watchdog");
  const { mcpEditorUrl } = fromSrc("lib/mcp/tools") as typeof import("../src/lib/mcp/tools");
  const chainKey = fromSrc("lib/mcp/chain-key") as typeof import("../src/lib/mcp/chain-key");
  const draftLib = fromSrc("lib/mcp/pending-edit-draft") as typeof import("../src/lib/mcp/pending-edit-draft");
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

  const fetchLog: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchLog.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  }) as typeof fetch;

  let rpcSeq = 0;
  async function rpc(token: string, method: string, params: unknown): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "verify-mcp-edit-draft/1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq, method, params }),
    }));
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    try {
      return JSON.parse(dataLine ? dataLine.slice(6) : body) as Json;
    } catch {
      throw new Error(`route ${method} → ${response.status}: ${body.slice(0, 300)}`);
    }
  }
  async function listTools(token: string) {
    const message = await rpc(token, "tools/list", {});
    return ((message.result as Json | undefined)?.tools ?? []) as Array<{ name: string; inputSchema?: Json }>;
  }
  const failures: Array<{ tool: string; reply: Json }> = [];
  async function callTool(token: string, name: string, args: Json): Promise<Json> {
    const message = await rpc(token, "tools/call", { name, arguments: args });
    const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    let reply: Json;
    try {
      reply = JSON.parse(text) as Json;
    } catch {
      throw new Error(`tools/call ${name} returned non-JSON: ${text.slice(0, 300)}`);
    }
    if (reply.error != null && (NEW_TOOLS as readonly string[]).includes(name)) failures.push({ tool: name, reply });
    return reply;
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
      data: {
        userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900,
        status: "PAID", periodDays: 30, paidAt: now,
      },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    const { token } = await createMcpToken(id, "verify-mcp-edit-draft");
    return { user, token };
  }
  // Internal-tester emails pass the MCP Editor Project gate; example.com does not.
  const tester = await makeUser("u-edit", "qa-edit@aoacademy.co");
  const notFreeUser = await makeUser("u-edit-notfree", "qa-edit-notfree@aoacademy.co");
  const gateUser = await makeUser("u-edit-gate", "qa-edit-gate@aoacademy.co");
  const outsider = await makeUser("u-edit-outsider", "edit-outsider@example.com");

  let renderSeq = 0;
  let gallerySeq = 0;
  const callerLog: string[] = [];
  function makeCaller(userId: string) {
    return {
      async post<T>(path: string, body?: unknown): Promise<T> {
        callerLog.push(`POST ${path}`);
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          return { voiceUrl: VOICE_FILE, audioDurationMs: 5000, timing: TIMING } as T;
        }
        if (path === "/api/videos/split-script") return { cards: null } as T;
        if (path === "/api/videos/transcribe") {
          return {
            captions: [
              { text: TIMING.segments[0].text.trim(), startMs: 100, endMs: 2_550, tag: "hook" },
              { text: TIMING.segments[1].text.trim(), startMs: 2_600, endMs: 4_800, tag: "body" },
            ],
            words: [
              { word: TIMING.segments[0].text.trim(), startMs: 100, endMs: 2_550 },
              { word: TIMING.segments[1].text.trim(), startMs: 2_600, endMs: 4_800 },
            ],
            fullText: SCRIPT,
            audioDurationMs: 5_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_800 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["sunscreen"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [5], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "sunscreen" }] } as T;
        if (path === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-edit-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          // Mirrors /api/videos/render: a burn of a paid base is free; anything else reserves.
          const free = isBurn && await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
          // …and refuses (never charges) a job the MCP path flagged must-be-free.
          if (!free && request.parentJobId && await videoJobMustBeFree(userId, request.parentJobId)) {
            throw new Error(MCP_RENDER_NOT_FREE_MESSAGE);
          }
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
          }
          return { jobId: id } as T;
        }
        if (path.startsWith("/api/videos/render-cancel")) return {} as T;
        if (path === "/api/videos") { gallerySeq += 1; return { id: `gallery-edit-${gallerySeq}` } as T; }
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(path: string): Promise<T> { callerLog.push(`PATCH ${path}`); return {} as T; },
      async get<T>(path: string): Promise<T> {
        callerLog.push(`GET ${path}`);
        if (path.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(path)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          return { progress: 100, videoUrl: rj?.videoUrl ?? null, error: null, stage: "done" } as T;
        }
        if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
        throw new Error(`stub caller: unexpected GET ${path}`);
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
    const [chargedClips, reservedRenders, user, ledger] = await Promise.all([
      prisma.chargedClip.count({ where: { userId } }),
      prisma.renderJob.count({ where: { userId, reservedQuota: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { minutesUsed: true } }),
      prisma.creditLedger.count({ where: { userId } }),
    ]);
    return { chargedClips, reservedRenders, minutesUsed: user.minutesUsed, creditLedger: ledger };
  }
  async function projectRow(projectId: string) {
    return prisma.editorProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { pendingEditJson: true, pendingEditRevision: true, activeJobId: true },
    });
  }
  /** create_video_job(exportMode:"hold") through the route, then run the root to its Base Render. */
  async function heldRootVia(who: { user: { id: string }; token: string }, key: string) {
    const reply = await callTool(who.token, "create_video_job", {
      script: SCRIPT, voiceProvider: "gemini", exportMode: "hold", idempotencyKey: key,
    });
    if (typeof reply.jobId !== "string") throw new Error(`fixture: hold create failed: ${JSON.stringify(reply)}`);
    const root = await runJob(reply.jobId, who.user.id);
    if (root.status !== "done" || !root.projectId) throw new Error(`fixture: held root ended ${root.status}: ${root.errorMessage}`);
    return { reply, root, projectId: root.projectId };
  }

  // ── A ──
  await section("A) real route tools/list: beta sees the edit tools, non-beta does not; schemas are agent-neutral", async () => {
    const betaTools = await listTools(tester.token);
    const betaNames = betaTools.map((tool) => tool.name);
    for (const name of NEW_TOOLS) check(`beta tools/list includes ${name}`, betaNames.includes(name), betaNames.join(","));
    const outsiderNames = (await listTools(outsider.token)).map((tool) => tool.name);
    for (const name of NEW_TOOLS) check(`non-beta tools/list hides ${name}`, !outsiderNames.includes(name));
    check("non-beta still sees every existing tool", ["get_current_user", "get_video_status", "create_video_job", "cancel_video_job"]
      .every((name) => outsiderNames.includes(name)));
    const problems = verifyAgentNeutralSchemas(betaTools, NEW_TOOLS);
    check("G13: every new tool's emitted schema is agent-neutral", problems.length === 0, problems.join("; "));
    const create = betaTools.find((tool) => tool.name === "create_video_job");
    const exportMode = (create?.inputSchema?.properties as Json | undefined)?.exportMode as Json | undefined;
    check("create_video_job exposes exportMode as a plain optional string enum (auto|hold)",
      exportMode?.type === "string"
        && JSON.stringify(exportMode.enum) === JSON.stringify(["auto", "hold"])
        && !((create?.inputSchema?.required as string[] | undefined) ?? []).includes("exportMode"),
      JSON.stringify(exportMode));
    const createProblems = verifyAgentNeutralSchemas(betaTools, ["create_video_job"]);
    check("create_video_job's schema stays free of oneOf/anyOf/allOf", createProblems.length === 0, createProblems.join("; "));
  });

  // ── B ──
  await section("B) non-beta: a direct call of each edit tool and exportMode are refused with feature_not_enabled", async () => {
    for (const name of NEW_TOOLS) {
      const args: Json = name === "set_caption_text" ? { jobId: "any", index: 0, text: "x" } : { jobId: "any" };
      const reply = await callTool(outsider.token, name, args);
      check(`${name}: feature_not_enabled envelope`, reply.error === "feature_not_enabled"
        && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
      const audit = await prisma.toolCallAudit.findFirst({
        where: { userId: outsider.user.id, toolName: name }, orderBy: { createdAt: "desc" },
      });
      check(`${name}: the refusal is audited as denied`, audit?.status === "denied", JSON.stringify(audit));
    }
    const jobsBefore = await prisma.videoJob.count({ where: { userId: outsider.user.id } });
    const projectsBefore = await prisma.editorProject.count({ where: { userId: outsider.user.id } });
    for (const exportMode of ["hold", "auto"]) {
      const reply = await callTool(outsider.token, "create_video_job", { script: SCRIPT, exportMode });
      check(`exportMode:"${exportMode}" from a non-beta account → feature_not_enabled`,
        reply.error === "feature_not_enabled" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    }
    check("the refused creates wrote no job and no project",
      await prisma.videoJob.count({ where: { userId: outsider.user.id } }) === jobsBefore
        && await prisma.editorProject.count({ where: { userId: outsider.user.id } }) === projectsBefore);
    const audit = await prisma.toolCallAudit.findFirst({
      where: { userId: outsider.user.id, toolName: "create_video_job" }, orderBy: { createdAt: "desc" },
    });
    check("the exportMode refusal is audited as denied", audit?.status === "denied", JSON.stringify(audit));
  });

  // ── C ──
  await section("C) create_video_job without exportMode behaves exactly as before (regression)", async () => {
    const plain = await callTool(outsider.token, "create_video_job", { script: SCRIPT, voiceProvider: "gemini", idempotencyKey: "edit-plain-1" });
    check("non-beta default create queues", typeof plain.jobId === "string" && plain.status === "queued", JSON.stringify(plain));
    check("non-beta reply keys unchanged", JSON.stringify(Object.keys(plain).sort()) === JSON.stringify(["jobId", "message", "nextStep", "status"]),
      JSON.stringify(Object.keys(plain)));
    const plainRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(plain.jobId) } });
    const plainInput = inputOf(plainRow);
    check("non-beta job: no project, no hold / chain markers",
      plainRow.projectId === null && plainInput.mcpHold === undefined && plainInput.mcpChainExport === undefined
        && plainInput.previewMode === undefined, JSON.stringify(plainInput));

    const auto = await callTool(tester.token, "create_video_job", { script: SCRIPT, voiceProvider: "gemini", idempotencyKey: "edit-auto-1" });
    check("beta default create reply keys unchanged", JSON.stringify(Object.keys(auto).sort()) === JSON.stringify(["jobId", "message", "nextStep", "status"]),
      JSON.stringify(auto));
    const autoRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(auto.jobId) } });
    const autoInput = inputOf(autoRow);
    check("beta default create stays the ADR 0063 auto chain (mcpChainExport, no mcpHold)",
      autoInput.mcpChainExport === true && autoInput.mcpHold === undefined && autoRow.projectId !== null, JSON.stringify(autoInput));
    // Leave the in-flight cap free for the rest of the run.
    await prisma.videoJob.updateMany({ where: { id: { in: [plainRow.id, autoRow.id] } }, data: { status: "canceled" } });
  });

  // ── D ──
  let held: Awaited<ReturnType<typeof heldRootVia>> | null = null;
  await section("D) exportMode:\"hold\" → held with previewUrl + editorUrl; survives a poll and a watchdog sweep", async () => {
    held = await heldRootVia(tester, "edit-held-1");
    const { reply, root, projectId } = held;
    check("hold reply queues the job", reply.status === "queued", JSON.stringify(reply));
    const input = inputOf(root);
    check("held root input: mcpHold + previewMode, never mcpChainExport",
      input.mcpHold === true && input.previewMode === true && input.mcpChainExport === undefined, JSON.stringify(input));
    for (let poll = 1; poll <= 2; poll += 1) {
      const status = await callTool(tester.token, "get_video_status", { id: root.id });
      check(`poll ${poll}: get_video_status = held`, status.status === "held", JSON.stringify(status));
      check(`poll ${poll}: previewUrl is the absolute base URL`,
        typeof status.previewUrl === "string" && String(status.previewUrl).startsWith("https://studio.example.test/api/renders/"));
      check(`poll ${poll}: editorUrl is the project's`, status.editorUrl === mcpEditorUrl(projectId));
      if (poll === 1) {
        const sweep = await sweepStalledVideoJobs(new Date());
        check("watchdog sweep exported nothing", sweep.recoveredChainExports.length === 0);
      }
    }
    check("no export row exists after polls + sweep",
      await prisma.videoJob.count({ where: { userId: tester.user.id, type: "export", projectId } }) === 0);
  });

  // ── E ──
  let seedCaptions: Array<{ index: number; text: string; startMs: number; endMs: number }> = [];
  await section("E) get_edit_state returns the seeded draft, writes nothing and calls nothing", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    fetchLog.length = 0;
    const before = await projectRow(projectId);
    const state = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("status held + previewUrl", state.status === "held" && typeof state.previewUrl === "string", JSON.stringify(state).slice(0, 300));
    seedCaptions = state.captions as typeof seedCaptions;
    const preview = parseVideoJobOutput(root.outputJson)?.preview;
    check("captions = the preview's, as [{index,text,startMs,endMs}]",
      Array.isArray(seedCaptions) && seedCaptions.length === preview?.captions.length && seedCaptions.length > 0
        && seedCaptions.every((caption, index) => caption.index === index
          && caption.text === preview!.captions[index].text
          && caption.startMs === preview!.captions[index].startMs
          && caption.endMs === preview!.captions[index].endMs
          && JSON.stringify(Object.keys(caption).sort()) === JSON.stringify(["endMs", "index", "startMs", "text"])),
      JSON.stringify(seedCaptions));
    check("cardLen + subtitleStyle come from the root's resolved design",
      state.cardLen === "sentence" && (state.subtitleStyle as Json | undefined)?.fontSize === 80
        && (state.subtitleStyle as Json | undefined)?.verticalPos === 82, JSON.stringify([state.cardLen, state.subtitleStyle]));
    check("headlineHook is null (the MCP project draft has none)", state.headlineHook === null);
    const windows = state.windows as Array<Json>;
    check("windows come from the base config's bgVideos",
      Array.isArray(windows) && windows.length === 2
        && windows[0].index === 0 && windows[0].startMs === 0 && windows[0].endMs === 2_500
        && windows[1].index === 1 && windows[1].startMs === 2_500 && windows[1].endMs === 5_000,
      JSON.stringify(windows));
    check("each window: owner broll, not replaced, no import",
      windows.every((window) => window.owner === "broll" && window.replaced === false && window.importStatus === null));
    check("draftRevision 0 before any edit", state.draftRevision === 0);
    const allowed = state.allowed as Json;
    check("allowed lists 12 fonts, 17 presets, 10 effects and the numeric ranges",
      (allowed?.fonts as unknown[])?.length === 12 && (allowed?.presets as unknown[])?.length === 17
        && (allowed?.effects as unknown[])?.length === 10
        && JSON.stringify(allowed?.fontSize) === JSON.stringify({ min: 30, max: 160 })
        && JSON.stringify(allowed?.verticalPos) === JSON.stringify({ min: 10, max: 95 })
        && JSON.stringify(allowed?.outlineSize) === JSON.stringify({ min: 1, max: 8 })
        && JSON.stringify(allowed?.fontWeight) === JSON.stringify(["400", "600", "900"]),
      JSON.stringify(allowed));
    check("next names a tool", typeof state.next === "string" && String(state.next).includes("set_caption_text"));
    const after = await projectRow(projectId);
    check("reading wrote nothing", after.pendingEditJson === null && after.pendingEditRevision === before.pendingEditRevision);
  });

  // ── F ──
  const EDITED = "แก้ข้อความการ์ดแรกแล้ว";
  await section("F) set_caption_text changes text only, keeps timing, and refuses bad input with envelopes", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    fetchLog.length = 0;
    const reply = await callTool(tester.token, "set_caption_text", { jobId: root.id, index: 0, text: `  ${EDITED}  ` });
    check("edit accepted at draftRevision 1", reply.ok === true && reply.draftRevision === 1, JSON.stringify(reply));
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    const state = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    const captions = state.captions as typeof seedCaptions;
    check("card 0 text changed (trimmed)", captions[0].text === EDITED, captions[0].text);
    check("card 0 timing unchanged", captions[0].startMs === seedCaptions[0].startMs && captions[0].endMs === seedCaptions[0].endMs);
    check("every other card unchanged", captions.slice(1).every((caption, index) =>
      JSON.stringify(caption) === JSON.stringify(seedCaptions[index + 1])));
    check("draftRevision is 1", state.draftRevision === 1);
    const row = await projectRow(projectId);
    const stored = draftLib.parsePendingEditDraft(row.pendingEditJson);
    check("the draft is stored on the project", stored?.captions[0].text === EDITED && row.pendingEditRevision === 1);
    check("originalCaptions keep the preview text", stored?.originalCaptions[0].text === seedCaptions[0].text);

    const bad: Array<[string, Json, string]> = [
      ["index out of range", { jobId: root.id, index: seedCaptions.length, text: "x" }, "invalid_input"],
      ["negative index", { jobId: root.id, index: -1, text: "x" }, "invalid_input"],
      ["blank text", { jobId: root.id, index: 0, text: "   " }, "invalid_input"],
      ["over-long text", { jobId: root.id, index: 0, text: "ก".repeat(501) }, "invalid_input"],
      ["unknown jobId", { jobId: "nope", index: 0, text: "x" }, "invalid_input"],
    ];
    for (const [label, args, code] of bad) {
      const refused = await callTool(tester.token, "set_caption_text", args);
      check(`${label} → ${code} envelope`, refused.error === code && checkFailureEnvelope(refused).length === 0, JSON.stringify(refused));
    }
    const foreign = await callTool(gateUser.token, "set_caption_text", { jobId: root.id, index: 0, text: "x" });
    check("another user's jobId is refused exactly like an unknown id",
      foreign.error === "invalid_input" && foreign.message === (await callTool(gateUser.token, "set_caption_text", { jobId: "nope", index: 0, text: "x" })).message,
      JSON.stringify(foreign));
    check("refusals wrote nothing", (await projectRow(projectId)).pendingEditRevision === 1);
    const audit = await prisma.toolCallAudit.findFirst({
      where: { userId: tester.user.id, toolName: "set_caption_text" }, orderBy: { createdAt: "desc" },
    });
    check("an in-band refusal is audited as error", audit?.status === "error", JSON.stringify(audit));
  });

  // ── G ──
  let firstExportId = "";
  await section("G) export_video: free burn of activeJobId with the edit; replay; concurrent edit survives the clear", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    const moneyBefore = await money(tester.user.id);
    fetchLog.length = 0;
    const reply = await callTool(tester.token, "export_video", { jobId: root.id });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("export accepted: exporting at draftRevision 1", reply.status === "exporting" && reply.draftRevision === 1
      && reply.jobId === root.id && typeof reply.exportJobId === "string", JSON.stringify(reply));
    firstExportId = String(reply.exportJobId);
    const exportRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: firstExportId } });
    const exportInput = inputOf(exportRow);
    const project = await projectRow(projectId);
    check("G7 key mcp-export:<root>:1", exportRow.idempotencyKey === chainKey.mcpExportKey(root.id, 1), String(exportRow.idempotencyKey));
    check("G9 source = project.activeJobId", exportInput.sourceJobId === project.activeJobId && exportInput.sourceJobId === root.id);
    check("export carries mcpRootJobId + mcpMustBeFree + the applied revision",
      exportInput.mcpRootJobId === root.id && exportInput.mcpMustBeFree === true && exportInput.mcpPendingEditRevision === 1,
      JSON.stringify(Object.keys(exportInput)));
    check("never the auto-chain marker", exportInput.mcpChainExport === undefined);
    const overlay = exportInput.subtitleOverlayConfig as { videoUrl?: string; keywordPopups?: Array<{ text: string }> };
    check("subtitleOverlayConfig burns onto the paid base", overlay.videoUrl === parseVideoJobOutput(root.outputJson)?.videoUrl);
    check("subtitleOverlayConfig contains the edit", overlay.keywordPopups?.[0]?.text === EDITED, JSON.stringify(overlay.keywordPopups?.[0]));
    check("editSnapshot carries the edited captions",
      ((exportInput.editSnapshot as Json | undefined)?.captions as Array<{ text: string }> | undefined)?.[0]?.text === EDITED);
    check("enqueue reserved/charged nothing", JSON.stringify(await money(tester.user.id)) === JSON.stringify(moneyBefore));

    const again = await callTool(tester.token, "export_video", { jobId: root.id });
    check("a second export_video at the same revision replays the same export",
      again.exportJobId === firstExportId && again.status === "exporting", JSON.stringify(again));
    check("still one export row", await prisma.videoJob.count({ where: { userId: tester.user.id, type: "export", projectId } }) === 1);
    const status = await callTool(tester.token, "get_video_status", { id: root.id });
    check("get_video_status(root) = exporting", status.status === "exporting", JSON.stringify(status).slice(0, 200));

    // An agent edit lands while the export runs (A8).
    const DURING = "แก้ระหว่างกำลังส่งออก";
    const during = await callTool(tester.token, "set_caption_text", { jobId: root.id, index: 0, text: DURING });
    check("edit during export → revision 2", during.draftRevision === 2, JSON.stringify(during));

    callerLog.length = 0;
    const done = await runJob(firstExportId, tester.user.id);
    check("export finished", done.status === "done", String(done.errorMessage));
    const providerCalls = callerLog.filter((entry) => PROVIDER_PATH.test(entry));
    check("G3: the export made no provider call (HeyGen/TTS/Gemini/stock)", providerCalls.length === 0, providerCalls.join(","));
    check("the export only burned and saved", callerLog.filter((entry) => entry.startsWith("POST"))
      .every((entry) => entry === "POST /api/videos/render" || entry === "POST /api/videos"), callerLog.join(","));
    const moneyAfter = await money(tester.user.id);
    check("G3: no ChargedClip, reservation, minutes or credits", JSON.stringify(moneyAfter) === JSON.stringify(moneyBefore),
      `${JSON.stringify(moneyBefore)} → ${JSON.stringify(moneyAfter)}`);
    const burn = await prisma.renderJob.findFirst({ where: { parentJobId: firstExportId, type: "BURN" } });
    check("the burn ran free (reservedQuota false)", burn?.reservedQuota === false);
    const output = parseVideoJobOutput(done.outputJson);
    check("held export passed the fail-closed billing gate (settled receipt)", output?.billingReceipt?.status === "settled",
      JSON.stringify(output?.billingReceipt));
    const afterExport = await projectRow(projectId);
    const survived = draftLib.parsePendingEditDraft(afterExport.pendingEditJson);
    check("G12: the edit made during the export survives (no clear at revision 1)",
      afterExport.pendingEditRevision === 2 && survived?.captions[0].text === DURING, JSON.stringify(afterExport).slice(0, 200));
    const doneStatus = await callTool(tester.token, "get_video_status", { id: root.id });
    check("get_video_status(root) = done with a videoUrl", doneStatus.status === "done" && typeof doneStatus.videoUrl === "string",
      JSON.stringify(doneStatus).slice(0, 200));

    // Export the surviving edit: a new key, then a successful finish clears the draft.
    const second = await callTool(tester.token, "export_video", { jobId: root.id });
    check("re-export gets a new export at revision 2", second.status === "exporting" && second.draftRevision === 2
      && second.exportJobId !== firstExportId, JSON.stringify(second));
    const secondRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(second.exportJobId) } });
    check("re-export key mcp-export:<root>:2", secondRow.idempotencyKey === chainKey.mcpExportKey(root.id, 2));
    check("re-export burns the surviving edit",
      ((inputOf(secondRow).subtitleOverlayConfig as Json).keywordPopups as Array<{ text: string }>)[0].text === DURING);
    const secondDone = await runJob(secondRow.id, tester.user.id);
    check("re-export finished", secondDone.status === "done", String(secondDone.errorMessage));
    const cleared = await projectRow(projectId);
    check("G12: a matching revision clears the draft and bumps the revision",
      cleared.pendingEditJson === null && cleared.pendingEditRevision === 3, JSON.stringify(cleared));
    const reseeded = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    check("after the clear the draft reseeds from the latest export's snapshot",
      (reseeded.captions as typeof seedCaptions)[0].text === DURING && reseeded.draftRevision === 3, JSON.stringify(reseeded.captions));
    check("re-export left money untouched", JSON.stringify(await money(tester.user.id)) === JSON.stringify(moneyBefore));
  });

  // ── H ──
  await section("H) CAS: one lost race retries internally; two lost races → stale_revision", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    const rootRow = { id: root.id, inputJson: root.inputJson, projectId };
    const realUpdateMany = prisma.editorProject.updateMany.bind(prisma.editorProject);
    /** Another writer wins the next `times` conditional draft writes (bumps the revision first). */
    async function withInterference<T>(times: number, body: () => Promise<T>): Promise<T> {
      let left = times;
      (prisma.editorProject as unknown as { updateMany: unknown }).updateMany = async (args: { where?: Json }) => {
        if (left > 0 && args.where && "pendingEditRevision" in args.where) {
          left -= 1;
          await realUpdateMany({ where: { id: projectId }, data: { pendingEditRevision: { increment: 1 } } });
        }
        return realUpdateMany(args as never);
      };
      try {
        return await body();
      } finally {
        (prisma.editorProject as unknown as { updateMany: unknown }).updateMany = realUpdateMany;
      }
    }

    let loads = 0;
    const retried = await withInterference(1, () => draftLib.updatePendingEditDraft(tester.user.id, rootRow, (draft) => {
      loads += 1;
      draft.captions[0] = { ...draft.captions[0], text: "หลังชนครั้งเดียว" };
      return { ok: true, draft };
    }));
    check("lib: one lost race → reloaded + retried once → ok", retried.ok === true && loads === 2, JSON.stringify({ ok: retried.ok, loads }));
    const afterRetry = await projectRow(projectId);
    check("lib: the retried write landed", draftLib.parsePendingEditDraft(afterRetry.pendingEditJson)?.captions[0].text === "หลังชนครั้งเดียว");

    loads = 0;
    const lost = await withInterference(2, () => draftLib.updatePendingEditDraft(tester.user.id, rootRow, (draft) => {
      loads += 1;
      return { ok: true, draft };
    }));
    check("lib: two lost races → stale_revision (no third attempt)", !lost.ok && lost.code === "stale_revision" && loads === 2,
      JSON.stringify({ lost, loads }));

    const stale = await withInterference(2, () =>
      callTool(tester.token, "set_caption_text", { jobId: root.id, index: 0, text: "ไม่ควรถูกบันทึก" }));
    check("tool: two lost races → stale_revision envelope", stale.error === "stale_revision" && checkFailureEnvelope(stale).length === 0,
      JSON.stringify(stale));
    const row = await projectRow(projectId);
    check("tool: the refused text was never stored", !String(row.pendingEditJson ?? "").includes("ไม่ควรถูกบันทึก"));
  });

  // ── I ──
  await section("I) G4: a base whose burn is not free → export_not_free, nothing written", async () => {
    const { root, projectId } = await heldRootVia(notFreeUser, "edit-notfree-1");
    const edit = await callTool(notFreeUser.token, "set_caption_text", { jobId: root.id, index: 0, text: "แก้ก่อนส่งออก" });
    check("edit stored", edit.draftRevision === 1, JSON.stringify(edit));
    const baseUrl = parseVideoJobOutput(root.outputJson)?.videoUrl;
    await prisma.chargedClip.deleteMany({ where: { userId: notFreeUser.user.id } });
    const before = {
      money: await money(notFreeUser.user.id),
      jobs: await prisma.videoJob.count({ where: { userId: notFreeUser.user.id } }),
      project: await projectRow(projectId),
    };
    const reply = await callTool(notFreeUser.token, "export_video", { jobId: root.id });
    check("export_not_free envelope", reply.error === "export_not_free" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    check("fixture: the base really is unpaid", baseUrl !== undefined && !(await isBurnAlreadyPaid(notFreeUser.user.id, baseUrl)));
    check("no job written", await prisma.videoJob.count({ where: { userId: notFreeUser.user.id } }) === before.jobs);
    check("no money row written", JSON.stringify(await money(notFreeUser.user.id)) === JSON.stringify(before.money));
    check("the draft is untouched", JSON.stringify(await projectRow(projectId)) === JSON.stringify(before.project));
  });

  // ── J ──
  await section("J) held export billing gate: a chain without exactly one settled charge refuses to deliver", async () => {
    const { root, projectId } = await heldRootVia(gateUser, "edit-gate-1");
    const edit = await callTool(gateUser.token, "set_caption_text", { jobId: root.id, index: 1, text: "การ์ดสองแก้แล้ว" });
    check("edit stored at revision 1", edit.draftRevision === 1, JSON.stringify(edit));
    const reply = await callTool(gateUser.token, "export_video", { jobId: root.id });
    check("export enqueued at revision 1", reply.status === "exporting" && reply.draftRevision === 1, JSON.stringify(reply));
    // The burn stays free (the ChargedClip is kept) but the root's own charge record disappears.
    await prisma.renderJob.deleteMany({ where: { parentJobId: root.id } });
    callerLog.length = 0;
    const failedExport = await runJob(String(reply.exportJobId), gateUser.user.id);
    check("export refused at the release gate", failedExport.status === "failed"
      && String(failedExport.errorMessage).includes("ตรวจสอบการคิดนาที/เครดิตไม่ผ่าน"), String(failedExport.errorMessage));
    check("no Gallery save happened", !callerLog.includes("POST /api/videos"), callerLog.join(","));
    const row = await projectRow(projectId);
    check("a failed export never clears the draft", row.pendingEditRevision === 1
      && draftLib.parsePendingEditDraft(row.pendingEditJson)?.captions[1].text === "การ์ดสองแก้แล้ว", JSON.stringify(row).slice(0, 200));
    const retry = await callTool(gateUser.token, "export_video", { jobId: root.id });
    check("retry after a failed export pins the draft forward to a fresh key",
      retry.status === "exporting" && retry.exportJobId !== reply.exportJobId && retry.draftRevision === 2, JSON.stringify(retry));
    const retryRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(retry.exportJobId) } });
    check("retry key mcp-export:<root>:2 still burns the edit", retryRow.idempotencyKey === chainKey.mcpExportKey(root.id, 2)
      && ((inputOf(retryRow).subtitleOverlayConfig as Json).keywordPopups as Array<{ text: string }>)[1].text === "การ์ดสองแก้แล้ว");
  });

  // ── K ──
  await section("K) G14: every failure reply seen from a new tool is a full envelope", async () => {
    check("at least one failure was exercised per new tool",
      NEW_TOOLS.every((name) => failures.some((failure) => failure.tool === name)), JSON.stringify(failures.map((f) => f.tool)));
    for (const failure of failures) {
      const problems = checkFailureEnvelope(failure.reply);
      check(`${failure.tool} ${String(failure.reply.error)}: envelope`, problems.length === 0, `${problems.join("; ")} ${JSON.stringify(failure.reply)}`);
    }
  });

  globalThis.fetch = realFetch;
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
      console.error("❌ MCP edit draft verification FAILED");
      process.exit(1);
    }
    console.log("✅ MCP edit draft: all checks passed");
    process.exit(0);
  });
