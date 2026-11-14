// verify-mcp-batch-and-script-tools.ts — HERO-96 end-to-end verification:
//   (A) Agent-neutral schema compliance (G13) across ALL MCP tools exposed by `/api/mcp`,
//       including `batch_edit_video`, `list_brand_profiles`, and `generate_hero_script`,
//       plus beta-gate parity on `batch_edit_video`.
//   (B) `batch_edit_video`: atomic single-round-trip application of template + regroup +
//       parallel caption updates + subtitle overrides + headline hook + BGM + tailHoldMs +
//       B-roll style overrides, persisted in ONE CAS revision bump and carried through `export_video`.
//   (C) `batch_edit_video` all-or-nothing atomicity: invalid sub-edits return G14
//       `{ error, code, message, next }` envelopes with ZERO partial mutation on `PendingEditDraft`.
//   (D) `list_brand_profiles`: owner-scoped active/published Brand Profiles (excluding foreign,
//       archived, frozen, and revision-0 rows) with `stylePackId` + `visualSummary` + `next`.
//   (E) `generate_hero_script`: FREE / Conversion-Trial / feature-off refusals, foreign brand IDOR
//       guard, topic validation, OpenRouter provider pipeline with banned-word retry guard,
//       `saveToLibrary` true/false persistence, privacy-safe audit logging, and
//       `ScriptGenerationUsage` slot reservation + release on provider failure.
//
// Self-contained: builds its own throwaway SQLite DB.
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-batch-and-script-tools.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "hero96-mcp-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
process.env.BRAND_ASSET_ROOT = mkdtempSync(join(tmpdir(), "hero96-brand-"));
process.env.MANAGED_STOCK = "1";
process.env.MANAGED_PEXELS_API_KEY = "team_pexels_server_key";
process.env.HERO_SCRIPT_PROVIDER = "openrouter";
process.env.OPENROUTER_API_KEY = "or-hero96-test-key";
process.env.HERO_SCRIPT_PAID_ENABLED = "1";
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
]) {
  delete process.env[key];
}
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
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

function buildWordsFixture(wordTexts: string[], msPerWord: number) {
  let cursor = 0;
  let charCursor = 0;
  const words: { word: string; startMs: number; endMs: number; startChar: number; endChar: number }[] = [];
  const parts: string[] = [];
  for (const [i, w] of wordTexts.entries()) {
    if (i > 0) {
      parts.push(" ");
      charCursor += 1;
    }
    const startChar = charCursor;
    parts.push(w);
    charCursor += w.length;
    words.push({ word: w, startMs: cursor, endMs: cursor + msPerWord, startChar, endChar: charCursor });
    cursor += msPerWord;
  }
  return { words, fullText: parts.join("") };
}

