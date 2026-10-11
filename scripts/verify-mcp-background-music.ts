// verify-mcp-background-music.ts — EP5 U7 + #2 (HERO-71): change the background music after the
// video exists, with optional ducking under the voice, in the ONE edit model (ADR 0066) that both
// front-ends drive: the web Post phase (enqueueEditorExport via the jobs route) and the MCP
// set_background_music tool (Pending Edit Draft → export_video).
//
//   P) pure: the draft field's normalizer, speech segments, the ducking envelope, the render prop.
//   A/B) the real MCP route: the new tool is listed for the beta only, the outsider is refused
//        (feature_not_enabled, audited as denied), and its schema is agent-neutral.
//   C-F) the draft round-trip: list → set → get_edit_state echo → export_video's burn input →
//        the export persists the music into EditorProject.draftJson → the next seed reads it.
//   G) an old project (no new field) exports exactly the render inputs it exported before.
//   H) the web path (enqueueEditorExport): server-built audioMix, owner-checked tracks, a
//      client-supplied audioMix is never trusted.
//
// Self-contained: builds its own throwaway SQLite. No network, no paid provider.
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-background-music.ts

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "mcp-bgm-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
process.env.BRAND_ASSET_ROOT = mkdtempSync(join(tmpdir(), "mcp-bgm-brand-"));
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
async function section(name: string, body: () => Promise<void> | void) {
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const TOOL = "set_background_music";
const VOICE_FILE = "/api/renders/bgm-tools-voice.wav";
// Two phrases with a 1 s pause between them: ducking must dip under each and come back between.
const WORDS = [
  { word: "สวัสดี", startMs: 0, endMs: 600, startChar: 0, endChar: 6 },
  { word: "ครับ", startMs: 700, endMs: 1_400, startChar: 7, endChar: 11 },
  { word: "วันนี้", startMs: 2_400, endMs: 3_000, startChar: 12, endChar: 18 },
  { word: "ขายของ", startMs: 3_100, endMs: 4_000, startChar: 19, endChar: 25 },
];
const FULL_TEXT = "สวัสดี ครับ วันนี้ ขายของ";
const CARD0 = "สวัสดี ครับ";
const CARD1 = "วันนี้ ขายของ";
const SCRIPT = `${CARD0} ${CARD1}`;
const TIMING = {
  provider: "gemini",
  segments: [
    { text: CARD0, startMs: 0, durationMs: 1_400 },
    { text: CARD1, startMs: 2_400, durationMs: 1_600 },
  ],
};
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  voiceVolume: 1,
  bgVideos: [
    { src: "/api/stocks/bgm-a.mp4", start: 0, end: 2, sourceIndex: 0, clipDuration: 4 },
    { src: "/api/stocks/bgm-b.mp4", start: 2, end: 4, sourceIndex: 1, clipDuration: 4 },
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
  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-background-music.ts"));
  const fromSrc = (path: string) => realRequire(join(ROOT, "src", path));
  const bgm = fromSrc("lib/background-music") as typeof import("../src/lib/background-music");

  // ── P: pure ────────────────────────────────────────────────────────────────────────────────
  await section("P1) normalizeBackgroundMusicEdit: library paths only, volume 0..1, ducking boolean", () => {
    const sys = bgm.normalizeBackgroundMusicEdit({ track: "/music/1778-groove.mp3", volume: 0.3, ducking: true });
    check("a system track path round-trips", JSON.stringify(sys) === JSON.stringify({ track: "/music/1778-groove.mp3", volume: 0.3, ducking: true }), JSON.stringify(sys));
    const own = bgm.normalizeBackgroundMusicEdit({ track: "/api/music/user-u1-1-abc.wav", volume: 0.12, ducking: false });
    check("a user track path round-trips", own?.track === "/api/music/user-u1-1-abc.wav" && own.ducking === false);
    const none = bgm.normalizeBackgroundMusicEdit({ track: null, volume: 0.12, ducking: false });
    check("track null = no music (valid)", none !== null && none.track === null);
    check("volume clamps into 0..1", bgm.normalizeBackgroundMusicEdit({ track: null, volume: 7, ducking: false })?.volume === 1
      && bgm.normalizeBackgroundMusicEdit({ track: null, volume: -1, ducking: false })?.volume === 0);
    check("missing ducking reads as false (old behaviour)", bgm.normalizeBackgroundMusicEdit({ track: null, volume: 0.2 })?.ducking === false);
    for (const [label, value] of [
      ["path traversal", { track: "/music/../../etc/passwd", volume: 0.1, ducking: false }],
      ["nested path", { track: "/music/a/b.mp3", volume: 0.1, ducking: false }],
      ["external URL", { track: "https://evil.example/x.mp3", volume: 0.1, ducking: false }],
      ["bare filename", { track: "groove.mp3", volume: 0.1, ducking: false }],
      ["empty filename", { track: "/music/", volume: 0.1, ducking: false }],
      ["backslash", { track: "/music/a\\b.mp3", volume: 0.1, ducking: false }],
      ["NaN volume", { track: null, volume: Number.NaN, ducking: false }],
      ["string volume", { track: null, volume: "0.5", ducking: false }],
      ["non-boolean ducking", { track: null, volume: 0.5, ducking: "yes" }],
      ["not an object", "groove"],
    ] as Array<[string, unknown]>) {
      check(`refuses ${label}`, bgm.normalizeBackgroundMusicEdit(value) === null);
    }
  });

  await section("P2) speechSegments: word timing first, phrases merged across short gaps, captions as fallback", () => {
    const segs = bgm.speechSegments({ words: WORDS, captions: [] });
    check("words 0-1400 and 2400-4000 → two phrases (100 ms gaps merged, 1000 ms pause kept)",
      JSON.stringify(segs) === JSON.stringify([{ startMs: 0, endMs: 1_400 }, { startMs: 2_400, endMs: 4_000 }]), JSON.stringify(segs));
    const fromCaptions = bgm.speechSegments({ captions: [{ startMs: 0, endMs: 1_000 }, { startMs: 1_200, endMs: 2_000 }, { startMs: 5_000, endMs: 6_000 }] });
    check("no words → caption timing (200 ms gap merged)", JSON.stringify(fromCaptions) === JSON.stringify([{ startMs: 0, endMs: 2_000 }, { startMs: 5_000, endMs: 6_000 }]), JSON.stringify(fromCaptions));
    const messy = bgm.speechSegments({ words: [{ startMs: 3_000, endMs: 3_500 }, { startMs: Number.NaN, endMs: 4 }, { startMs: 50, endMs: 10 }, { startMs: 0, endMs: 500 }] });
    check("unsorted input sorted; invalid / inverted spans dropped", JSON.stringify(messy) === JSON.stringify([{ startMs: 0, endMs: 500 }, { startMs: 3_000, endMs: 3_500 }]), JSON.stringify(messy));
    check("nothing usable → []", bgm.speechSegments({ words: [], captions: [] }).length === 0);
  });

  await section("P3) envelope: ramps of 150-250 ms, music dips under each phrase and returns between", () => {
    const ramp = bgm.DUCK_RAMP_MS;
    check("ramp is within the 150-250 ms the task asks for", ramp >= 150 && ramp <= 250, String(ramp));
    check("ducked level is a real dip (between 15% and 50% of the set volume)", bgm.DUCK_RATIO >= 0.15 && bgm.DUCK_RATIO <= 0.5, String(bgm.DUCK_RATIO));
    const segs = [{ startMs: 1_000, endMs: 2_000 }, { startMs: 4_000, endMs: 5_000 }];
    const amount = (ms: number) => bgm.duckAmountAt(ms, segs);
    check("well before a phrase: no duck", amount(0) === 0 && amount(1_000 - ramp - 1) === 0);
    check("ramp down starts before the phrase (linear)", near(amount(1_000 - ramp / 2), 0.5));
    check("inside the phrase: fully ducked", amount(1_000) === 1 && amount(1_500) === 1 && amount(2_000) === 1);
    check("ramp back up after the phrase", near(amount(2_000 + ramp / 2), 0.5) && amount(2_000 + ramp) === 0);
    check("between phrases the music is back at full", amount(3_000) === 0);
    check("second phrase ducks too", amount(4_500) === 1);
    const vol = 0.2;
    check("ducking off: constant volume (today's mix)", [0, 1_500, 3_000, 4_500].every((ms) => bgm.bgmGainAt(ms, { volume: vol, ducking: false, segments: segs }) === vol));
    check("ducking on: volume × DUCK_RATIO under the voice", near(bgm.bgmGainAt(1_500, { volume: vol, ducking: true, segments: segs }), vol * bgm.DUCK_RATIO));
    check("ducking on: full volume between phrases", near(bgm.bgmGainAt(3_000, { volume: vol, ducking: true, segments: segs }), vol));
    check("ducking on with no segments: constant volume", bgm.bgmGainAt(1_500, { volume: vol, ducking: true, segments: [] }) === vol);
  });

  await section("P4) normalizeAudioMix (the render prop): voice required, numbers clamped, segments bounded", () => {
    const mix = bgm.normalizeAudioMix({
      voiceFile: "http://x/api/renders/v.wav", voiceVolume: 1, bgmFile: "http://x/api/music/a.mp3", bgmVolume: 3, ducking: true,
      duckSegments: [{ startMs: 0, endMs: 100 }, { startMs: "x", endMs: 2 }, { startMs: 300, endMs: 200 }],
    });
    check("valid mix kept, bgmVolume clamped, bad segments dropped",
      mix?.voiceFile === "http://x/api/renders/v.wav" && mix.bgmVolume === 1 && mix.ducking === true
        && JSON.stringify(mix.duckSegments) === JSON.stringify([{ startMs: 0, endMs: 100 }]), JSON.stringify(mix));
    check("no voiceFile → null (never a silent video)", bgm.normalizeAudioMix({ bgmFile: "x", bgmVolume: 0.1 }) === null);
    check("not an object → null", bgm.normalizeAudioMix("mix") === null && bgm.normalizeAudioMix(null) === null);
    const many = Array.from({ length: bgm.MAX_DUCK_SEGMENTS + 50 }, (_, i) => ({ startMs: i * 1_000, endMs: i * 1_000 + 100 }));
    check("segment count is capped", (bgm.normalizeAudioMix({ voiceFile: "v", duckSegments: many })?.duckSegments?.length ?? 0) === bgm.MAX_DUCK_SEGMENTS);
  });

  // ── DB-backed: the real MCP route ────────────────────────────────────────────────────────────
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { isBurnAlreadyPaid, recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const draftLib = fromSrc("lib/mcp/pending-edit-draft") as typeof import("../src/lib/mcp/pending-edit-draft");
  const enqueueLib = fromSrc("lib/editor-export-enqueue") as typeof import("../src/lib/editor-export-enqueue");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");

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
        "user-agent": "verify-mcp-background-music/1.0",
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
  const failures: Json[] = [];
  async function callTool(token: string, name: string, args: Json): Promise<Json> {
    const message = await rpc(token, "tools/call", { name, arguments: args });
    const result = message.result as { content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    const reply = JSON.parse(text) as Json;
    if (reply.error != null && name === TOOL) failures.push(reply);
    return reply;
  }

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
    const { token } = await createMcpToken(id, "verify-mcp-background-music");
    return { user, token };
  }
  const tester = await makeUser("u-bgm", "qa-bgm@aoacademy.co");
  const outsider = await makeUser("u-bgm-outsider", "bgm-outsider@example.com");

  const sysA = await prisma.music.create({ data: { title: "Lofi Chill", filename: "sys-a.mp3", mood: "chill" } });
  const sysB = await prisma.music.create({ data: { title: "Corporate Happy", filename: "sys-b.mp3", mood: "corporate" } });
  const ownTrack = await prisma.userMusic.create({ data: { userId: tester.user.id, title: "My Jingle", filename: "user-u-bgm-1-own.mp3", sizeBytes: 10 } });
  const foreignTrack = await prisma.userMusic.create({ data: { userId: outsider.user.id, title: "Not Yours", filename: "user-u-bgm-outsider-1-x.mp3", sizeBytes: 10 } });

  let renderSeq = 0;
  let gallerySeq = 0;
  const burnBodies: Json[] = [];
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
              { text: CARD0, startMs: 0, endMs: 1_400, tag: "hook" },
              { text: CARD1, startMs: 2_400, endMs: 4_000, tag: "body" },
            ],
            words: WORDS,
            fullText: FULL_TEXT,
            audioDurationMs: 4_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_000 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["shop"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "shop" }] } as T;
        if (path === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: Json & { videoUrl?: string }; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          if (isBurn) burnBodies.push(structuredClone(request.subtitleOverlayConfig!));
          const id = `rj-bgm-${renderSeq}`;
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
        if (path === "/api/videos") { gallerySeq += 1; return { id: `gallery-bgm-${gallerySeq}` } as T; }
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(): Promise<T> { return {} as T; },
      async get<T>(path: string): Promise<T> {
        if (path.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(path)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          return { progress: 100, videoUrl: rj?.videoUrl ?? null, error: null, stage: "done" } as T;
        }
        if (path === "/api/music") {
          return {
            tracks: await prisma.music.findMany(),
            userTracks: await prisma.userMusic.findMany({ where: { userId } }),
          } as T;
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
  const inputOf = (row: { inputJson: string }) => JSON.parse(row.inputJson) as Json;
  async function projectRow(projectId: string) {
    return prisma.editorProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { pendingEditJson: true, pendingEditRevision: true, activeJobId: true, draftJson: true, draftRevision: true },
    });
  }
  async function heldRoot(key: string, extra: Json = {}) {
    const reply = await callTool(tester.token, "create_video_job", {
      script: SCRIPT, voiceProvider: "gemini", exportMode: "hold", idempotencyKey: key, ...extra,
    });
    if (typeof reply.jobId !== "string") throw new Error(`fixture: hold create failed: ${JSON.stringify(reply)}`);
    const root = await runJob(reply.jobId, tester.user.id);
    if (root.status !== "done" || !root.projectId) throw new Error(`fixture: held root ended ${root.status}: ${root.errorMessage}`);
    return { root, projectId: root.projectId };
  }

  // ── A ──
  await section("A) tools/list: the beta sees set_background_music, the outsider does not; schema agent-neutral", async () => {
    const betaTools = await listTools(tester.token);
    check("beta tools/list includes set_background_music", betaTools.some((tool) => tool.name === TOOL), betaTools.map((t) => t.name).join(","));
    check("non-beta tools/list hides set_background_music", !(await listTools(outsider.token)).some((tool) => tool.name === TOOL));
    const problems = verifyAgentNeutralSchemas(betaTools, [TOOL]);
    check("G13: emitted schema is agent-neutral", problems.length === 0, problems.join("; "));
  });

  // ── B ──
  await section("B) outsider: a direct call is refused feature_not_enabled and audited as denied", async () => {
    const reply = await callTool(outsider.token, TOOL, { jobId: "any", trackId: sysA.id });
    check("feature_not_enabled envelope", reply.error === "feature_not_enabled" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    const audit = await prisma.toolCallAudit.findFirst({ where: { userId: outsider.user.id, toolName: TOOL }, orderBy: { createdAt: "desc" } });
    check("the refusal is audited as denied", audit?.status === "denied", JSON.stringify(audit));
  });

  // A held preview created WITH library music (sys-a at the default 12 %).
  const held = await heldRoot("bgm-held-1", { bgmFile: `/music/${sysA.filename}` });
  const baseRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: held.root.id } });
  const baseConfig = (JSON.parse(baseRow.outputJson ?? "{}") as { preview?: { config?: Json } }).preview?.config ?? {};
  check("fixture: the base render baked sys-a at 0.12", baseConfig.bgmFile === `/music/${sysA.filename}` && baseConfig.bgmVolume === 0.12, JSON.stringify(baseConfig));

  // ── C ──
  await section("C) set_background_music(jobId) alone: lists tracks + the current music, writes nothing", async () => {
    const before = await projectRow(held.projectId);
    fetchLog.length = 0;
    const reply = await callTool(tester.token, TOOL, { jobId: held.root.id });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    const tracks = (reply.tracks ?? []) as Array<{ trackId: string; title: string; kind: string }>;
    const ids = tracks.map((t) => t.trackId);
    check("lists both system tracks and the caller's own upload", ids.includes(sysA.id) && ids.includes(sysB.id) && ids.includes(ownTrack.id), JSON.stringify(tracks));
    check("never lists another account's upload", !ids.includes(foreignTrack.id));
    check("each track says system/user", tracks.every((t) => t.kind === "system" || t.kind === "user"));
    const current = reply.backgroundMusic as Json;
    check("current = the preview's own music (sys-a, 12 %, no ducking, unchanged)",
      current?.trackId === sysA.id && current?.volume === 12 && current?.ducking === false && current?.changed === false, JSON.stringify(current));
    const after = await projectRow(held.projectId);
    check("listing writes nothing (revision unchanged)", after.pendingEditRevision === before.pendingEditRevision && after.pendingEditJson === before.pendingEditJson);
  });

  // ── D ──
  await section("D) set: new track → ducking on by default; volume-only keeps ducking; none; refusals are envelopes", async () => {
    fetchLog.length = 0;
    const set = await callTool(tester.token, TOOL, { jobId: held.root.id, trackId: sysB.id });
    check("no network call", fetchLog.length === 0, fetchLog.join(","));
    const music = set.backgroundMusic as Json;
    check("accepted: sys-b, volume kept at 12 %, ducking ON by default for a new pick",
      set.ok === true && music?.trackId === sysB.id && music?.volume === 12 && music?.ducking === true && music?.changed === true, JSON.stringify(set));
    const stored = draftLib.parsePendingEditDraft((await projectRow(held.projectId)).pendingEditJson);
    check("the pending draft stores the library path at 0..1",
      JSON.stringify(stored?.backgroundMusic) === JSON.stringify({ track: `/music/${sysB.filename}`, volume: 0.12, ducking: true }), JSON.stringify(stored?.backgroundMusic));

    const louder = await callTool(tester.token, TOOL, { jobId: held.root.id, volume: 35 });
    check("volume-only change keeps the track and the ducking choice",
      (louder.backgroundMusic as Json)?.trackId === sysB.id && (louder.backgroundMusic as Json)?.volume === 35 && (louder.backgroundMusic as Json)?.ducking === true, JSON.stringify(louder));

    const state = await callTool(tester.token, "get_edit_state", { jobId: held.root.id });
    check("get_edit_state echoes the edited music", (state.backgroundMusic as Json)?.trackId === sysB.id && (state.backgroundMusic as Json)?.volume === 35, JSON.stringify(state.backgroundMusic));
    const allowed = (state.allowed as Json)?.backgroundMusic as Json;
    check("get_edit_state.allowed states the volume range", (allowed?.volume as Json)?.min === 0 && (allowed?.volume as Json)?.max === 100, JSON.stringify(allowed));

    const foreign = await callTool(tester.token, TOOL, { jobId: held.root.id, trackId: foreignTrack.id });
    check("another account's upload → invalid_input envelope", foreign.error === "invalid_input" && checkFailureEnvelope(foreign).length === 0, JSON.stringify(foreign));
    const unknown = await callTool(tester.token, TOOL, { jobId: held.root.id, trackId: "no-such-track" });
    check("unknown trackId → invalid_input", unknown.error === "invalid_input", JSON.stringify(unknown));
    const loud = await callTool(tester.token, TOOL, { jobId: held.root.id, volume: 150 });
    check("volume 150 → invalid_input (0-100)", loud.error === "invalid_input", JSON.stringify(loud));
    const notHeld = await callTool(tester.token, TOOL, { jobId: "nope", trackId: sysA.id });
    check("unknown jobId → invalid_input", notHeld.error === "invalid_input", JSON.stringify(notHeld));
    const unchanged = draftLib.parsePendingEditDraft((await projectRow(held.projectId)).pendingEditJson);
    check("refusals wrote nothing", unchanged?.backgroundMusic?.volume === 0.35 && unchanged?.backgroundMusic?.track === `/music/${sysB.filename}`);

    const web = draftLib.pendingEditForWeb(await projectRow(held.projectId));
    check("pendingEditForWeb carries the music to the web Post phase", JSON.stringify(web?.draft.backgroundMusic) === JSON.stringify({ track: `/music/${sysB.filename}`, volume: 0.35, ducking: true }), JSON.stringify(web?.draft.backgroundMusic));
  });

  // ── E ──
  await section("E) export_video: the burn mutes the base and mixes voice + the new music with the duck envelope", async () => {
    burnBodies.length = 0;
    const reply = await callTool(tester.token, "export_video", { jobId: held.root.id });
    check("export enqueued", reply.status === "exporting" && typeof reply.exportJobId === "string", JSON.stringify(reply));
    const exportRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(reply.exportJobId) } });
    const overlay = inputOf(exportRow).subtitleOverlayConfig as Json;
    const mix = overlay.audioMix as Json;
    check("audioMix: server voice track + sys-b at 0.35 + ducking",
      mix?.voiceFile === VOICE_FILE && mix?.voiceVolume === 1 && mix?.bgmFile === `/music/${sysB.filename}`
        && mix?.bgmVolume === 0.35 && mix?.ducking === true, JSON.stringify(mix));
    check("duck segments = the two spoken phrases",
      JSON.stringify(mix?.duckSegments) === JSON.stringify([{ startMs: 0, endMs: 1_400 }, { startMs: 2_400, endMs: 4_000 }]), JSON.stringify(mix?.duckSegments));
    check("no stray overlay bgm next to the mix", overlay.bgmFile === undefined && overlay.bgmVolume === undefined);

    const done = await runJob(exportRow.id, tester.user.id);
    check("export finished", done.status === "done", String(done.errorMessage));
    check("the burn render request carries the same audioMix", JSON.stringify(burnBodies.at(-1)?.audioMix) === JSON.stringify(mix), JSON.stringify(burnBodies.at(-1)?.audioMix));

    const project = await projectRow(held.projectId);
    const projectDraft = JSON.parse(project.draftJson ?? "{}") as Json;
    check("survives Export: EditorProject.draftJson.backgroundMusic holds the exported music",
      JSON.stringify(projectDraft.backgroundMusic) === JSON.stringify({ track: `/music/${sysB.filename}`, volume: 0.35, ducking: true }), JSON.stringify(projectDraft.backgroundMusic));
    check("the pending draft was cleared by the export", project.pendingEditJson === null);
    const reseed = await callTool(tester.token, "get_edit_state", { jobId: held.root.id });
    check("the next seed reads the music back from the project draft", (reseed.backgroundMusic as Json)?.trackId === sysB.id
      && (reseed.backgroundMusic as Json)?.volume === 35 && (reseed.backgroundMusic as Json)?.changed === true, JSON.stringify(reseed.backgroundMusic));

    const discard = await callTool(tester.token, TOOL, { jobId: held.root.id, trackId: "none" });
    check("trackId \"none\" removes the music", (discard.backgroundMusic as Json)?.trackId === "none", JSON.stringify(discard.backgroundMusic));
    burnBodies.length = 0;
    const again = await callTool(tester.token, "export_video", { jobId: held.root.id });
    const againRow = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(again.exportJobId) } });
    const noneMix = (inputOf(againRow).subtitleOverlayConfig as Json).audioMix as Json;
    check("\"none\" export: voice only, base still muted (no bgmFile in the mix)", noneMix?.voiceFile === VOICE_FILE && noneMix?.bgmFile === undefined, JSON.stringify(noneMix));
    await runJob(againRow.id, tester.user.id);
  });

  // ── F ──
  await section("F) discard_edits resets the music to the project's value", async () => {
    const fresh = await heldRoot("bgm-held-discard", { bgmFile: `/music/${sysA.filename}` });
    await callTool(tester.token, TOOL, { jobId: fresh.root.id, trackId: ownTrack.id, volume: 50, ducking: false });
    const own = await callTool(tester.token, "get_edit_state", { jobId: fresh.root.id });
    check("own upload accepted with explicit ducking:false", (own.backgroundMusic as Json)?.trackId === ownTrack.id && (own.backgroundMusic as Json)?.ducking === false, JSON.stringify(own.backgroundMusic));
    const stored = draftLib.parsePendingEditDraft((await projectRow(fresh.projectId)).pendingEditJson);
    check("own upload stored as /api/music/<file>", stored?.backgroundMusic?.track === `/api/music/${ownTrack.filename}`, JSON.stringify(stored?.backgroundMusic));
    await callTool(tester.token, "discard_edits", { jobId: fresh.root.id });
    const after = await callTool(tester.token, "get_edit_state", { jobId: fresh.root.id });
    check("after discard: back to the preview's own music (unchanged)", (after.backgroundMusic as Json)?.trackId === sysA.id
      && (after.backgroundMusic as Json)?.changed === false, JSON.stringify(after.backgroundMusic));
  });

  // ── G ──
  await section("G) an old project with no music edit exports exactly today's render inputs", async () => {
    const old = await heldRoot("bgm-held-old", { bgmFile: `/music/${sysA.filename}` });
    const loaded = await draftLib.loadPendingEditState(tester.user.id, old.root);
    if (!loaded.ok) throw new Error(`load failed: ${loaded.code}`);
    const expected = draftLib.toBurnConfig(loaded.state.draft, loaded.state.base) as Json;
    const reply = await callTool(tester.token, "export_video", { jobId: old.root.id });
    const row = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(reply.exportJobId) } });
    const overlay = inputOf(row).subtitleOverlayConfig as Json;
    check("no audioMix key at all", !("audioMix" in overlay), JSON.stringify(Object.keys(overlay)));
    check("burn config identical to the pre-feature builder's output", JSON.stringify(overlay) === JSON.stringify(expected), `${JSON.stringify(overlay).slice(0, 300)}\n        ${JSON.stringify(expected).slice(0, 300)}`);
    const projectDraft = JSON.parse((await projectRow(old.projectId)).draftJson ?? "{}") as Json;
    await runJob(row.id, tester.user.id);
    const afterDraft = JSON.parse((await projectRow(old.projectId)).draftJson ?? "{}") as Json;
    check("the export writes no backgroundMusic into the project draft", !("backgroundMusic" in projectDraft) && !("backgroundMusic" in afterDraft), JSON.stringify(afterDraft));
  });

  // ── H ──
  await section("H) web path (enqueueEditorExport): server-built mix, owner-checked track, client audioMix never trusted", async () => {
    const web = await heldRoot("bgm-web-1", { bgmFile: `/music/${sysA.filename}` });
    const loaded = await draftLib.loadPendingEditState(tester.user.id, web.root);
    if (!loaded.ok) throw new Error(`load failed: ${loaded.code}`);
    const overlay = draftLib.toBurnConfig(loaded.state.draft, loaded.state.base) as Json;
    let seq = 0;
    const enqueue = async (backgroundMusic: unknown, rawOverlay: Json = overlay) => {
      seq += 1;
      const result = await enqueueLib.enqueueEditorExport({
        user: tester.user,
        brandVisualAccess: { canUse: false },
        sourceJobId: web.root.id,
        subtitleOverlayConfig: rawOverlay,
        idempotencyKey: `bgm-web-export-${seq}`,
        ...(backgroundMusic === undefined ? {} : { backgroundMusic }),
      });
      if (result.ok) {
        const exportOverlay = inputOf(result.job).subtitleOverlayConfig as Json;
        await prisma.videoJob.update({ where: { id: result.job.id }, data: { status: "canceled" } });
        return { ok: true as const, overlay: exportOverlay };
      }
      return result;
    };

    const forged = await enqueue(undefined, { ...overlay, audioMix: { voiceFile: "https://evil.example/x.mp3", bgmVolume: 1 } });
    check("no backgroundMusic: a client-sent audioMix is stripped (today's inputs)",
      forged.ok && !("audioMix" in forged.overlay) && JSON.stringify(forged.overlay) === JSON.stringify(overlay), JSON.stringify(forged));

    const foreign = await enqueue({ track: `/api/music/${foreignTrack.filename}`, volume: 0.2, ducking: true });
    check("another account's upload → 400 invalid_background_music", !foreign.ok && foreign.status === 400 && foreign.error === "invalid_background_music" && typeof foreign.message === "string", JSON.stringify(foreign));
    const missing = await enqueue({ track: "/music/not-in-library.mp3", volume: 0.2, ducking: true });
    check("a path not in the library → invalid_background_music", !missing.ok && missing.error === "invalid_background_music", JSON.stringify(missing));
    const garbage = await enqueue({ track: "../../etc/passwd", volume: 0.2, ducking: true });
    check("a malformed value → invalid_background_music", !garbage.ok && garbage.error === "invalid_background_music", JSON.stringify(garbage));

    const own = await enqueue({ track: `/api/music/${ownTrack.filename}`, volume: 0.3, ducking: false });
    const ownMix = own.ok ? own.overlay.audioMix as Json : null;
    check("own upload, ducking off → mix without duck segments",
      ownMix?.voiceFile === VOICE_FILE && ownMix?.bgmFile === `/api/music/${ownTrack.filename}` && ownMix?.bgmVolume === 0.3
        && ownMix?.ducking === false && ownMix?.duckSegments === undefined, JSON.stringify(ownMix));
    const sameAsBase = await enqueue({ track: `/music/${sysA.filename}`, volume: 0.05, ducking: true });
    check("the base's own track at a new volume is accepted", sameAsBase.ok && (sameAsBase.overlay.audioMix as Json)?.bgmVolume === 0.05, JSON.stringify(sameAsBase));
    const silent = await enqueue({ track: null, volume: 0.12, ducking: false });
    check("track null → voice-only mix", silent.ok && (silent.overlay.audioMix as Json)?.voiceFile === VOICE_FILE && (silent.overlay.audioMix as Json)?.bgmFile === undefined, JSON.stringify(silent));
    const absent = await enqueue(null);
    check("backgroundMusic null = no override (today's inputs)", absent.ok && !("audioMix" in absent.overlay), JSON.stringify(absent));
  });

  // ── I ──
  await section("I) G14: every refusal from set_background_music is a full envelope", () => {
    check("refusals were exercised", failures.length >= 4, String(failures.length));
    for (const failure of failures) {
      const problems = checkFailureEnvelope(failure);
      check(`${String(failure.error)}: envelope`, problems.length === 0, `${problems.join("; ")} ${JSON.stringify(failure)}`);
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
      console.error("FAILED: background music change + ducking verification");
      process.exit(1);
    }
    console.log("OK: background music change + ducking: all checks passed");
    process.exit(0);
  });
