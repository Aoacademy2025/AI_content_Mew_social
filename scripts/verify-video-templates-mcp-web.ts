// verify-video-templates-mcp-web.ts — HERO-94 end-to-end verification:
// (a) MANAGED_STOCK dynamic needsStockKey & HERO-85 auto-start discovery in get_video_options
// (b) templates catalog & templateId resolution + explicit-arg override precedence in prepare_video_job / create_video_job
// (c) apply_video_template on PendingEditDraft in edit-tools.ts (+ export_video carry-through)
// (d) agent-neutral schema compliance across create_video_job, prepare_video_job, apply_video_template, and edit tools
// (e) Web Editor v2 template helpers (resolveStep1TemplateDefaults / resolveTemplatePostEdit) + UI wiring
//
// Self-contained: builds its own throwaway SQLite DB.
// Run: node --conditions=react-server --import tsx scripts/verify-video-templates-mcp-web.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "hero94-templates-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
process.env.BRAND_ASSET_ROOT = mkdtempSync(join(tmpdir(), "hero94-templates-brand-"));
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
  "MANAGED_STOCK",
  "MANAGED_PEXELS_API_KEY",
  "MANAGED_PIXABAY_API_KEY",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
]) delete process.env[key];
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
const { words: WORDS, fullText: FULL_TEXT } = buildWordsFixture(WORD_TEXTS, 1000);
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
const VOICE_FILE = "/api/renders/hero94-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/hero94-a.mp4", start: 0, end: 2, sourceIndex: 0, clipDuration: 4 },
    { src: "/api/stocks/hero94-b.mp4", start: 2, end: 4, sourceIndex: 1, clipDuration: 4 },
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
  const realRequire = createRequire(join(ROOT, "scripts/verify-video-templates-mcp-web.ts"));
  const fromSrc = (path: string) => realRequire(join(ROOT, "src", path));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const editTools = fromSrc("lib/mcp/edit-tools") as typeof import("../src/lib/mcp/edit-tools");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");
  const styleCatalog = fromSrc("lib/style-pack-catalog") as typeof import("../src/lib/style-pack-catalog");
  const webTemplateApply = fromSrc("lib/video-template-apply") as typeof import("../src/lib/video-template-apply");

  // ── Compile REAL MCP route with only Clerk + key-preflight network stubbed ──
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
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "verify-video-templates-mcp-web/1.0",
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

  const failures: Array<{ tool: string; reply: Json }> = [];
  async function rawCallTool(token: string, name: string, args: Json): Promise<Json> {
    const message = await rpc(token, "tools/call", { name, arguments: args });
    const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    const reply = JSON.parse(text) as Json;
    if (reply.error != null && name === "apply_video_template") failures.push({ tool: name, reply });
    return reply;
  }

  // ── Seed system music tracks & PRO internal-tester user ──
  await prisma.music.createMany({
    data: [
      { id: "m-upbeat", title: "Fresh Pop Cart", filename: "fresh-pop-cart.mp3", mood: "upbeat" },
      { id: "m-chill", title: "Lofi Peaceful Breeze", filename: "lofi-peaceful-breeze.mp3", mood: "chill" },
      { id: "m-corp", title: "Corporate Smart Brief", filename: "corporate-smart-brief.mp3", mood: "corporate" },
      { id: "m-drama", title: "Cinematic Midnight Tension", filename: "cinematic-midnight-tension.mp3", mood: "dramatic" },
    ],
  });

  const now = new Date();
  await prisma.user.create({
    data: {
      id: "u-hero94",
      name: "HERO-94 Tester",
      email: "qa-hero94@aoacademy.co",
      plan: "PRO",
      minutesLimit: 80,
      minutesUsed: 0,
      usagePeriodStartedAt: now,
      trialEndsAt: null,
      usageLimit: 100,
      usageCount: 0,
      geminiVoiceName: "Aoede",
      geminiKey: "g",
      pexelsKey: null,
      pixabayKey: null,
      subStatus: "active",
      stripeSubscriptionId: "sub_hero94",
      planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    },
  });
  await prisma.payment.create({
    data: {
      userId: "u-hero94",
      stripeSessionId: "cs_hero94",
      plan: "PRO",
      amount: 59_900,
      status: "PAID",
      periodDays: 30,
      paidAt: now,
    },
  });
  const { token } = await createMcpToken("u-hero94", "verify-hero94");

  let renderSeq = 0;
  let gallerySeq = 0;
  const extractBodies: Json[] = [];
  const fetchStockBodies: Json[] = [];
  function makeCaller(userId: string) {
    return {
      async post<T>(path: string, body?: unknown): Promise<T> {
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
          extractBodies.push((body ?? {}) as Json);
          return { keywords: ["shopping"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") {
          fetchStockBodies.push((body ?? {}) as Json);
          return { results: [{ videoUrl: "stock1.mp4", keyword: "shopping" }] } as T;
        }
        if (path === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string; rerenderOf?: { sourceJobId?: string } };
          const isBurn = !!request.subtitleOverlayConfig;
          const isRerender = !!request.rerenderOf?.sourceJobId;
          const id = `rj-hero94-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          const free = isRerender || isBurn;
          await prisma.renderJob.create({
            data: {
              id,
              userId,
              parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER",
              status: "DONE",
              payload: "{}",
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
          return { id: `gallery-hero94-${gallerySeq}` } as T;
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

  // ── Section A: MANAGED_STOCK dynamic needsStockKey & HERO-85 auto-start discovery ──
  await section("A. MANAGED_STOCK dynamic needsStockKey & HERO-85 auto-start in get_video_options", async () => {
    delete process.env.MANAGED_STOCK;
    delete process.env.MANAGED_PEXELS_API_KEY;
    const offOpts = await rawCallTool(token, "get_video_options", {});
    const offBroll = offOpts.broll as { next: string; options: Array<{ value: string; needsStockKey?: boolean; detail: string }> };
    const offStock = offBroll.options.find((o) => o.value === "stock");
    const offAutomix = offBroll.options.find((o) => o.value === "automix");
    check("flag off: stock needsStockKey === true", offStock?.needsStockKey === true);
    check("flag off: automix needsStockKey === true", offAutomix?.needsStockKey === true);
    check("broll.next reflects HERO-85 direct create_video_job auto-start", offBroll.next.includes("create_video_job") && offBroll.next.includes("ไม่ต้องเปิด confirmationUrl"));

    process.env.MANAGED_STOCK = "1";
    process.env.MANAGED_PEXELS_API_KEY = "team_pexels_server_key";
    const onOpts = await rawCallTool(token, "get_video_options", {});
    const onBroll = onOpts.broll as { next: string; options: Array<{ value: string; needsStockKey?: boolean; detail: string }> };
    const onStock = onBroll.options.find((o) => o.value === "stock");
    const onAutomix = onBroll.options.find((o) => o.value === "automix");
    check("MANAGED_STOCK=1: stock needsStockKey === false", onStock?.needsStockKey === false);
    check("MANAGED_STOCK=1: automix needsStockKey === false", onAutomix?.needsStockKey === false);
    check("MANAGED_STOCK=1: stock detail explains no BYOK stock key needed", Boolean(onStock?.detail.includes("ไม่ต้องมีคีย์สต็อก")));
    check("MANAGED_STOCK=1: automix detail explains no BYOK stock key needed", Boolean(onAutomix?.detail.includes("ไม่ต้องมีคีย์สต็อก")));

    const templates = onOpts.templates as Array<Record<string, unknown>>;
    const templatesHowToChoose = String(onOpts.templatesHowToChoose ?? "");
    check("templatesHowToChoose is non-empty Thai guidance", /[ก-๙]/.test(templatesHowToChoose) && templatesHowToChoose.includes("templateId"));
    check("templates array exposes all 13 active StylePacks", Array.isArray(templates) && templates.length === 13);
    const ids = new Set(templates.map((t) => t.id));
    check("templates includes trending packs (shop-review, listicle-fast, ai-tech-doc, true-crime, self-growth) and excludes pending dharma", ids.has("shop-review") && ids.has("listicle-fast") && ids.has("ai-tech-doc") && ids.has("true-crime") && ids.has("self-growth") && !ids.has("dharma"));
    check(
      "every template option exposes full V2 recipe fields",
      templates.every((t) =>
        typeof t.id === "string"
        && typeof t.thaiLabel === "string"
        && typeof t.tagline === "string"
        && typeof t.pacing === "string"
        && typeof t.musicMood === "string"
        && typeof t.subtitlePreset === "string"
        && typeof t.headlineHookStyle === "string"
        && typeof t.highlightKeywords === "boolean"
        && typeof t.statCards === "boolean"
        && (t.sfxMode === "none" || t.sfxMode === "subtle")
        && typeof t.punchZoom === "boolean"
        && typeof t.brollTransition === "string"
      ),
    );
  });

  // ── Section B: templateId resolution + explicit caller override precedence in prepare_video_job & create_video_job ──
  let heldJobId = "";
  let heldProjectId = "";
  await section("B. templateId resolution & explicit caller override precedence (prepare_video_job + direct create_video_job)", async () => {
    process.env.MANAGED_STOCK = "1";
    process.env.MANAGED_PEXELS_API_KEY = "team_pexels_server_key";

    const quoteReply = await rawCallTool(token, "prepare_video_job", {
      script: SCRIPT,
      title: "รีวิวกระเป๋าขายดี",
      templateId: "shop-review",
    });
    check("prepare_video_job with templateId succeeds on keyless user under MANAGED_STOCK=1", typeof quoteReply.quoteId === "string");
    const quoteRow = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: String(quoteReply.quoteId) } });
    const exec1 = JSON.parse(quoteRow.executionJson) as { jobInput: Record<string, unknown>; musicTitle: string | null };
    const sub1 = exec1.jobInput.subtitleDesign as Record<string, unknown>;
    const hook1 = exec1.jobInput.headlineHook as Record<string, unknown> | undefined;
    check("template defaults: templateId & templateSnapshot persisted", exec1.jobInput.templateId === "shop-review" && (exec1.jobInput.templateSnapshot as { id?: string })?.id === "shop-review");
    check("template defaults: subtitle preset/fontSize/accentColor from shop-review", sub1.preset === "hormozi" && sub1.fontSize === 66 && sub1.accentColor === "#FEF08A");
    check("template defaults: highlightKeywords & statCards inherited from shop-review", sub1.highlightKeywords === true && sub1.statCards === true);
    check("template defaults: subtitleCardLen === '2'", exec1.jobInput.subtitleCardLen === "2");
    check("template defaults: headlineHookStyle & seeded headlineHook preset === 'banner'", exec1.jobInput.headlineHookStyle === "banner" && hook1?.preset === "banner" && typeof hook1?.headline === "string" && hook1.headline.length > 0);
    check("template defaults: sfxMode === 'subtle', punchZoom === true, brollTransition === 'cut'", exec1.jobInput.sfxMode === "subtle" && exec1.jobInput.punchZoom === true && exec1.jobInput.brollTransition === "cut");
    check("template defaults: bgmFile auto-resolved from upbeat musicMood", exec1.jobInput.bgmFile === "/music/fresh-pop-cart.mp3" && exec1.musicTitle === "Fresh Pop Cart");

    // Explicit caller overrides must beat every template default!
    const overrideReply = await rawCallTool(token, "prepare_video_job", {
      script: SCRIPT,
      title: "Shop Review Overridden",
      templateId: "shop-review",
      subtitleStyle: "outline",
      subtitleSize: 78,
      subtitleColor: "#FAFAFA",
      subtitleAccentColor: "#00E5FF",
      subtitleMode: "sentence",
      highlightKeywords: false,
      statCards: false,
      headlineHook: "ลดแรงวันนี้เท่านั้น",
      headlineHookStyle: "news",
      sfxMode: "none",
      punchZoom: false,
      bgmFile: "none",
    });
    check("prepare_video_job with explicit overrides succeeds", typeof overrideReply.quoteId === "string" && overrideReply.quoteId !== quoteReply.quoteId);
    const overrideRow = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: String(overrideReply.quoteId) } });
    const exec2 = JSON.parse(overrideRow.executionJson) as { jobInput: Record<string, unknown>; musicTitle: string | null };
    const sub2 = exec2.jobInput.subtitleDesign as Record<string, unknown>;
    const hook2 = exec2.jobInput.headlineHook as Record<string, unknown> | undefined;
    check("override wins: subtitle preset/fontSize/colors", sub2.preset === "sharp-outline" && sub2.fontSize === 78 && sub2.textColor === "#FAFAFA" && sub2.accentColor === "#00E5FF");
    check("override wins: highlightKeywords === false & statCards === false", sub2.highlightKeywords === false && sub2.statCards === false);
    check("override wins: subtitleCardLen === 'sentence'", exec2.jobInput.subtitleCardLen === "sentence");
    check("override wins: headlineHook text & headlineHookStyle === 'news'", exec2.jobInput.headlineHookStyle === "news" && hook2?.preset === "news" && hook2?.headline === "ลดแรงวันนี้เท่านั้น");
    check("override wins: sfxMode === 'none' & punchZoom === false", exec2.jobInput.sfxMode === "none" && exec2.jobInput.punchZoom === false);
    check("override wins: bgmFile: 'none' disables template music", exec2.jobInput.bgmFile === undefined && exec2.musicTitle === null);

    // Direct create_video_job (HERO-85 auto-start — no browser confirmationUrl approval needed!)
    const created = await rawCallTool(token, "create_video_job", {
      script: SCRIPT,
      title: "Direct Auto-Start Template Clip",
      templateId: "shop-review",
      exportMode: "hold",
    });
    check("direct create_video_job auto-starts immediately without confirmation_required", typeof created.jobId === "string" && created.status === "queued");
    heldJobId = String(created.jobId);
    heldProjectId = String(created.projectId);

    const projectRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: heldProjectId } });
    const projectDraft = JSON.parse(projectRow.draftJson ?? "{}") as Record<string, unknown>;
    check("EditorProject.draftJson persists templateId, sfxMode, brollTransition", projectDraft.templateId === "shop-review" && projectDraft.sfxMode === "subtle" && projectDraft.brollTransition === "cut");

    const finishedPreview = await runJob(heldJobId, "u-hero94");
    check("held preview finishes in done status", finishedPreview.status === "done");
    check(
      "orchestrator forwarded template stockMood ('unboxing') to extract-keywords & fetch-stock",
      (extractBodies[0]?.stockMood as { queryToken?: string } | undefined)?.queryToken === "unboxing"
      && (fetchStockBodies[0]?.stockMood as { queryToken?: string } | undefined)?.queryToken === "unboxing",
    );
  });

  // ── Section C: apply_video_template on PendingEditDraft + export_video carry-through ──
  await section("C. apply_video_template on PendingEditDraft & export_video carry-through", async () => {
    // 1. Apply news-fast (cardLen '2', preset 'news', headlineHookPreset 'news', sfxMode 'subtle', brollTransition 'cut', punchZoom true)
    const appliedNews = await rawCallTool(token, "apply_video_template", {
      jobId: heldJobId,
      templateId: "news-fast",
    });
    check("apply_video_template(news-fast) returns ok: true", appliedNews.ok === true && appliedNews.templateId === "news-fast");
    check("apply_video_template(news-fast) regroups 8 Thai words into 4 two-word cards (cardLen '2')", appliedNews.cardLen === "2" && appliedNews.cardCount === 4);
    check(
      "apply_video_template(news-fast) preserves hook text while switching preset to 'news'",
      (appliedNews.headlineHook as { preset?: string; headline?: string })?.preset === "news"
      && Boolean((appliedNews.headlineHook as { headline?: string })?.headline),
    );
    check(
      "apply_video_template(news-fast) sets sfxMode=subtle, brollTransition=cut, punchZoom=true, musicApplied=false",
      appliedNews.sfxMode === "subtle"
      && appliedNews.brollTransition === "cut"
      && appliedNews.punchZoom === true
      && appliedNews.musicApplied === false,
    );

    const rowAfterNews = await prisma.editorProject.findUniqueOrThrow({ where: { id: heldProjectId } });
    const draftAfterNews = JSON.parse(rowAfterNews.pendingEditJson ?? "{}") as import("../src/lib/mcp/pending-edit-draft").PendingEditDraft;
    check(
      "PendingEditDraft persisted news-fast subtitleConfig (news + highlightKeywords + statCards)",
      draftAfterNews.subtitleConfig?.preset === "news"
      && draftAfterNews.subtitleConfig?.highlightKeywords === true
      && draftAfterNews.subtitleConfig?.statCards === true
      && draftAfterNews.backgroundMusic === undefined,
    );

    // 2. Apply health-simple with includeMusic: true (cardLen='3', preset='box-rounded', highlightKeywords=true, statCards=true,
    //    hook='question-pill', sfxMode='none', brollTransition='dissolve', punchZoom=false, calm->chill BGM)
    const appliedHealth = await rawCallTool(token, "apply_video_template", {
      jobId: heldJobId,
      templateId: "health-simple",
      includeMusic: true,
    });
    check("apply_video_template(health-simple, includeMusic: true) returns ok: true & musicApplied: true", appliedHealth.ok === true && appliedHealth.musicApplied === true);
    check(
      "apply_video_template(health-simple) switches cardLen='3' (3 cards), sfxMode='none', brollTransition='dissolve', punchZoom=false",
      appliedHealth.cardLen === "3"
      && appliedHealth.cardCount === 3
      && appliedHealth.sfxMode === "none"
      && appliedHealth.brollTransition === "dissolve"
      && appliedHealth.punchZoom === false,
    );

    const rowAfterHealth = await prisma.editorProject.findUniqueOrThrow({ where: { id: heldProjectId } });
    const draftAfterHealth = JSON.parse(rowAfterHealth.pendingEditJson ?? "{}") as import("../src/lib/mcp/pending-edit-draft").PendingEditDraft;
    check(
      "PendingEditDraft persisted health-simple config + calm/chill BGM track",
      draftAfterHealth.subtitleConfig?.preset === "box-rounded"
      && draftAfterHealth.subtitleConfig?.highlightKeywords === true
      && draftAfterHealth.subtitleConfig?.statCards === true
      && draftAfterHealth.headlineHook?.preset === "question-pill"
      && draftAfterHealth.sfxMode === "none"
      && draftAfterHealth.backgroundMusic?.track === "/music/lofi-peaceful-breeze.mp3"
      && draftAfterHealth.backgroundMusic?.ducking === true,
    );

    // 3. Error envelope check on missing job
    const missingReply = await rawCallTool(token, "apply_video_template", {
      jobId: "job-does-not-exist",
      templateId: "shop-review",
    });
    check("apply_video_template on missing job returns invalid_input failure envelope", missingReply.error === "invalid_input");

    // 4. Export held preview: because apply_video_template updated brollTransition/punchZoom,
    //    export_video enqueues the free B-roll rerender first, which auto-chains into the final export burn!
    const exported = await rawCallTool(token, "export_video", { jobId: heldJobId });
    check(
      "export_video enqueues free B-roll rerender hop after apply_video_template",
      exported.status === "rerendering" && typeof exported.rerenderJobId === "string",
    );
    const rerenderRow = await runJob(String(exported.rerenderJobId), "u-hero94");
    check("B-roll rerender job finishes cleanly", rerenderRow.status === "done");
    const chainedExport = await prisma.videoJob.findFirstOrThrow({
      where: { projectId: heldProjectId, type: "export" },
      orderBy: { createdAt: "desc" },
    });
    const exportRow = await runJob(chainedExport.id, "u-hero94");
    check("auto-chained export job finishes cleanly", exportRow.status === "done");
    const exportInput = JSON.parse(exportRow.inputJson) as Record<string, unknown>;
    const overlay = exportInput.subtitleOverlayConfig as Record<string, unknown>;
    check(
      "exported burn config carries health-simple headlineHook preset ('question-pill') and box-rounded stylePreset",
      (overlay?.headlineHook as { preset?: string } | undefined)?.preset === "question-pill"
      && overlay?.subtitleStylePreset === "box-rounded"
      && overlay?.subtitleHighlightKeywords === true
      && overlay?.subtitleStatCards === true,
    );
  });

  // ── Section D: Agent-neutral schema compliance & failure envelope check ──
  await section("D. Agent-neutral schema compliance (create_video_job, prepare_video_job, apply_video_template, edit tools)", async () => {
    const listed = await listTools(token);
    const targetToolNames = [
      "create_video_job",
      "prepare_video_job",
      ...editTools.MCP_EDIT_TOOL_NAMES,
    ];
    check("apply_video_template is included in MCP_EDIT_TOOL_NAMES & tools/list", (editTools.MCP_EDIT_TOOL_NAMES as readonly string[]).includes("apply_video_template") && listed.some((t) => t.name === "apply_video_template"));

    const violations = verifyAgentNeutralSchemas(listed, targetToolNames);
    check(
      `verifyAgentNeutralSchemas passes with 0 violations (${targetToolNames.length} tools checked)`,
      violations.length === 0,
      violations.join("\n"),
    );

    for (const toolName of ["create_video_job", "prepare_video_job", "apply_video_template"] as const) {
      const schema = listed.find((t) => t.name === toolName)?.inputSchema as { properties?: Record<string, { type?: string; enum?: string[] }> } | undefined;
      const tplProp = schema?.properties?.templateId;
      check(
        `${toolName}.inputSchema.properties.templateId is a flat string enum matching ACTIVE_STYLE_PACK_IDS`,
        tplProp?.type === "string"
        && Array.isArray(tplProp.enum)
        && JSON.stringify(tplProp.enum) === JSON.stringify(styleCatalog.ACTIVE_STYLE_PACK_IDS),
      );
    }

    check("recorded failure envelopes satisfy checkFailureEnvelope", failures.length >= 1);
    for (const { tool, reply } of failures) {
      const issues = checkFailureEnvelope(reply);
      check(`${tool} failure envelope valid (${String(reply.code)})`, issues.length === 0, issues.join("; "));
    }
  });

  // ── Section E: Web Editor v2 template helpers & component wiring ──
  await section("E. Web Editor v2 template helpers & Step 1 / Post-Render wiring", async () => {
    const step1Fast = webTemplateApply.resolveStep1TemplateDefaults("listicle-fast", {
      scriptText: SCRIPT,
      estimatedDurationMs: 15_000,
    });
    check(
      "resolveStep1TemplateDefaults(listicle-fast) resolves cardLen='2', stat-burst hook, subtle SFX, cut transition, punchZoom, fast pacing, and upbeat musicMood",
      step1Fast.templateId === "listicle-fast"
      && step1Fast.subtitleDefault.cardLen === "2"
      && step1Fast.headlineHookPreset === "stat-burst"
      && step1Fast.headlineHook?.preset === "stat-burst"
      && step1Fast.sfxMode === "subtle"
      && step1Fast.brollTransition === "cut"
      && step1Fast.punchZoom === true
      && step1Fast.pacing === "fast"
      && step1Fast.musicMood === "upbeat",
    );

    const postEdit = webTemplateApply.resolveTemplatePostEdit({
      templateId: "shop-review",
      currentHeadlineHook: null,
      headlineSourceText: CARD0_TEXT,
      totalDurationMs: 4_000,
    });
    check(
      "resolveTemplatePostEdit(shop-review) transforms subtitleConfig, sets cardLen='2', synthesizes banner headlineHook, and exposes upbeat musicMood",
      postEdit.cardLen === "2"
      && postEdit.subtitleConfig.preset === "hormozi"
      && postEdit.subtitleConfig.highlightKeywords === true
      && postEdit.subtitleConfig.statCards === true
      && postEdit.headlineHook?.preset === "banner"
      && Boolean(postEdit.headlineHook?.headline.length)
      && postEdit.sfxMode === "subtle"
      && postEdit.brollTransition === "cut"
      && postEdit.punchZoom === true
      && postEdit.musicMood === "upbeat",
    );

    const step1Src = readFileSync(join(ROOT, "src/app/(dashboard)/video-editor/_v2/Step1Script.tsx"), "utf8");
    const step2Src = readFileSync(join(ROOT, "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx"), "utf8");
    const postDesktopSrc = readFileSync(join(ROOT, "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx"), "utf8");
    const postMobileSrc = readFileSync(join(ROOT, "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx"), "utf8");
    check(
      "Step1Script.tsx renders เลือกสไตล์เทมเพลตวิดีโอ (Video Template) strip",
      step1Src.includes("เลือกสไตล์เทมเพลตวิดีโอ (Video Template)") && step1Src.includes("data-template-id={pack.id}"),
    );
    const step2TemplateStripIdx = step2Src.indexOf("เลือกสไตล์ภาพ & เทมเพลตคลิป (1 คลิก)");
    const step2SourceHeadingIdx = step2Src.indexOf("เลือกแหล่งภาพ B-roll (ทำงานตามสไตล์ที่เลือกด้านบน)");
    const step2SourceButtonsIdx = step2Src.indexOf("CustomerBrollSourceButtons");
    check(
      "Step2Elements.tsx renders 1-click B-roll style template strip ABOVE B-roll source selection",
      step2TemplateStripIdx > 0
      && step2SourceHeadingIdx > step2TemplateStripIdx
      && step2SourceButtonsIdx > step2SourceHeadingIdx
      && step2Src.includes("data-broll-template-id={pack.id}")
      && step2Src.includes("ล้างสไตล์ (ให้อัตโนมัติตามเนื้อหา)"),
    );
    check(
      "PostPhase.tsx & PostPhaseMobile.tsx render post-render template switcher wired to applyVideoTemplate",
      postDesktopSrc.includes("data-post-template-id={pack.id}")
      && postDesktopSrc.includes("ed.applyVideoTemplate(pack.id)")
      && postMobileSrc.includes("data-post-template-id={pack.id}")
      && postMobileSrc.includes("ed.applyVideoTemplate(pack.id)"),
    );
  });

  // ── Section F: HERO-100 Unified B-roll Style -> ProjectLook / ProjectVisualContext (Web + MCP + External) ──
  await section("F. HERO-100 Unified B-roll Style -> ProjectLook / ProjectVisualContext & MCP brollSource", async () => {
    const projectLookMod = fromSrc("lib/project-look.server") as typeof import("../src/lib/project-look.server");
    const projectVisualContextMod = fromSrc("lib/project-visual-context") as typeof import("../src/lib/project-visual-context");

    for (const packId of styleCatalog.ACTIVE_STYLE_PACK_IDS) {
      const pack = styleCatalog.stylePack(packId);
      const snapshot = projectLookMod.buildStylePackProjectLookSnapshot(packId);
      const pin = projectLookMod.buildStylePackProjectVisualPin(packId);
      const parsedCtx = projectVisualContextMod.projectVisualContextSchema.safeParse(JSON.parse(pin.projectVisualContextJson));
      check(
        `buildStylePackProjectLookSnapshot(${packId}) matches pack visualFormat/treatment/palette/stockMood and validates projectVisualContextSchema`,
        snapshot.schemaVersion === 2
        && snapshot.visualFormatId === pack.visualFormatId
        && snapshot.treatmentPin?.presetId === pack.treatmentPresetId
        && JSON.stringify(snapshot.brandVisualLanguage?.palette) === JSON.stringify(pack.palette)
        && snapshot.brandVisualLanguage?.personality === pack.personality
        && snapshot.stylePack?.id === packId
        && snapshot.stylePack?.stockMood.queryToken === pack.stockMood.queryToken
        && snapshot.stylePack?.pacing === pack.pacing
        && snapshot.stylePack?.musicMood === pack.musicMood
        && parsedCtx.success
        && parsedCtx.data.source === "project-look",
      );
    }

    // Enable Brand Visual System master switch (matches live Studio rollout) and test MCP direct create_video_job -> ProjectLook + VideoJob visual pin
    process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
    const directLookCreated = await rawCallTool(token, "create_video_job", {
      script: SCRIPT,
      title: "HERO-100 Direct Template Look Clip",
      templateId: "shop-review",
      exportMode: "hold",
    });
    const directProj = await prisma.editorProject.findUniqueOrThrow({ where: { id: String(directLookCreated.projectId) } });
    const directJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(directLookCreated.jobId) } });
    const directLook = projectVisualContextMod.parseProjectLook(directProj.projectLookJson);
    const directJobCtx = directJob.projectVisualContextJson
      ? projectVisualContextMod.projectVisualContextSchema.safeParse(JSON.parse(directJob.projectVisualContextJson))
      : null;
    check(
      "MCP direct create_video_job(templateId: shop-review) persists ProjectLook & VideoJob projectVisualContextJson",
      directLook?.stylePack?.id === "shop-review"
      && directProj.treatmentPresetId === styleCatalog.stylePack("shop-review").treatmentPresetId
      && Boolean(directJobCtx?.success && directJobCtx.data.source === "project-look" && directJobCtx.data.stylePack?.id === "shop-review"),
    );

    // syncTemplateStylePackLookForRender: empty sync, idempotent no-op, pack swap, and safety guards
    const syncProj = await prisma.editorProject.create({
      data: { userId: "u-hero94", title: "Sync Guard Project" },
    });
    const admission = { cohort: "treatment-100" as const, at: new Date() };
    const syncedFirst = await projectLookMod.syncTemplateStylePackLookForRender({
      userId: "u-hero94",
      projectId: syncProj.id,
      templateId: "thai-ghost",
      admission,
    });
    const afterFirst = await prisma.editorProject.findUniqueOrThrow({ where: { id: syncProj.id } });
    check(
      "syncTemplateStylePackLookForRender syncs empty project to thai-ghost and stamps admission",
      syncedFirst === true
      && projectVisualContextMod.parseProjectLook(afterFirst.projectLookJson)?.stylePack?.id === "thai-ghost"
      && afterFirst.brandVisualPinAdmittedCohort === "treatment-100"
      && afterFirst.brandVisualPinAdmittedAt !== null,
    );

    const syncedSame = await projectLookMod.syncTemplateStylePackLookForRender({
      userId: "u-hero94",
      projectId: syncProj.id,
      templateId: "thai-ghost",
      admission: null,
    });
    const afterSame = await prisma.editorProject.findUniqueOrThrow({ where: { id: syncProj.id } });
    check(
      "syncTemplateStylePackLookForRender is a no-op on identical templateId and preserves admitted stamp",
      syncedSame === false && afterSame.brandVisualPinAdmittedCohort === "treatment-100",
    );

    const syncedSwap = await projectLookMod.syncTemplateStylePackLookForRender({
      userId: "u-hero94",
      projectId: syncProj.id,
      templateId: "comic-story",
      admission: null,
    });
    const afterSwap = await prisma.editorProject.findUniqueOrThrow({ where: { id: syncProj.id } });
    check(
      "syncTemplateStylePackLookForRender updates prior StylePack look to comic-story when generatedAiImageCount === 0",
      syncedSwap === true
      && projectVisualContextMod.parseProjectLook(afterSwap.projectLookJson)?.stylePack?.id === "comic-story"
      && afterSwap.treatmentPresetId === styleCatalog.stylePack("comic-story").treatmentPresetId
      && afterSwap.brandVisualPinAdmittedCohort === "treatment-100",
    );

    // Guard 1: refuses when generatedAiImageCount > 0
    const preflightRow = await prisma.contentPreflight.create({
      data: {
        userId: "u-hero94",
        projectId: syncProj.id,
        narrativeSourceKind: "creator-script",
        sourceHash: "hash-hero100",
        analyzerVersion: "v1",
        contentDomain: "general",
        suggestedVisualFormatId: "comic-storyboard",
        suggestedTreatmentJson: "{}",
      },
    });
    await prisma.projectVisualBeat.create({
      data: {
        userId: "u-hero94",
        projectId: syncProj.id,
        preflightId: preflightRow.id,
        beatKey: "beat-0",
        sequence: 0,
        sourceExcerptHash: "ex-0",
        beatJson: "{}",
        existingImageJobId: "img-job-existing-1",
      },
    });
    const refusedExistingImages = await projectLookMod.syncTemplateStylePackLookForRender({
      userId: "u-hero94",
      projectId: syncProj.id,
      templateId: "finance-clear",
      admission,
    });
    const afterRefusedImages = await prisma.editorProject.findUniqueOrThrow({ where: { id: syncProj.id } });
    check(
      "syncTemplateStylePackLookForRender refuses to overwrite project with generatedAiImageCount > 0",
      refusedExistingImages === false
      && projectVisualContextMod.parseProjectLook(afterRefusedImages.projectLookJson)?.stylePack?.id === "comic-story",
    );

    // Guard 2: refuses to overwrite manual custom unlinked ProjectLook (stylePack absent)
    const manualSnapshot = { ...projectLookMod.buildStylePackProjectLookSnapshot("finance-clear") };
    delete manualSnapshot.stylePack;
    const manualProj = await prisma.editorProject.create({
      data: {
        userId: "u-hero94",
        title: "Manual Custom Look Project",
        projectLookJson: JSON.stringify(manualSnapshot),
      },
    });
    const refusedManual = await projectLookMod.syncTemplateStylePackLookForRender({
      userId: "u-hero94",
      projectId: manualProj.id,
      templateId: "thai-ghost",
      admission,
    });
    check(
      "syncTemplateStylePackLookForRender refuses to overwrite manual custom unlinked ProjectLook",
      refusedManual === false,
    );

    // Guard 3: refuses to overwrite Brand Profile pin when projectLookJson is null
    const brandProfile = await prisma.brandProfile.create({
      data: {
        userId: "u-hero94",
        name: "Brand Guard",
        niche: "Tech",
        audience: "Creators",
        tone: "Clear",
        activeRevisionNumber: 1,
      },
    });
    const brandRev = await prisma.brandProfileRevision.create({
      data: {
        brandProfileId: brandProfile.id,
        version: 1,
        payloadJson: "{}",
        visualRecipeJson: "{}",
      },
    });
    const brandPinnedProj = await prisma.editorProject.create({
      data: {
        userId: "u-hero94",
        title: "Brand Pinned Project",
        brandProfileRevisionId: brandRev.id,
      },
    });
    const refusedBrand = await projectLookMod.syncTemplateStylePackLookForRender({
      userId: "u-hero94",
      projectId: brandPinnedProj.id,
      templateId: "thai-ghost",
      admission,
    });
    const afterRefusedBrand = await prisma.editorProject.findUniqueOrThrow({ where: { id: brandPinnedProj.id } });
    check(
      "syncTemplateStylePackLookForRender refuses to clobber pinned BrandProfileRevision",
      refusedBrand === false && afterRefusedBrand.projectLookJson === null,
    );

    // MCP brollSource schema + external + templateId flow (0 Hero image credits, held preview)
    const listedTools = await listTools(token);
    const createSchema = listedTools.find((t) => t.name === "create_video_job")?.inputSchema as {
      properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
    } | undefined;
    const brollProp = createSchema?.properties?.brollSource;
    check(
      "create_video_job.inputSchema.properties.brollSource exposes stock/hero-ai-image/automix/external and documents external",
      brollProp?.type === "string"
      && JSON.stringify(brollProp.enum) === JSON.stringify(["stock", "hero-ai-image", "automix", "external"])
      && Boolean(brollProp.description?.includes("external"))
      && Boolean(brollProp.description?.includes("replace_broll_window")),
    );

    const extQuote = await rawCallTool(token, "prepare_video_job", {
      script: SCRIPT,
      title: "External + Comic Template",
      templateId: "comic-story",
      brollSource: "external",
    });
    check(
      "prepare_video_job(templateId: comic-story, brollSource: external) quotes 0 Hero image credits",
      typeof extQuote.quoteId === "string"
      && extQuote.imageCreditCeiling === 0
      && extQuote.imageCountCeiling === 0,
    );
    const extCreated = await rawCallTool(token, "create_video_job", {
      quoteId: String(extQuote.quoteId),
    });
    check("create_video_job({ quoteId }) starts external + templateId job", typeof extCreated.jobId === "string");
    const extJobRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(extCreated.jobId) } });
    const extJobInput = JSON.parse(extJobRow.inputJson) as Record<string, unknown>;
    const extProjRow = await prisma.editorProject.findUniqueOrThrow({ where: { id: String(extCreated.projectId) } });
    check(
      "external + templateId job runs in hold mode with stockSource='none' while preserving comic-story ProjectLook",
      extJobInput.mcpHold === true
      && extJobInput.stockSource === "none"
      && extJobInput.brollSource === "external"
      && projectVisualContextMod.parseProjectLook(extProjRow.projectLookJson)?.stylePack?.id === "comic-story",
    );
  });

  await prisma.$disconnect();
  console.log(`\nverify-video-templates-mcp-web: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