const WORD_TEXTS = ["ของดี", "สุดคุ้ม", "ลดแรง", "ซื้อเลย"];
const { words: WORDS, fullText: FULL_TEXT } = buildWordsFixture(WORD_TEXTS, 1_000);
const CARD0_TEXT = `${WORD_TEXTS[0]} ${WORD_TEXTS[1]}`;
const CARD1_TEXT = `${WORD_TEXTS[2]} ${WORD_TEXTS[3]}`;
const SCRIPT = `${CARD0_TEXT} ${CARD1_TEXT}`;
const TIMING = {
  provider: "gemini",
  segments: [
    { text: CARD0_TEXT, startMs: 0, durationMs: 2_000 },
    { text: CARD1_TEXT, startMs: 2_000, durationMs: 2_000 },
  ],
};
const VOICE_FILE = "/api/renders/hero96-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/hero96-a.mp4", start: 0, end: 2, sourceIndex: 0, clipDuration: 4 },
    { src: "/api/stocks/hero96-b.mp4", start: 2, end: 4, sourceIndex: 1, clipDuration: 4 },
  ],
};

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-batch-and-script-tools.ts"));
  const fromSrc = (path: string) => realRequire(join(ROOT, "src", path));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const editTools = fromSrc("lib/mcp/edit-tools") as typeof import("../src/lib/mcp/edit-tools");
  const brandScriptTools = fromSrc("lib/mcp/brand-script-tools") as typeof import("../src/lib/mcp/brand-script-tools");
  const brandLibrary = fromSrc("lib/brand-profile-library.server") as typeof import("../src/lib/brand-profile-library.server");
  const heroScriptServer = fromSrc("lib/hero-script.server") as typeof import("../src/lib/hero-script.server");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");
  const { VISUAL_FORMATS } = fromSrc("lib/brand-visual-system") as typeof import("../src/lib/brand-visual-system");

  // ── Compile REAL MCP route with only Clerk + network key-preflight stubbed ──
  const routeRequire = (specifier: string): unknown => {
    if (specifier === "server-only") return {};
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
    routeRequire,
    routeModule,
    routeModule.exports,
  );
  const ROUTE_POST = routeModule.exports.POST as (request: Request) => Promise<Response>;

  let rpcSeq = 0;
  async function rpc(token: string, method: string, params: unknown): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "authorization": `Bearer ${token}`,
        "user-agent": "verify-mcp-batch-and-script-tools/1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq, method, params }),
    }));
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine ? dataLine.slice(6) : body) as Json;
  }

  async function listTools(token: string) {
    const message = await rpc(token, "tools/list", {});
    return ((message.result as Json | undefined)?.tools ?? []) as Array<{ name: string; inputSchema?: Json }>;
  }

  async function callTool(token: string, name: string, args: Json): Promise<Json> {
    const message = await rpc(token, "tools/call", { name, arguments: args });
    const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    return JSON.parse(text) as Json;
  }

  // ── Seed music tracks & test principals ──
  await prisma.music.createMany({
    data: [
      { id: "m-upbeat", title: "Fresh Pop Cart", filename: "fresh-pop-cart.mp3", mood: "upbeat" },
      { id: "m-chill", title: "Lofi Peaceful Breeze", filename: "lofi-peaceful-breeze.mp3", mood: "chill" },
      { id: "m-corp", title: "Corporate Smart Brief", filename: "corporate-smart-brief.mp3", mood: "corporate" },
      { id: "m-drama", title: "Cinematic Midnight Tension", filename: "cinematic-midnight-tension.mp3", mood: "dramatic" },
    ],
  });

  const now = new Date();
  const future30d = new Date(now.getTime() + 30 * 24 * 60 * 60_000);

  // 1) Beta + cash-paid PRO user (passes MCP Editor Project gate + Hero Script paid gate)
  await prisma.user.create({
    data: {
      id: "u-beta-paid",
      name: "Beta Paid PRO",
      email: "qa-hero96@aoacademy.co",
      plan: "PRO",
      minutesLimit: 80,
      minutesUsed: 0,
      usagePeriodStartedAt: now,
      trialEndsAt: null,
      usageLimit: 100,
      usageCount: 0,
      geminiVoiceName: "Aoede",
      geminiKey: "g-key",
      subStatus: "active",
      stripeSubscriptionId: "sub_hero96_beta",
      planExpiresAt: future30d,
    },
  });
  await prisma.payment.create({
    data: {
      userId: "u-beta-paid",
      stripeSessionId: "cs_hero96_beta",
      plan: "PRO",
      amount: 59_900,
      status: "PAID",
      periodDays: 30,
      paidAt: now,
    },
  });
  const { token: betaToken } = await createMcpToken("u-beta-paid", "hero96-beta");

  // 2) External (non-beta) cash-paid PRO user (passes Hero Script paid gate, outside MCP edit beta gate)
  await prisma.user.create({
    data: {
      id: "u-ext-paid",
      name: "External Paid PRO",
      email: "paid-customer@example.com",
      plan: "PRO",
      minutesLimit: 80,
      minutesUsed: 0,
      usagePeriodStartedAt: now,
      trialEndsAt: null,
      usageLimit: 100,
      usageCount: 0,
      geminiVoiceName: "Aoede",
      geminiKey: "g-ext",
      subStatus: "active",
      stripeSubscriptionId: "sub_hero96_ext",
      planExpiresAt: future30d,
    },
  });
  await prisma.payment.create({
    data: {
      userId: "u-ext-paid",
      stripeSessionId: "cs_hero96_ext",
      plan: "PRO",
      amount: 59_900,
      status: "PAID",
      periodDays: 30,
      paidAt: now,
    },
  });
  const { token: extPaidToken } = await createMcpToken("u-ext-paid", "hero96-ext-paid");

  // 3) External Conversion-Trial PRO user (effectivePlan = PRO for MCP access, but NO cash payment -> Hero Script payment_required!)
  await prisma.user.create({
    data: {
      id: "u-trial",
      name: "Trial PRO",
      email: "trial-customer@example.com",
      plan: "PRO",
      minutesLimit: 80,
      minutesUsed: 0,
      usagePeriodStartedAt: now,
      trialEndsAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      usageLimit: 100,
      usageCount: 0,
      subStatus: "trialing",
      stripeSubscriptionId: "sub_hero96_trial",
      planExpiresAt: future30d,
    },
  });
  const { token: trialToken } = await createMcpToken("u-trial", "hero96-trial");

  // 4) FREE plan user (blocked at MCP runTool plan guard)
  const freeUser = await prisma.user.create({
    data: {
      id: "u-free",
      name: "Free User",
      email: "free-customer@example.com",
      plan: "FREE",
      minutesLimit: 5,
      minutesUsed: 0,
      usagePeriodStartedAt: now,
      usageLimit: 3,
      usageCount: 0,
    },
  });
  const { token: freeToken } = await createMcpToken("u-free", "hero96-free");

  // ── Stub pipeline caller for Held-Preview VideoJob creation & export ──
  let renderSeq = 0;
  let gallerySeq = 0;
  let providerCalls = 0;
  function makeCaller(userId: string) {
    return {
      async post<T>(path: string, body?: unknown): Promise<T> {
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          providerCalls += 1;
          return { voiceUrl: VOICE_FILE, audioDurationMs: 4_000, timing: TIMING } as T;
        }
        if (path === "/api/videos/split-script") return { cards: null } as T;
        if (path === "/api/videos/transcribe") {
          providerCalls += 1;
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
          providerCalls += 1;
          return { keywords: ["shopping"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") {
          providerCalls += 1;
          return { results: [{ videoUrl: "stock1.mp4", keyword: "shopping" }] } as T;
        }
        if (path === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string; rerenderOf?: { sourceJobId?: string } };
          const isBurn = !!request.subtitleOverlayConfig;
          const isRerender = !!request.rerenderOf?.sourceJobId;
          const id = `rj-hero96-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          const free = isRerender || isBurn;
          await prisma.renderJob.create({
            data: {
              id,
              userId,
              parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER",
              status: "DONE",
              payload: JSON.stringify(body ?? {}),
              videoUrl,
              reservedQuota: !free,
              reservedMinutes: free ? null : 1,
            },
          });
          if (!free) {
            await prisma.user.update({ where: { id: userId }, data: { minutesUsed: { increment: 1 } } });
            await recordChargedClip(userId, videoUrl, 1);
          }
          return { jobId: id } as T;
        }
        if (path.startsWith("/api/videos/render-cancel")) return {} as T;
        if (path === "/api/videos") {
          gallerySeq += 1;
          return { id: `gallery-hero96-${gallerySeq}` } as T;
        }
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(): Promise<T> {
        return {} as T;
      },
      async get<T>(path: string): Promise<T> {
        if (path.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(path)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          return { progress: 100, videoUrl: rj?.videoUrl ?? null, error: null, stage: "done" } as T;
        }
        if (path === "/api/music") {
          const rows = await prisma.music.findMany({ orderBy: { createdAt: "desc" } });
          return { tracks: rows, userTracks: [] } as T;
        }
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

  // ── Section A: Agent-neutral schemas (G13) & beta gating ──
  await section("A. Agent-neutral schema compliance (G13) & gating for batch_edit_video + upstream Brand/Script tools", async () => {
    const listedBeta = await listTools(betaToken);
    const betaNames = listedBeta.map((t) => t.name);
    check(
      "MCP_EDIT_TOOL_NAMES includes batch_edit_video",
      (editTools.MCP_EDIT_TOOL_NAMES as readonly string[]).includes("batch_edit_video"),
    );
    check(
      "MCP_BRAND_SCRIPT_TOOL_NAMES lists list_brand_profiles and generate_hero_script",
      brandScriptTools.MCP_BRAND_SCRIPT_TOOL_NAMES.join(",") === "list_brand_profiles,generate_hero_script",
    );
    check(
      "beta principal tools/list includes batch_edit_video, list_brand_profiles, and generate_hero_script",
      betaNames.includes("batch_edit_video")
        && betaNames.includes("list_brand_profiles")
        && betaNames.includes("generate_hero_script"),
      betaNames.join(", "),
    );

    const allSchemaProblems = verifyAgentNeutralSchemas(listedBeta, betaNames);
    check(
      "every listed MCP tool passes verifyAgentNeutralSchemas (G13: flat primitives / primitive arrays / string enums, zero oneOf/anyOf/nested objects)",
      allSchemaProblems.length === 0,
      allSchemaProblems.join("; "),
    );

    // Non-beta principal: batch_edit_video is hidden from tools/list and returns G14 feature_not_enabled on direct call;
    // upstream Brand & Script tools remain available on tools/list.
    const listedExt = await listTools(extPaidToken);
    const extNames = listedExt.map((t) => t.name);
    check(
      "non-beta principal tools/list hides batch_edit_video while listing list_brand_profiles and generate_hero_script",
      !extNames.includes("batch_edit_video")
        && extNames.includes("list_brand_profiles")
        && extNames.includes("generate_hero_script"),
    );
    const hiddenCall = await callTool(extPaidToken, "batch_edit_video", { jobId: "vj-none", tailHoldMs: 500 });
    check(
      "non-beta direct call to batch_edit_video returns G14 feature_not_enabled envelope",
      hiddenCall.error === "feature_not_enabled" && checkFailureEnvelope(hiddenCall).length === 0,
      JSON.stringify(hiddenCall),
    );
  });

  // ── Section B: batch_edit_video atomic multi-edit round-trip + export carry-through ──
  let heldJobId = "";
  await section("B. batch_edit_video applies multiple held-preview edits atomically in one round-trip", async () => {
    const created = await callTool(betaToken, "create_video_job", {
      script: SCRIPT,
      title: "HERO-96 Batch Edit Clip",
      brollSource: "stock",
      exportMode: "hold",
    });
    heldJobId = String(created.jobId ?? "");
    check("create_video_job(exportMode:'hold') created held job", heldJobId.length > 0, JSON.stringify(created));

    const heldRow = await runJob(heldJobId, "u-beta-paid");
    check("held preview orchestrator finished base render (status === 'done')", heldRow.status === "done", heldRow.status);

    const initialState = await callTool(betaToken, "get_edit_state", { jobId: heldJobId });
    const initialCaptions = Array.isArray(initialState.captions) ? initialState.captions : [];
    check("initial get_edit_state has draftRevision === 0 and 2 cards", initialState.draftRevision === 0 && initialCaptions.length === 2, JSON.stringify(initialState));
    check("get_edit_state.next mentions batch_edit_video", String(initialState.next ?? "").includes("batch_edit_video"));

    const providerCallsBeforeBatch = providerCalls;
    const batchReply = await callTool(betaToken, "batch_edit_video", {
      jobId: heldJobId,
      templateId: "shop-review",
      includeTemplateMusic: true,
      regroupCardLen: "1",
      captionIndices: [0, 3],
      captionTexts: ["เปิดหัวแรง", "รีบกดเลย"],
      subtitlePreset: "sharp-outline",
      fontSize: 72,
      textColor: "#FAFAFA",
      accentColor: "#FF3B30",
      highlightKeywords: false,
      statCards: true,
      verticalPos: 50,
      headlineHookEnabled: true,
      headlineHookText: "โปรเด็ดวันนี้",
      headlineHookSubtext: "ลดเฉพาะไลฟ์นี้",
      headlineHookPreset: "news",
      headlineHookDurationMs: 3500,
      bgmVolume: 0.28,
      bgmDucking: false,
      tailHoldMs: 1200,
      sfxMode: "none",
      brollTransition: "dissolve",
      punchZoom: false,
      brollWindowIndex: 0,
      brollFit: "contain",
    });

    check("batch_edit_video returned ok === true", batchReply.ok === true, JSON.stringify(batchReply));
    check(
      "batch_edit_video bumped draftRevision by exactly 1 (atomic single write)",
      batchReply.draftRevision === 1,
      JSON.stringify(batchReply),
    );
    check("batch_edit_video issued zero paid provider calls", providerCalls === providerCallsBeforeBatch);
    const applied = Array.isArray(batchReply.applied) ? (batchReply.applied as string[]) : [];
    check(
      "batch_edit_video compact summary lists all applied categories",
      applied.includes("template:shop-review")
        && applied.includes("regroup:1")
        && applied.includes("captions:2")
        && applied.includes("subtitle_style")
        && applied.includes("headline_hook")
        && applied.includes("bgm:update")
        && applied.includes("tail_hold")
        && applied.includes("sfx:none")
        && applied.includes("punch_zoom:false")
        && applied.includes("broll_window:0"),
      JSON.stringify(applied),
    );
    check(
      "batch_edit_video next points to export_video / get_preview_frame",
      String(batchReply.next ?? "").includes("export_video") && String(batchReply.next ?? "").includes("get_preview_frame"),
    );

    const afterState = await callTool(betaToken, "get_edit_state", { jobId: heldJobId });
    const captions = afterState.captions as Array<{ index: number; text: string }>;
    const sub = afterState.subtitleStyle as Record<string, unknown>;
    const hook = afterState.headlineHook as Record<string, unknown>;
    const music = afterState.backgroundMusic as Record<string, unknown>;
    const windows = afterState.windows as Array<Record<string, unknown>>;
    check("regroup + parallel caption updates produced 7 single-word Thai cards with updated [0] and [3]", captions.length === 7 && captions[0]?.text === "เปิดหัวแรง" && captions[3]?.text === "รีบกดเลย", JSON.stringify(captions));
    check(
      "explicit subtitle overrides beat template defaults in same batch call",
      sub.preset === "sharp-outline"
        && sub.fontSize === 72
        && sub.textColor === "#FAFAFA"
        && sub.accentColor === "#FF3B30"
        && sub.highlightKeywords === false
        && sub.statCards === true
        && sub.verticalPos === 50,
      JSON.stringify(sub),
    );
    check(
      "headlineHook overrides applied cleanly",
      hook.enabled === true
        && hook.headline === "โปรเด็ดวันนี้"
        && hook.subheadline === "ลดเฉพาะไลฟ์นี้"
        && hook.preset === "news"
        && hook.durationMs === 3500,
      JSON.stringify(hook),
    );
    check(
      "template music + explicit bgmVolume (28%) & bgmDucking (false) applied",
      music.title === "Fresh Pop Cart" && music.volume === 28 && music.ducking === false && music.changed === true,
      JSON.stringify(music),
    );
    check("tailHoldMs === 1200", afterState.tailHoldMs === 1200);
    check(
      "explicit B-roll style overrides beat template defaults + window[0] transition='dissolve' & fit='contain'",
      afterState.sfxMode === "none"
        && afterState.punchZoom === false
        && windows[0]?.transition === "dissolve"
        && windows[0]?.fit === "contain",
      JSON.stringify({ sfxMode: afterState.sfxMode, brollTransition: afterState.brollTransition, punchZoom: afterState.punchZoom, w0: windows[0] }),
    );
  });

  // ── Section C: batch_edit_video atomic rollback on invalid sub-edits + export_video ──
  await section("C. batch_edit_video rejects invalid sub-edits upfront with G14 envelopes and ZERO draft mutation", async () => {
    const before = await callTool(betaToken, "get_edit_state", { jobId: heldJobId });
    const beforeSnapshot = JSON.stringify({
      draftRevision: before.draftRevision,
      captions: before.captions,
      subtitleStyle: before.subtitleStyle,
      headlineHook: before.headlineHook,
      backgroundMusic: before.backgroundMusic,
      tailHoldMs: before.tailHoldMs,
      sfxMode: before.sfxMode,
      brollTransition: before.brollTransition,
      punchZoom: before.punchZoom,
      windows: before.windows,
    });

    const invalidPayloads: Array<{ label: string; args: Json }> = [
      {
        label: "empty batch (no edit fields)",
        args: { jobId: heldJobId },
      },
      {
        label: "mismatched captionIndices / captionTexts lengths (paired with valid templateId)",
        args: {
          jobId: heldJobId,
          templateId: "news-fast",
          captionIndices: [0, 1],
          captionTexts: ["มีแค่อันเดียว"],
        },
      },
      {
        label: "duplicate captionIndices (paired with valid tailHoldMs)",
        args: {
          jobId: heldJobId,
          tailHoldMs: 500,
          captionIndices: [1, 1],
          captionTexts: ["ซ้ำหนึ่ง", "ซ้ำสอง"],
        },
      },
      {
        label: "out-of-bounds captionIndex after valid regroupCardLen",
        args: {
          jobId: heldJobId,
          regroupCardLen: "2",
          captionIndices: [0, 9],
          captionTexts: ["ไม่ควรถูกเซฟ", "เกินขอบเขต"],
        },
      },
      {
        label: "invalid hex color alongside valid caption update",
        args: {
          jobId: heldJobId,
          captionIndices: [0],
          captionTexts: ["ไม่ควรถูกเซฟ"],
          textColor: "not-a-hex",
        },
      },
      {
        label: "unknown bgmMoodOrTrack alongside valid subtitle style",
        args: {
          jobId: heldJobId,
          fontSize: 64,
          bgmMoodOrTrack: "nonexistent-mood-999",
        },
      },
      {
        label: "out-of-range tailHoldMs alongside valid headlineHookText",
        args: {
          jobId: heldJobId,
          headlineHookText: "ไม่ควรถูกเซฟ",
          tailHoldMs: 9_999,
        },
      },
      {
        label: "brollFit without brollWindowIndex alongside valid punchZoom",
        args: {
          jobId: heldJobId,
          punchZoom: true,
          brollFit: "cover",
        },
      },
    ];

    for (const item of invalidPayloads) {
      const reply = await callTool(betaToken, "batch_edit_video", item.args);
      const envelopeProblems = checkFailureEnvelope(reply);
      check(
        `invalid case [${item.label}] returns valid G14 failure envelope`,
        envelopeProblems.length === 0,
        `${JSON.stringify(reply)} (${envelopeProblems.join(", ")})`,
      );
    }

    const afterInvalid = await callTool(betaToken, "get_edit_state", { jobId: heldJobId });
    const afterSnapshot = JSON.stringify({
      draftRevision: afterInvalid.draftRevision,
      captions: afterInvalid.captions,
      subtitleStyle: afterInvalid.subtitleStyle,
      headlineHook: afterInvalid.headlineHook,
      backgroundMusic: afterInvalid.backgroundMusic,
      tailHoldMs: afterInvalid.tailHoldMs,
      sfxMode: afterInvalid.sfxMode,
      brollTransition: afterInvalid.brollTransition,
      punchZoom: afterInvalid.punchZoom,
      windows: afterInvalid.windows,
    });
    check(
      "all 8 failed batch_edit_video calls left PendingEditDraft 100% untouched (draftRevision === 1)",
      beforeSnapshot === afterSnapshot,
    );

    // Export the batch-edited held job (triggers free B-roll re-render + chained export) and verify zero extra paid provider calls
    const providerBeforeExport = providerCalls;
    const expReply = await callTool(betaToken, "export_video", { jobId: heldJobId });
    check(
      "export_video accepted batch-edited held job (status === 'rerendering' for pending B-roll style changes)",
      expReply.status === "rerendering" && typeof expReply.rerenderJobId === "string",
      JSON.stringify(expReply),
    );
    const finishedRerender = await runJob(String(expReply.rerenderJobId), "u-beta-paid");
    check("rerender child job reached status === 'done' with zero extra paid provider calls", finishedRerender.status === "done" && providerCalls === providerBeforeExport);
  });

  // ── Section D: list_brand_profiles owner isolation & visual/StylePack summary ──
  let publishedBrandId = "";
  let foreignBrandId = "";
  await section("D. list_brand_profiles returns only caller's active/published Brand Profiles with full writing + visual summary", async () => {
    const emptyList = await callTool(extPaidToken, "list_brand_profiles", {});
    check(
      "list_brand_profiles with zero profiles returns ok:true, count:0, profiles:[], and setup guidance in next",
      emptyList.ok === true && emptyList.count === 0 && Array.isArray(emptyList.profiles) && emptyList.profiles.length === 0 && String(emptyList.next ?? "").includes("studio.heroaiengine.com/brands"),
      JSON.stringify(emptyList),
    );

    const activeVisualFormatId = VISUAL_FORMATS[0]!.id;
    const basePayload = {
      schemaVersion: 1 as const,
      name: "คลินิกหมอผิวใส",
      niche: "สกินแคร์ลดสิวสำหรับผิวแพ้ง่าย",
      audience: "วัยทำงานนอนดึกที่มีปัญหาสิวซ้ำซาก",
      script: {
        styleId: null,
        tone: "เป็นกันเอง ให้ความรู้ตรงไปตรงมา",
        bannedWords: ["รับประกันรวย", "หายขาดร้อยเปอร์เซ็นต์"],
        ctaStyle: "comment-keyword",
        language: "th",
        analysisNotes: "เปิดด้วยปัญหาจริง ใช้ภาษาง่าย",
        sampleText: null,
      },
      voice: { provider: "gemini", voiceId: "Aoede" },
      subtitle: { presetId: "hormozi", config: {} },
      brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 12, opacity: 0.9 },
      visual: {
        primaryVisualFormatId: activeVisualFormatId,
        treatmentPolicy: "adaptive" as const,
        lockedTreatmentPresetId: null,
        stylePackId: "shop-review" as const,
        stylePackVersion: "v1.0.0" as const,
        languageMode: "defined" as const,
        palette: ["#FEF08A", "#111827"],
        personality: "สะอาด ทันสมัย น่าเชื่อถือ",
        peopleAndSetting: "",
        memorableCues: [],
        visualNotes: "",
        defaultTreatment: "clean clinic lighting",
      },
    };

    const createdOwned = await brandLibrary.createBrandProfileFromPayload({
      userId: "u-ext-paid",
      payload: basePayload,
    });
    publishedBrandId = createdOwned.profile.id;

    // Create excluded rows for u-ext-paid: revision-0 legacy row, frozen row, archived row
    await prisma.brandProfile.create({
      data: {
        userId: "u-ext-paid",
        name: "Unpublished Draft Brand",
        niche: "draft",
        audience: "draft",
        tone: "draft",
        bannedWords: "[]",
        activeRevisionNumber: 0,
      },
    });
    await prisma.brandProfile.create({
      data: {
        userId: "u-ext-paid",
        name: "Frozen Overflow Brand",
        niche: "frozen",
        audience: "frozen",
        tone: "frozen",
        bannedWords: "[]",
        activeRevisionNumber: 1,
        frozenAt: new Date(),
      },
    });
    await prisma.brandProfile.create({
      data: {
        userId: "u-ext-paid",
        name: "Archived Old Brand",
        niche: "archived",
        audience: "archived",
        tone: "archived",
        bannedWords: "[]",
        activeRevisionNumber: 1,
        archivedAt: new Date(),
      },
    });

    // Create a published Brand Profile owned by a DIFFERENT user (u-beta-paid)
    const createdForeign = await brandLibrary.createBrandProfileFromPayload({
      userId: "u-beta-paid",
      payload: { ...basePayload, name: "แบรนด์ของคนอื่น" },
    });
    foreignBrandId = createdForeign.profile.id;

    const listed = await callTool(extPaidToken, "list_brand_profiles", {});
    const profiles = listed.profiles as Array<Record<string, unknown>>;
    check("list_brand_profiles returns exactly the 1 active published profile of caller", listed.ok === true && listed.count === 1 && profiles.length === 1, JSON.stringify(listed));
    const p0 = profiles[0] ?? {};
    const vis = (p0.visualSummary ?? {}) as Record<string, unknown>;
    check(
      "returned profile carries id, name, niche, audience, tone, ctaStyle, language, stylePackId, and visualSummary",
      p0.id === publishedBrandId
        && p0.name === "คลินิกหมอผิวใส"
        && p0.niche === "สกินแคร์ลดสิวสำหรับผิวแพ้ง่าย"
        && p0.audience === "วัยทำงานนอนดึกที่มีปัญหาสิวซ้ำซาก"
        && p0.tone === "เป็นกันเอง ให้ความรู้ตรงไปตรงมา"
        && p0.ctaStyle === "comment-keyword"
        && p0.language === "th"
        && p0.stylePackId === "shop-review"
        && vis.visualFormatId === activeVisualFormatId
        && vis.stylePackId === "shop-review",
      JSON.stringify(p0),
    );
    check(
      "list_brand_profiles.next guides passing brandProfileId to generate_hero_script or create_video_job",
      String(listed.next ?? "").includes("generate_hero_script") && String(listed.next ?? "").includes("create_video_job"),
    );
  });

  // ── Section E: generate_hero_script entitlements, quotas, banned-word retry & provider pipeline ──
  await section("E. generate_hero_script enforces plan/payment/quota/caps & reuses Hero Script provider pipeline", async () => {
    const realFetch = globalThis.fetch;
    const llmPrompts: string[] = [];
    let simulateCreditExhausted = false;
    let proCallCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("openrouter.ai")) {
        if (simulateCreditExhausted) {
          return new Response(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content?: string }>;
        };
        const prompt = String(body.messages?.[0]?.content ?? "");
        llmPrompts.push(prompt);

        // Distinguish HOOKS prompt vs GENERATE prompt
        if (prompt.includes('"hooks"')) {
          const payload = {
            hooks: [
              { formula: "shock-number", text: "3 จุดพลาดที่ทำให้สิวขึ้นซ้ำทุกเดือนโดยไม่รู้ตัว" },
              { formula: "curiosity-gap", text: "รู้ไหมทำไมทาครีมแพงแค่ไหนสิวก็ไม่ยุบสักที" },
              { formula: "mistake-warning", text: "หยุดล้างหน้าแบบนี้ทันทีถ้าไม่อยากเกราะผิวพัง" },
              { formula: "direct-callout", text: "ใครนอนดึกแล้วสิวเห่อทุกเช้าฟังทางนี้ด่วน" },
              { formula: "contrarian", text: "ยิ่งสครับหน้าบ่อย สิวอุดตันยิ่งเห่อหนักกว่าเดิม" },
            ],
          };
          return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        proCallCount += 1;
        // On first pro call for a brand with banned word "รับประกันรวย", emit the banned word once
        // so we prove generateWithBannedWordGuard retries with buildBannedWordRetryNote!
        const injectBanned = proCallCount === 1 && prompt.includes("รับประกันรวย");
        const payload = {
          structure: "pas",
          bodyText: injectBanned
            ? "หลายคนล้างหน้าแรงเกินไปจนผิวแห้งลอก\nสูตรนี้รับประกันรวยและผิวใสในคืนเดียว\nเปลี่ยนมาใช้เจลล้างหน้าอ่อนโยนเช้าเย็นแทน"
            : "หลายคนล้างหน้าแรงเกินไปจนเกราะผิวอ่อนแอ\nพอผิวแห้งตึงต่อมไขมันยิ่งผลิตน้ำมันออกมาอุดตันหนักกว่าเดิม\nเปลี่ยนมาใช้เจลล้างหน้าค่า pH สมดุลและซับหน้าเบาๆ แทน",
          ctaText: "พิมพ์คำว่า ผิวใส ในคอมเมนต์เพื่อรับเช็กลิสต์ดูแลผิวได้เลย",
        };
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      // 1) FREE plan user blocked by MCP runTool guard
      const freeReply = await callTool(freeToken, "generate_hero_script", {
        topic: "วิธีลดสิวสำหรับคนนอนดึก",
      });
      check(
        "FREE plan user blocked at MCP guard with G14 plan_required envelope",
        freeReply.error === "plan_required" && checkFailureEnvelope(freeReply).length === 0,
        JSON.stringify(freeReply),
      );

      // 2) Conversion Trial PRO user blocked by resolveHeroScriptAccess (payment_required)
      const trialReply = await callTool(trialToken, "generate_hero_script", {
        topic: "วิธีลดสิวสำหรับคนนอนดึก",
      });
      check(
        "Conversion Trial PRO user blocked with G14 payment_required envelope and zero LLM calls",
        trialReply.error === "payment_required" && checkFailureEnvelope(trialReply).length === 0 && llmPrompts.length === 0,
        JSON.stringify(trialReply),
      );

      // 3) HERO_SCRIPT_PAID_ENABLED=0 blocks non-internal paid user with feature_not_enabled (audited as denied)
      process.env.HERO_SCRIPT_PAID_ENABLED = "0";
      const offReply = await callTool(extPaidToken, "generate_hero_script", {
        topic: "วิธีลดสิวสำหรับคนนอนดึก",
      });
      process.env.HERO_SCRIPT_PAID_ENABLED = "1";
      check(
        "HERO_SCRIPT_PAID_ENABLED=0 blocks external paid user with G14 feature_not_enabled",
        offReply.error === "feature_not_enabled" && checkFailureEnvelope(offReply).length === 0,
        JSON.stringify(offReply),
      );
      const deniedAudit = await prisma.toolCallAudit.findFirst({
        where: { userId: "u-ext-paid", toolName: "generate_hero_script" },
        orderBy: { createdAt: "desc" },
      });
      check("feature_not_enabled refusal audited as status === 'denied'", deniedAudit?.status === "denied");

      // 4) Foreign brandProfileId rejected (IDOR guard) + overlong topic rejected
      const foreignBrandReply = await callTool(extPaidToken, "generate_hero_script", {
        topic: "วิธีลดสิวสำหรับคนนอนดึก",
        brandProfileId: foreignBrandId,
      });
      check(
        "foreign brandProfileId rejected with G14 invalid_input and zero LLM calls",
        foreignBrandReply.error === "invalid_input" && checkFailureEnvelope(foreignBrandReply).length === 0 && llmPrompts.length === 0,
        JSON.stringify(foreignBrandReply),
      );

      const longTopicReply = await callTool(extPaidToken, "generate_hero_script", {
        topic: "ก".repeat(305),
      });
      check(
        "topic > 300 chars rejected upfront with G14 invalid_input",
        longTopicReply.error === "invalid_input" && checkFailureEnvelope(longTopicReply).length === 0 && llmPrompts.length === 0,
        JSON.stringify(longTopicReply),
      );

      // 5) Happy-path paid user generation with brandProfileId + hookFormula + structure + banned-word retry + saveToLibrary=true
      const secretTopic = "3 วิธีดูแลผิวแพ้ง่ายตอนนอนดึก SECRET_TOPIC_MARKER";
      const genReply = await callTool(extPaidToken, "generate_hero_script", {
        topic: secretTopic,
        durationSec: "30",
        brandProfileId: publishedBrandId,
        hookFormula: "shock-number",
        structure: "pas",
      });

      check("generate_hero_script succeeded for cash-paid PRO user", genReply.ok === true, JSON.stringify(genReply));
      check(
        "generate_hero_script returned scriptId, savedToLibrary:true, requested durationSec/hookFormula/structure, and brandProfileId",
        typeof genReply.scriptId === "string"
          && genReply.savedToLibrary === true
          && genReply.durationSec === 30
          && genReply.hookFormula === "shock-number"
          && genReply.structure === "pas"
          && genReply.brandProfileId === publishedBrandId,
        JSON.stringify(genReply),
      );
      check(
        "generateWithBannedWordGuard retried once after banned word hit and produced clean fullScript without warning",
        proCallCount === 2
          && !String(genReply.fullScript ?? "").includes("รับประกันรวย")
          && genReply.warning === undefined,
        JSON.stringify({ proCallCount, fullScript: genReply.fullScript, warning: genReply.warning }),
      );
      check(
        "fullScript concatenates hookText + bodyText + ctaText with no blank lines",
        typeof genReply.fullScript === "string"
          && String(genReply.fullScript).includes(String(genReply.hookText))
          && String(genReply.fullScript).includes(String(genReply.ctaText))
          && !String(genReply.fullScript).includes("\n\n"),
      );
      check(
        "generate_hero_script.next instructs confirming fullScript and passing brandProfileId to create_video_job",
        String(genReply.next ?? "").includes("create_video_job") && String(genReply.next ?? "").includes(publishedBrandId),
      );

      const savedRow = await prisma.script.findUnique({ where: { id: String(genReply.scriptId) } });
      check(
        "Script row persisted in SQLite under owning userId + brandProfileId",
        savedRow?.userId === "u-ext-paid" && savedRow?.brandProfileId === publishedBrandId && savedRow?.durationSec === 30,
      );

      const okAudit = await prisma.toolCallAudit.findFirst({
        where: { userId: "u-ext-paid", toolName: "generate_hero_script", status: "ok" },
        orderBy: { createdAt: "desc" },
      });
      check(
        "audit log records topicChars metadata without leaking raw user topic prose",
        okAudit != null && !String(okAudit.requestJson ?? "").includes("SECRET_TOPIC_MARKER") && String(okAudit.requestJson ?? "").includes("topicChars"),
        String(okAudit?.requestJson),
      );

      // 6) saveToLibrary: false skips Script row creation
      const countBeforeNoSave = await prisma.script.count({ where: { userId: "u-ext-paid" } });
      const noSaveReply = await callTool(extPaidToken, "generate_hero_script", {
        topic: "วิธีเลือกครีมกันแดดไม่อุดตัน",
        durationSec: "60",
        saveToLibrary: false,
      });
      const countAfterNoSave = await prisma.script.count({ where: { userId: "u-ext-paid" } });
      check(
        "saveToLibrary: false returns scriptId === null and writes zero new Script rows",
        noSaveReply.ok === true && noSaveReply.scriptId === null && noSaveReply.savedToLibrary === false && countAfterNoSave === countBeforeNoSave,
        JSON.stringify(noSaveReply),
      );

      // 7) Provider 402 credit failure returns G14 provider_credit and releases finite ScriptGenerationUsage reservation
      simulateCreditExhausted = true;
      const creditFailReply = await callTool(extPaidToken, "generate_hero_script", {
        topic: "หัวข้อทดสอบเครดิตผู้ให้บริการหมด",
      });
      simulateCreditExhausted = false;
      check(
        "OpenRouter 402 surfaces G14 provider_credit envelope",
        creditFailReply.error === "provider_credit" && checkFailureEnvelope(creditFailReply).length === 0,
        JSON.stringify(creditFailReply),
      );

      // Direct service-level check on finite cohort ScriptGenerationUsage cap enforcement
      for (let slot = 1; slot <= heroScriptServer.HERO_SCRIPT_FREE_GENERATIONS; slot++) {
        const res = await heroScriptServer.reserveScriptGeneration(freeUser.id, "free");
        check(`finite free cohort slot ${slot} reserved`, res.allowed === true);
        if (res.allowed) {
          await heroScriptServer.settleScriptGeneration(freeUser.id, res.reservationId, true);
        }
      }
      const exhausted = await heroScriptServer.reserveScriptGeneration(freeUser.id, "free");
      check(
        "4th finite-cohort reservation rejected once all 3 slots succeeded in rolling window",
        exhausted.allowed === false && /[ก-๙]/.test(exhausted.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} check(s) failed (${passed} passed)`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`\nALL PASSED (${passed} checks)`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
