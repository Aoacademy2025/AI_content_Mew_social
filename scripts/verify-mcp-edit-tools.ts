// verify-mcp-edit-tools.ts — T7 (PR-A, plan docs/plans/2026-10-03-mcp-edit-before-export.md):
// the 6 small edit tools that round out the T6 tracer: merge_captions, split_caption,
// regroup_captions (G16), set_subtitle_style (G17), set_headline_hook (G18) and
// discard_edits (G20). Every MCP call goes through the REAL route handler, same harness
// shape as verify-mcp-edit-draft.ts (T6) — only Clerk + the network key preflight stubbed.
//
// A few validation branches are defensive code unreachable through the real protocol because
// the zod schema already restricts the value at the transport layer (e.g. an out-of-enum
// fontWeight/preset/cardLen never reaches our handler — the SDK itself refuses it). Those are
// exercised directly against the exported tool functions ("lib:" checks), exactly like T6's
// CAS section H called `updatePendingEditDraft` directly.
//
// Self-contained: builds its own throwaway SQLite.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-edit-tools.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "mcp-edit-tools-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
process.env.BRAND_ASSET_ROOT = mkdtempSync(join(tmpdir(), "mcp-edit-tools-brand-"));
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

const NEW_TOOLS = [
  "merge_captions", "split_caption", "regroup_captions",
  "set_subtitle_style", "set_headline_hook", "discard_edits",
] as const;

/** 4 Thai "words" with exact startChar/endChar so regroup_captions can be exercised against a
 *  real word timeline (the T6 harness's transcribe stub only ever had 2 whole-segment "words",
 *  missing startChar/endChar — fine for T6, not enough to drive groupTimedCaptionWords here). */
function buildWordsFixture(wordTexts: string[], msPerWord: number) {
  let cursor = 0;
  let charCursor = 0;
  const words: { word: string; startMs: number; endMs: number; startChar: number; endChar: number }[] = [];
  const parts: string[] = [];
  for (const [i, w] of wordTexts.entries()) {
    if (i > 0) { parts.push(" "); charCursor += 1; }
    const startChar = charCursor;
    parts.push(w);
    charCursor += w.length;
    words.push({ word: w, startMs: cursor, endMs: cursor + msPerWord, startChar, endChar: charCursor });
    cursor += msPerWord;
  }
  return { words, fullText: parts.join("") };
}
const WORD_TEXTS = ["อยาก", "กินข้าวเย็นนี้", "ที่ร้านโปรด", "ของฉัน"];
const { words: WORDS, fullText: FULL_TEXT } = buildWordsFixture(WORD_TEXTS, 1000);
const CARD0_TEXT = `${WORD_TEXTS[0]} ${WORD_TEXTS[1]}`; // "อยาก กินข้าวเย็นนี้" — 0..2000ms, hook
const CARD1_TEXT = `${WORD_TEXTS[2]} ${WORD_TEXTS[3]}`; // "ที่ร้านโปรด ของฉัน" — 2000..4000ms, body
const SCRIPT = `${CARD0_TEXT} ${CARD1_TEXT}`;
const TIMING = {
  provider: "gemini",
  segments: [
    { text: CARD0_TEXT, startMs: 0, durationMs: 2_000 },
    { text: CARD1_TEXT, startMs: 2_000, durationMs: 2_000 },
  ],
};
const VOICE_FILE = "/api/renders/edit-tools-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/edit-tools-a.mp4", start: 0, end: 2, sourceIndex: 0, clipDuration: 4 },
    { src: "/api/stocks/edit-tools-b.mp4", start: 2, end: 4, sourceIndex: 1, clipDuration: 4 },
  ],
};
const PROVIDER_PATH = /tts|transcribe|split-script|extract-keywords|fetch-stock|generate-config|heygen|gemini|elevenlabs/i;

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-edit-tools.ts"));
  const fromSrc = (path: string) => realRequire(join(ROOT, "src", path));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const videoJobModule = fromSrc("lib/mcp/video-job") as typeof import("../src/lib/mcp/video-job");
  const { parseVideoJobOutput } = videoJobModule;
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { isBurnAlreadyPaid, recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const draftLib = fromSrc("lib/mcp/pending-edit-draft") as typeof import("../src/lib/mcp/pending-edit-draft");
  const editTools = fromSrc("lib/mcp/edit-tools") as typeof import("../src/lib/mcp/edit-tools");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");
  const brandAssets = fromSrc("lib/brand-assets.server") as typeof import("../src/lib/brand-assets.server");
  const sharp = (realRequire("sharp") as { default: typeof import("sharp") }).default ?? (realRequire("sharp") as typeof import("sharp"));
  /** A real BrandAsset row (tiny PNG on disk) — enqueueEditorExport's logo staging looks the
   *  asset up for real (BrandAssetError "asset_not_found" otherwise), so a synthetic assetId
   *  string alone is not enough to exercise "logo survives an MCP re-export". */
  async function makeLogoAsset(userId: string) {
    const png = await sharp({
      create: { width: 64, height: 32, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    }).png().toBuffer();
    const file = new File([new Uint8Array(png)], "logo.png", { type: "image/png" });
    const asset = await brandAssets.saveBrandAsset({ userId, plan: "PRO", file });
    return asset.id;
  }

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
        "user-agent": "verify-mcp-edit-tools/1.0",
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
    const { token } = await createMcpToken(id, "verify-mcp-edit-tools");
    return { user, token };
  }
  // Internal-tester emails pass the MCP Editor Project gate; example.com does not.
  const tester = await makeUser("u-tools", "qa-tools@aoacademy.co");
  const outsider = await makeUser("u-tools-outsider", "tools-outsider@example.com");

  let renderSeq = 0;
  let gallerySeq = 0;
  const callerLog: string[] = [];
  function makeCaller(userId: string) {
    return {
      async post<T>(path: string, body?: unknown): Promise<T> {
        callerLog.push(`POST ${path}`);
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          return { voiceUrl: VOICE_FILE, audioDurationMs: 4_000, timing: TIMING } as T;
        }
        if (path === "/api/videos/split-script") return { cards: null } as T;
        if (path === "/api/videos/transcribe") {
          return {
            captions: [
              { text: CARD0_TEXT, startMs: 0, endMs: 2_000, tag: "hook" },
              { text: CARD1_TEXT, startMs: 2_000, endMs: 4_000, tag: "body" },
            ],
            words: WORDS,
            fullText: FULL_TEXT,
            audioDurationMs: 4_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_000 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["food"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "food" }] } as T;
        if (path === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-tools-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          const free = isBurn && await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
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
        if (path === "/api/videos") { gallerySeq += 1; return { id: `gallery-tools-${gallerySeq}` } as T; }
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
      select: { pendingEditJson: true, pendingEditRevision: true, activeJobId: true, draftJson: true },
    });
  }
  async function storedDraft(projectId: string) {
    const row = await projectRow(projectId);
    return draftLib.parsePendingEditDraft(row.pendingEditJson);
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
  await section("A) real route tools/list: beta sees the 6 new tools, non-beta does not; schemas are agent-neutral", async () => {
    const betaTools = await listTools(tester.token);
    const betaNames = betaTools.map((tool) => tool.name);
    for (const name of NEW_TOOLS) check(`beta tools/list includes ${name}`, betaNames.includes(name), betaNames.join(","));
    const outsiderNames = (await listTools(outsider.token)).map((tool) => tool.name);
    for (const name of NEW_TOOLS) check(`non-beta tools/list hides ${name}`, !outsiderNames.includes(name));
    const problems = verifyAgentNeutralSchemas(betaTools, NEW_TOOLS);
    check("G13: every new tool's emitted schema is agent-neutral", problems.length === 0, problems.join("; "));
  });

  // ── B ──
  await section("B) non-beta: a direct call of each new tool is refused with feature_not_enabled", async () => {
    const argsFor: Record<string, Json> = {
      merge_captions: { jobId: "any", index: 0 },
      split_caption: { jobId: "any", index: 0, leftText: "x" },
      regroup_captions: { jobId: "any", cardLen: "sentence" },
      set_subtitle_style: { jobId: "any", fontSize: 90 },
      set_headline_hook: { jobId: "any", enabled: true, headline: "x" },
      discard_edits: { jobId: "any" },
    };
    for (const name of NEW_TOOLS) {
      const reply = await callTool(outsider.token, name, argsFor[name]);
      check(`${name}: feature_not_enabled envelope`, reply.error === "feature_not_enabled"
        && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
      const audit = await prisma.toolCallAudit.findFirst({
        where: { userId: outsider.user.id, toolName: name }, orderBy: { createdAt: "desc" },
      });
      check(`${name}: the refusal is audited as denied`, audit?.status === "denied", JSON.stringify(audit));
    }
  });

  // ── C: merge_captions ──
  let held: Awaited<ReturnType<typeof heldRootVia>> | null = null;
  let baseline: Array<{ index: number; text: string; startMs: number; endMs: number }> = [];
  let logoAssetId = "";
  await section("C) merge_captions: joins text, spans both cards' time, shifts overrides; validation codes", async () => {
    held = await heldRootVia(tester, "tools-held-1");
    const { root, projectId } = held;

    // Seed this project as if a PRIOR WEB EXPORT had already run: captionOverrides on both
    // cards + a logoOverlay on the project draft (AC: "captionOverrides and logo survive an
    // MCP re-export of a web-exported project"). MCP never writes either field itself.
    const basePreview = parseVideoJobOutput(root.outputJson)!.preview!;
    const snapshotCaptions = [
      { text: CARD0_TEXT, startMs: 0, endMs: 2_000, tag: "hook" },
      { text: CARD1_TEXT, startMs: 2_000, endMs: 4_000, tag: "body" },
    ];
    const editSnapshot = {
      version: 1,
      captions: snapshotCaptions,
      originalCaptions: snapshotCaptions,
      subtitleConfig: {
        preset: "stroke", effect: "pop", fontFamily: "'Kanit', sans-serif", bold: true, fontWeight: 900,
        fontSize: 80, textColor: "#FFFFFF", accentColor: "#FFE500", shadow: true, outline: false,
        outlineSize: 2, verticalPos: 82,
      },
      cardLen: "sentence",
      captionOverrides: { 0: { accentColor: "#AAAAAA" }, 1: { textColor: "#BBBBBB" } },
      videoUrl: basePreview && parseVideoJobOutput(root.outputJson)!.videoUrl,
      preview: { ...basePreview, captions: snapshotCaptions },
    };
    await prisma.videoJob.create({
      data: {
        userId: tester.user.id, projectId, type: "export", status: "done",
        inputJson: "{}", outputJson: JSON.stringify({ version: 2, videoUrl: editSnapshot.videoUrl, editSnapshot }),
      },
    });
    logoAssetId = await makeLogoAsset(tester.user.id);
    await prisma.editorProject.update({
      where: { id: projectId },
      data: { draftJson: JSON.stringify({ logoOverlay: { enabled: true, assetId: logoAssetId, position: "top-right", sizePct: 20, opacity: 0.8 } }) },
    });

    const state = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    baseline = state.captions as typeof baseline;
    check("fixture: seeded from the web-export snapshot (2 cards, the snapshot's text)",
      baseline.length === 2 && baseline[0].text === CARD0_TEXT && baseline[1].text === CARD1_TEXT, JSON.stringify(baseline));
    check("fixture: the seed is not yet stored (no MCP edit landed)", (await projectRow(projectId)).pendingEditJson === null);

    fetchLog.length = 0;
    const merged = await callTool(tester.token, "merge_captions", { jobId: root.id, index: 0 });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("merge accepted at draftRevision 1 with 1 card now", merged.ok === true && merged.draftRevision === 1
      && merged.cardCount === 1, JSON.stringify(merged));
    const mergedCaption = merged.caption as { text: string; startMs: number; endMs: number };
    check("merged text = card0 + card1 joined (Thai, no inserted space)",
      mergedCaption.text === `${CARD0_TEXT}${CARD1_TEXT}`, mergedCaption.text);
    check("merged card spans both original cards' full time range (coverage preserved)",
      mergedCaption.startMs === baseline[0].startMs && mergedCaption.endMs === baseline[1].endMs, JSON.stringify(mergedCaption));

    const stored = await storedDraft(projectId);
    check("stored captionOverrides: index1 (merged away) dropped, index0's override kept",
      JSON.stringify(stored?.captionOverrides) === JSON.stringify({ 0: { accentColor: "#AAAAAA" } }),
      JSON.stringify(stored?.captionOverrides));
    check("stored logoOverlay survives untouched (MCP never edits it)",
      JSON.stringify(stored?.logoOverlay) === JSON.stringify({ enabled: true, assetId: logoAssetId, position: "top-right", sizePct: 20, opacity: 0.8 }));
    check("originalCaptions are untouched by the merge (still 2 cards)", stored?.originalCaptions.length === 2);

    const bad: Array<[string, Json, string]> = [
      ["merging the last (only) card", { jobId: root.id, index: 0 === 0 ? 0 : 0 }, "invalid_input"], // placeholder, replaced below
    ];
    // After the merge there is exactly 1 card — index 0 is now the last card, so merging it again must refuse.
    const lastRefused = await callTool(tester.token, "merge_captions", { jobId: root.id, index: 0 });
    check("merging the only remaining (last) card → invalid_input", lastRefused.error === "invalid_input"
      && checkFailureEnvelope(lastRefused).length === 0, JSON.stringify(lastRefused));
    const negRefused = await callTool(tester.token, "merge_captions", { jobId: root.id, index: -1 });
    check("negative index → invalid_input", negRefused.error === "invalid_input" && checkFailureEnvelope(negRefused).length === 0);
    const unknownRefused = await callTool(tester.token, "merge_captions", { jobId: "nope", index: 0 });
    check("unknown jobId → invalid_input", unknownRefused.error === "invalid_input" && checkFailureEnvelope(unknownRefused).length === 0);
    check("refusals wrote nothing further", (await projectRow(projectId)).pendingEditRevision === 1);
    void bad;
  });

  // ── D: split_caption ──
  let mergedText = "";
  await section("D) split_caption: proportional cut, leftText-prefix contract, validation codes", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    mergedText = `${CARD0_TEXT}${CARD1_TEXT}`;

    const emptyLeft = await callTool(tester.token, "split_caption", { jobId: root.id, index: 0, leftText: "" });
    check("empty leftText → split_text_mismatch", emptyLeft.error === "split_text_mismatch" && checkFailureEnvelope(emptyLeft).length === 0, JSON.stringify(emptyLeft));
    const notPrefix = await callTool(tester.token, "split_caption", { jobId: root.id, index: 0, leftText: "ไม่ตรงกับข้อความการ์ด" });
    check("leftText that is not the card's own prefix → split_text_mismatch", notPrefix.error === "split_text_mismatch" && checkFailureEnvelope(notPrefix).length === 0, JSON.stringify(notPrefix));
    const wholeText = await callTool(tester.token, "split_caption", { jobId: root.id, index: 0, leftText: mergedText });
    check("leftText equal to the ENTIRE card text → split_text_mismatch (not a proper prefix)", wholeText.error === "split_text_mismatch" && checkFailureEnvelope(wholeText).length === 0, JSON.stringify(wholeText));

    fetchLog.length = 0;
    const leftText = CARD0_TEXT; // a genuine proper prefix of the merged text
    const split = await callTool(tester.token, "split_caption", { jobId: root.id, index: 0, leftText });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("split accepted at draftRevision 2", split.ok === true && split.draftRevision === 2, JSON.stringify(split));
    const [left, right] = split.captions as Array<{ index: number; text: string; startMs: number; endMs: number }>;
    check("left = exactly leftText, right = the remainder", left.text === leftText && right.text === CARD1_TEXT, JSON.stringify([left, right]));
    const expectedCutMs = Math.round((4_000 * leftText.length) / mergedText.length);
    check("cut proportional to characters, exactly like the web's splitCaption",
      left.endMs === expectedCutMs && right.startMs === expectedCutMs, JSON.stringify({ left, right, expectedCutMs }));
    check("left+right span the merged card's FULL original time range (coverage preserved)",
      left.startMs === 0 && right.endMs === 4_000, JSON.stringify([left, right]));

    const stored = await storedDraft(projectId);
    check("split restores 2 cards", stored?.captions.length === 2);
    check("captionOverrides: index0's override (< the split point) is unaffected",
      JSON.stringify(stored?.captionOverrides) === JSON.stringify({ 0: { accentColor: "#AAAAAA" } }), JSON.stringify(stored?.captionOverrides));

    const outOfRange = await callTool(tester.token, "split_caption", { jobId: root.id, index: 5, leftText: "x" });
    check("out-of-range index → invalid_input", outOfRange.error === "invalid_input" && checkFailureEnvelope(outOfRange).length === 0, JSON.stringify(outOfRange));
  });

  // ── E: regroup_captions ──
  await section("E) regroup_captions: from originalCaptions (not the merged/split draft), resets overrides, invalid cardLen", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;

    fetchLog.length = 0;
    const sentence = await callTool(tester.token, "regroup_captions", { jobId: root.id, cardLen: "sentence" });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("cardLen=sentence: back to the 2 ORIGINAL cards (not the split draft's 2 — same shape here, check text)",
      sentence.ok === true && sentence.cardCount === 2, JSON.stringify(sentence));
    let stored = await storedDraft(projectId);
    check("cardLen=sentence restores the original (pre-merge) card texts verbatim",
      stored?.captions[0].text === CARD0_TEXT && stored?.captions[1].text === CARD1_TEXT, JSON.stringify(stored?.captions));
    check("captionOverrides reset to {} by regroup (brand-new card structure)",
      JSON.stringify(stored?.captionOverrides) === "{}", JSON.stringify(stored?.captionOverrides));
    check("logoOverlay still survives (regroup never touches it)", stored?.logoOverlay?.assetId === logoAssetId);

    const twoWord = await callTool(tester.token, "regroup_captions", { jobId: root.id, cardLen: "2" });
    check("cardLen=2 accepted", twoWord.ok === true && typeof twoWord.cardCount === "number" && (twoWord.cardCount as number) >= 1, JSON.stringify(twoWord));
    stored = await storedDraft(projectId);
    const regrouped = stored!.captions;
    check("regroup keeps total time coverage: first card starts at 0, last ends at 4000",
      regrouped[0].startMs === 0 && regrouped[regrouped.length - 1].endMs === 4_000, JSON.stringify(regrouped));
    // groupTimedCaptionWords re-tokenizes the word timeline itself (it does not treat our
    // fixture's "words" as atomic, nor preserve inter-card spacing exactly — flush() trims each
    // card individually) — so compare with whitespace collapsed: no character content may be
    // dropped or added, regardless of exactly where the algorithm places its card boundaries.
    const collapse = (s: string) => s.replace(/\s+/g, "");
    check("regroup keeps the total text (every character reassembled, nothing dropped/added)",
      collapse(regrouped.map((c) => c.text).join("")) === collapse(FULL_TEXT),
      JSON.stringify({ got: regrouped.map((c) => c.text), want: FULL_TEXT }));
    check("cardLen=2 produced a finer grouping than cardLen=sentence (2 cards)", regrouped.length > 2);

    const invalidLenMessage = await rpc(tester.token, "tools/call", { name: "regroup_captions", arguments: { jobId: root.id, cardLen: "sentence-bogus" } });
    const invalidLenText = (invalidLenMessage.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "";
    check("an out-of-enum cardLen never reaches our handler (the SDK's own schema check refuses it first)",
      invalidLenText.includes("-32602") && invalidLenText.includes("invalid_enum_value"), invalidLenText.slice(0, 300));
  });

  // ── F: lib-level defensive validation (bypasses the zod schema, like T6's CAS section) ──
  await section("F) lib-level: validation branches the real protocol's enum schema can never reach", async () => {
    if (!held) throw new Error("no held root");
    const { root } = held;
    const rootRow = { id: root.id, inputJson: root.inputJson, projectId: held.projectId };

    const badCardLen = await editTools.regroupCaptionsTool(tester.user.id, { jobId: root.id, cardLen: "bogus" as never });
    check("lib: regroup_captions with an out-of-set cardLen (direct call) → invalid_input",
      (badCardLen as Json).error === "invalid_input", JSON.stringify(badCardLen));

    const badWeight = await editTools.setSubtitleStyleTool(tester.user.id, {
      jobId: root.id, fontWeight: "700" as never,
    } as never);
    check("lib: set_subtitle_style with an out-of-set fontWeight (direct call) → invalid_input",
      (badWeight as Json).error === "invalid_input", JSON.stringify(badWeight));
    void rootRow;
  });

  // ── G: set_subtitle_style ──
  await section("G) set_subtitle_style: field-by-field, locked-preset colour rule, font-family canonicalization, range validation", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;

    fetchLog.length = 0;
    const styled = await callTool(tester.token, "set_subtitle_style", {
      jobId: root.id, fontFamily: "'Prompt', sans-serif", fontSize: 64, fontWeight: "600",
      textColor: "#102030", accentColor: "#405060", shadow: false, outline: true, outlineSize: 5, verticalPos: 30,
    });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("accepted, every sent field applied", styled.ok === true, JSON.stringify(styled));
    const style1 = styled.subtitleStyle as Json;
    check("every field round-trips exactly, including verticalPos",
      style1.fontFamily === "'Prompt', sans-serif" && style1.fontSize === 64 && style1.fontWeight === "600"
        && style1.textColor === "#102030" && style1.accentColor === "#405060" && style1.shadow === false
        && style1.outline === true && style1.outlineSize === 5 && style1.verticalPos === 30,
      JSON.stringify(style1));

    const partial = await callTool(tester.token, "set_subtitle_style", { jobId: root.id, fontSize: 100 });
    check("a partial call changes only the sent field, keeps the rest",
      (partial.subtitleStyle as Json).fontSize === 100 && (partial.subtitleStyle as Json).fontFamily === "'Prompt', sans-serif"
        && (partial.subtitleStyle as Json).verticalPos === 30, JSON.stringify(partial.subtitleStyle));

    // Locked-preset colour rule: switching to a locked preset AND sending a colour in the same
    // call → the colour is ignored (not stored), matching the web's RightSettingsPanel rule.
    const locked = await callTool(tester.token, "set_subtitle_style", {
      jobId: root.id, preset: "hormozi", textColor: "#ABCDEF", accentColor: "#FEDCBA",
    });
    check("switching to a locked preset + sending colours → ok with ignoredFields naming both",
      locked.ok === true && Array.isArray(locked.ignoredFields)
        && (locked.ignoredFields as string[]).includes("textColor") && (locked.ignoredFields as string[]).includes("accentColor"),
      JSON.stringify(locked));
    check("the ignored colours were never stored (preset's own colours still govern the burn)",
      (locked.subtitleStyle as Json).textColor !== "#ABCDEF" && (locked.subtitleStyle as Json).accentColor !== "#FEDCBA",
      JSON.stringify(locked.subtitleStyle));
    const unlocked = await callTool(tester.token, "set_subtitle_style", { jobId: root.id, preset: "stroke", textColor: "#ABCDEF" });
    check("switching OFF the locked preset lets a colour apply normally (no ignoredFields)",
      unlocked.ok === true && unlocked.ignoredFields === undefined && (unlocked.subtitleStyle as Json).textColor === "#ABCDEF",
      JSON.stringify(unlocked));

    // T7 advisory b (PR-A fix round): snapshot the revision BEFORE the loop. The previous
    // assertion compared `projectRow().pendingEditRevision` to `(await storedDraft(...),
    // (await projectRow()).pendingEditRevision)` — a comma-operator expression that discards
    // storedDraft's result and re-reads projectRow() a second time, so it was really comparing
    // the same post-loop value to itself and would pass even if a refusal had written.
    const revisionBeforeRefusals = (await projectRow(projectId)).pendingEditRevision;
    for (const [label, args] of [
      ["fontSize too small", { jobId: root.id, fontSize: 10 }],
      ["fontSize too large", { jobId: root.id, fontSize: 500 }],
      ["outlineSize out of range", { jobId: root.id, outlineSize: 20 }],
      ["verticalPos out of range", { jobId: root.id, verticalPos: 99 }],
      ["textColor bad hex format", { jobId: root.id, textColor: "red" }],
      ["accentColor bad hex format", { jobId: root.id, accentColor: "#ZZZZZZ" }],
    ] as const) {
      const refused = await callTool(tester.token, "set_subtitle_style", args);
      check(`${label} → invalid_input`, refused.error === "invalid_input" && checkFailureEnvelope(refused).length === 0, JSON.stringify(refused));
    }
    check(
      "refusals wrote nothing (revision unchanged by the bad calls)",
      (await projectRow(projectId)).pendingEditRevision === revisionBeforeRefusals,
    );

    // Font-family canonicalization (T6 deviation #4): a draft stored with the legacy BARE
    // family name reads back canonical, and any style edit upgrades it going forward even when
    // fontFamily itself is not the field being changed.
    const row = await projectRow(projectId);
    const legacy = draftLib.parsePendingEditDraft(row.pendingEditJson)!;
    const bareSeed = { ...legacy, subtitleConfig: { ...legacy.subtitleConfig, fontFamily: "Kanit" } };
    await prisma.editorProject.update({
      where: { id: projectId },
      data: { pendingEditJson: JSON.stringify(bareSeed), pendingEditRevision: row.pendingEditRevision },
    });
    const bareState = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    check("get_edit_state canonicalizes a legacy bare fontFamily for display",
      (bareState.subtitleStyle as Json).fontFamily === "'Kanit', sans-serif", JSON.stringify(bareState.subtitleStyle));
    const upgraded = await callTool(tester.token, "set_subtitle_style", { jobId: root.id, fontSize: 70 });
    check("a style edit upgrades the STORED fontFamily to canonical even without touching it",
      (upgraded.subtitleStyle as Json).fontFamily === "'Kanit', sans-serif"
        && draftLib.parsePendingEditDraft((await projectRow(projectId)).pendingEditJson)?.subtitleConfig.fontFamily === "'Kanit', sans-serif",
      JSON.stringify(upgraded.subtitleStyle));

    // T7 advisory a (PR-A fix round): regroup_captions passes the CURRENT subtitleConfig.fontSize
    // into regroupCaptions's Card Line Budget, not a hardcoded 80 — every earlier regroup_captions
    // test in section E ran before any set_subtitle_style call, so this was never exercised.
    // At this draft's actual (Thai-segmented) word timeline, cardLen:"3" fits 3 words per card
    // within maxCardCharsFor(80)'s 24-char budget (3 cards total); maxCardCharsFor(160)'s tighter
    // 12-char budget forces an early split inside the 3rd group, producing a 4th card — a
    // difference only possible if the current fontSize actually reaches groupTimedCaptionWords
    // instead of a hardcoded 80.
    const beforeMaxSize = await callTool(tester.token, "regroup_captions", { jobId: root.id, cardLen: "3" });
    check(
      "cardLen=3 at the default fontSize (80) groups into 3 cards",
      beforeMaxSize.ok === true && beforeMaxSize.cardCount === 3,
      JSON.stringify(beforeMaxSize),
    );
    const atMaxFontSize = await callTool(tester.token, "set_subtitle_style", { jobId: root.id, fontSize: 160 });
    check("fontSize set to the allowed max (160)", atMaxFontSize.ok === true && (atMaxFontSize.subtitleStyle as Json).fontSize === 160, JSON.stringify(atMaxFontSize));
    const regroupedAtMaxSize = await callTool(tester.token, "regroup_captions", { jobId: root.id, cardLen: "3" });
    check(
      "the SAME cardLen=3 call at fontSize=160 instead produces 4 cards (tighter Card Line Budget forces an extra split)",
      regroupedAtMaxSize.ok === true && regroupedAtMaxSize.cardCount === 4,
      JSON.stringify(regroupedAtMaxSize),
    );
  });

  // ── H: set_headline_hook ──
  await section("H) set_headline_hook: merges onto the current config, clamps via normalizeHeadlineHook", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    const noneYet = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    check("fixture: no headline yet", noneYet.headlineHook === null);

    // This fixture's total clip duration is 4000ms, and clampHeadlineHookDurationMs clamps to
    // min(MAX_HEADLINE_HOOK_DURATION_MS, totalDurationMs) — so 3_500 (inside [3000,4000]) is the
    // value to use for a plain round-trip; a too-large value below clamps to the CLIP length
    // (4000), not to the flat 20_000 ceiling — that distinction is exercised separately below.
    fetchLog.length = 0;
    const set = await callTool(tester.token, "set_headline_hook", {
      jobId: root.id, enabled: true, headline: "สูตรเด็ดวันนี้", preset: "news", topPercent: 20, durationMs: 3_500,
    });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("accepted and enabled", set.ok === true, JSON.stringify(set));
    const hook1 = set.headlineHook as Json;
    check("fields round-trip", hook1.enabled === true && hook1.headline === "สูตรเด็ดวันนี้" && hook1.preset === "news" && hook1.topPercent === 20 && hook1.durationMs === 3_500, JSON.stringify(hook1));

    const partial = await callTool(tester.token, "set_headline_hook", { jobId: root.id, subheadline: "อร่อยสุดๆ" });
    const hook2 = partial.headlineHook as Json;
    check("a partial call MERGES onto the current config (headline/preset/etc. survive)",
      hook2.headline === "สูตรเด็ดวันนี้" && hook2.preset === "news" && hook2.subheadline === "อร่อยสุดๆ", JSON.stringify(hook2));

    const clamped = await callTool(tester.token, "set_headline_hook", {
      jobId: root.id, topPercent: 5, durationMs: 999_999, fontSize: 10, subheadlineFontSize: 500,
    });
    const hook3 = clamped.headlineHook as Json;
    check("out-of-range numeric fields clamp via normalizeHeadlineHook instead of refusing (durationMs clamps to this clip's 4000ms, below the flat 20000 ceiling)",
      hook3.topPercent === 10 && hook3.durationMs === 4_000 && hook3.fontSize === 52 && hook3.subheadlineFontSize === 88,
      JSON.stringify(hook3));

    const disabled = await callTool(tester.token, "set_headline_hook", { jobId: root.id, enabled: false });
    check("enabled:false disables while keeping the rest of the config", (disabled.headlineHook as Json).enabled === false
      && (disabled.headlineHook as Json).headline === "สูตรเด็ดวันนี้", JSON.stringify(disabled.headlineHook));
    // Re-enable for the final combined export check below.
    await callTool(tester.token, "set_headline_hook", { jobId: root.id, enabled: true });
    void projectId;
  });

  // ── I: the final export reflects every T7 edit together (captions + style + headline + logo) ──
  await section("I) export_video after merge+split+regroup+style+headline: subtitleOverlayConfig reflects all of it", async () => {
    if (!held) throw new Error("no held root");
    const { root, projectId } = held;
    const moneyBefore = await money(tester.user.id);
    fetchLog.length = 0;
    const reply = await callTool(tester.token, "export_video", { jobId: root.id });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("export enqueued free", reply.status === "exporting" && typeof reply.exportJobId === "string", JSON.stringify(reply));
    const exportRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(reply.exportJobId) } });
    const exportInput = inputOf(exportRow);
    const overlay = exportInput.subtitleOverlayConfig as Json;
    const stored = draftLib.parsePendingEditDraft((await projectRow(projectId)).pendingEditJson)!;
    check("final captions = the last regroup's result (every earlier merge/split superseded)",
      JSON.stringify((overlay.keywordPopups as Array<{ text: string }>).map((p) => p.text)) === JSON.stringify(stored.captions.map((c) => c.text)),
      JSON.stringify(overlay.keywordPopups));
    check("final style: fontFamily canonical + fontSize from the last set_subtitle_style call",
      overlay.fontFamily === "'Kanit', sans-serif" && overlay.subtitleOutlineSize === 5, JSON.stringify({ fontFamily: overlay.fontFamily, outlineSize: overlay.subtitleOutlineSize }));
    const headline = overlay.headlineHook as Json;
    check("final headlineHook is enabled with the set text/preset", headline?.enabled === true && headline?.headline === "สูตรเด็ดวันนี้" && headline?.preset === "news", JSON.stringify(headline));
    const logo = overlay.logoOverlay as Json;
    // enqueueEditorExport stages the client's {assetId,...} into a server-trusted render input
    // (a resolved snapshot file + intrinsic dimensions) rather than passing assetId through
    // verbatim — so "survives" means the STAGED LOGO actually exists and carries our position/
    // size/opacity forward, not that the literal assetId field reappears.
    check("the web-exported project's logo still rides along into the MCP export (staged, position/size/opacity preserved)",
      typeof logo?.src === "string" && /^\/api\/renders\/logo-snapshot-.+\.webp$/.test(logo.src as string)
        && logo?.position === "top-right" && logo?.sizePct === 20 && logo?.opacity === 0.8,
      JSON.stringify(logo));
    check("still free: no reservation/ChargedClip/provider call", JSON.stringify(await money(tester.user.id)) === JSON.stringify(moneyBefore));

    callerLog.length = 0;
    const done = await runJob(String(reply.exportJobId), tester.user.id);
    check("export finished", done.status === "done", String(done.errorMessage));
    check("G3: no provider call during the export", callerLog.filter((entry) => PROVIDER_PATH.test(entry)).length === 0, callerLog.join(","));
    check("money untouched after the burn actually ran", JSON.stringify(await money(tester.user.id)) === JSON.stringify(moneyBefore));
  });

  // ── J: re-export after a completed export is free, repeatedly, with a fresh key each time ──
  await section("J) re-export after a completed export: free every time, new idempotency key, stays within the in-flight cap", async () => {
    const { root, projectId } = await heldRootVia(tester, "tools-reexport-1");
    const moneyBefore = await money(tester.user.id);
    let previousExportId = "";
    const seenKeys = new Set<string>();
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const reply = await callTool(tester.token, "export_video", { jobId: root.id });
      check(`cycle ${cycle}: export enqueued`, reply.status === "exporting" && typeof reply.exportJobId === "string"
        && reply.exportJobId !== previousExportId, JSON.stringify(reply));
      const row = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(reply.exportJobId) } });
      // Each export's base is the project's current activeJobId (G9/G20), which moves forward
      // to the export that just finished — so the key's revision naturally advances cycle over
      // cycle even with no explicit edits; assert the namespace + per-cycle uniqueness rather
      // than a hardcoded revision number.
      check(`cycle ${cycle}: key is in the mcp-export: namespace for this root, and new`,
        row.idempotencyKey?.startsWith(`mcp-export:${root.id}:`) && !seenKeys.has(row.idempotencyKey!), row.idempotencyKey ?? "");
      seenKeys.add(row.idempotencyKey!);
      const done = await runJob(row.id, tester.user.id);
      check(`cycle ${cycle}: finished`, done.status === "done", String(done.errorMessage));
      previousExportId = row.id;
      // Never more than the root + the exports already finished are "in flight" (all done).
      const inflight = await prisma.videoJob.count({ where: { userId: tester.user.id, status: { in: ["queued", "processing", "waiting_provider"] } } });
      check(`cycle ${cycle}: nothing left in-flight after the export finishes`, inflight === 0);
    }
    check("3 completed export cycles cost nothing beyond the original held preview",
      JSON.stringify(await money(tester.user.id)) === JSON.stringify(moneyBefore));
    void projectId;
  });

  // ── K: discard_edits ──
  await section("K) discard_edits: resets captions/style/headline to a fresh seed of the current base", async () => {
    const { root, projectId } = await heldRootVia(tester, "tools-discard-1");
    const seed = await callTool(tester.token, "get_edit_state", { jobId: root.id });

    // Before any edit: discard still performs a (no-op-ish) reseed and bumps the revision.
    const freshDiscard = await callTool(tester.token, "discard_edits", { jobId: root.id });
    check("discard on a never-edited draft still succeeds and bumps the revision",
      freshDiscard.ok === true && freshDiscard.draftRevision === 1, JSON.stringify(freshDiscard));

    await callTool(tester.token, "set_caption_text", { jobId: root.id, index: 0, text: "แก้ก่อนล้าง" });
    await callTool(tester.token, "set_subtitle_style", { jobId: root.id, fontSize: 140, verticalPos: 15 });
    await callTool(tester.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: "พาดหัวก่อนล้าง" });
    const edited = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    check("fixture: the edits really landed before discarding",
      (edited.captions as Array<{ text: string }>)[0].text === "แก้ก่อนล้าง"
        && (edited.subtitleStyle as Json).fontSize === 140 && (edited.headlineHook as Json)?.headline === "พาดหัวก่อนล้าง");

    fetchLog.length = 0;
    const discard = await callTool(tester.token, "discard_edits", { jobId: root.id });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    check("discard accepted with a new revision", discard.ok === true && typeof discard.draftRevision === "number"
      && (discard.draftRevision as number) > (edited.draftRevision as number), JSON.stringify(discard));

    const after = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    check("captions back to the seed's original text", (after.captions as Array<{ text: string }>)[0].text === (seed.captions as Array<{ text: string }>)[0].text, JSON.stringify(after.captions));
    check("subtitleStyle back to the design default (fontSize 80, verticalPos 82)",
      (after.subtitleStyle as Json).fontSize === 80 && (after.subtitleStyle as Json).verticalPos === 82, JSON.stringify(after.subtitleStyle));
    check("headlineHook cleared (no project-level headline for this fixture)", after.headlineHook === null);
    void projectId;
  });

  // ── L: G14 — every failure reply seen from a new tool is a full envelope ──
  await section("L) G14: every failure reply seen from a new tool is a full envelope", async () => {
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
      console.error("❌ MCP edit tools verification FAILED");
      process.exit(1);
    }
    console.log("✅ MCP edit tools: all checks passed");
    process.exit(0);
  });
