// verify-mcp-preview-frame.ts — W4 (EP5 backlog U6): `get_preview_frame`, the MCP observation
// tool that returns ONE still JPEG of what export_video would produce at `atMs`, pending edit
// draft included (headline, caption text, replaced B-roll windows). ADR 0066 allows an
// observation tool to ship MCP-only.
//
// Every MCP call goes through the REAL route handler (same harness as verify-mcp-edit-tools.ts —
// only Clerk + the network key preflight are stubbed) and the stills are REAL Remotion
// renderStill calls against a tiny ffmpeg fixture (solid-colour 270x480 clips served by a local
// HTTP server standing in for the internal media base), so the pixel checks prove which layer
// the frame actually shows.
//
// Covers: gating (tools/list + direct call), auth/ownership (same refusal as get_edit_state),
// input validation, the image reply shape (540x960 JPEG < 200 KB + one text line, audit row
// without base64), the draft in the frame (headline, edited caption, a pending B-roll window),
// bundle warm-up / reuse (own cached bundle, the render worker's published bundle), the per-user
// rate limit, the global concurrency of 1 with a one-deep queue that fails fast, the timeout,
// and no temp-file leftovers.
//
// Self-contained: throwaway SQLite + private TMPDIR. Needs ffmpeg and a Chromium Remotion can
// launch (CI downloads Remotion's own; locally set CHROME_BIN to a chrome-headless-shell).
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-preview-frame.ts

import { execFileSync, execSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
// Private TMPDIR first: everything Remotion/Chromium writes to os.tmpdir() lands here, so the
// leftover check at the end sees exactly what this run left behind.
const privateTmp = mkdtempSync(join(tmpdir(), "mcp-preview-frame-tmp-"));
process.env.TMPDIR = privateTmp;
const dir = mkdtempSync(join(privateTmp, "db-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
process.env.BRAND_ASSET_ROOT = mkdtempSync(join(privateTmp, "brand-"));
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
  "MANAGED_GEMINI",
  "GEMINI_SERVER_KEY",
  "NEXTAUTH_URL",
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

const TOOL = "get_preview_frame";
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
const VOICE_FILE = "/api/renders/preview-frame-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/preview-blue.mp4", start: 0, end: 2, sourceIndex: 0, clipDuration: 4 },
    { src: "/api/stocks/preview-yellow.mp4", start: 2, end: 4, sourceIndex: 1, clipDuration: 4 },
  ],
};

type Json = Record<string, unknown>;
type Content = { type: string; text?: string; data?: string; mimeType?: string };

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

function treeBytes(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}

function listTmp(): string[] {
  return readdirSync(privateTmp).sort();
}

async function main() {
  const realRequire = createRequire(join(ROOT, "scripts/verify-mcp-preview-frame.ts"));
  const fromSrc = (path: string) => realRequire(join(ROOT, "src", path));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const draftLib = fromSrc("lib/mcp/pending-edit-draft") as typeof import("../src/lib/mcp/pending-edit-draft");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");
  const { getFfmpegPath } = fromSrc("lib/ffmpeg-path") as typeof import("../src/lib/ffmpeg-path");
  const { SERVER_INSTRUCTIONS } = fromSrc("lib/mcp/onboarding") as typeof import("../src/lib/mcp/onboarding");
  const previewFrame = fromSrc("lib/mcp/preview-frame") as typeof import("../src/lib/mcp/preview-frame");
  const editTools = fromSrc("lib/mcp/edit-tools") as typeof import("../src/lib/mcp/edit-tools");
  const previewStill = fromSrc("lib/render/preview-still") as typeof import("../src/lib/render/preview-still");
  const pointer = fromSrc("lib/render/remotion-bundle-pointer") as typeof import("../src/lib/render/remotion-bundle-pointer");
  const sharpModule = realRequire("sharp") as { default?: typeof import("sharp") } & typeof import("sharp");
  const sharp = sharpModule.default ?? sharpModule;

  // ── fixture media: solid colours, so a pixel says which layer the frame shows ──
  const mediaDir = mkdtempSync(join(privateTmp, "media-"));
  const COLORS = { green: "0x00C800", blue: "0x0000DC", yellow: "0xDCDC00", red: "0xDC0000" } as const;
  for (const [name, hex] of Object.entries(COLORS)) {
    execFileSync(getFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${hex}:s=270x480:r=30:d=4`,
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
      join(mediaDir, `${name}.mp4`),
    ]);
  }
  const mediaHits: string[] = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://x").pathname;
    mediaHits.push(pathname);
    // The held preview's base render (rj-…-base.mp4) is green; stock windows blue/yellow; the
    // replacement import red. Anything else is a 404 the render must survive.
    const color = pathname.endsWith("-base.mp4") ? "green"
      : pathname.includes("preview-blue") ? "blue"
      : pathname.includes("preview-yellow") ? "yellow"
      : pathname.includes("preview-red") ? "red"
      : null;
    if (!color) { response.writeHead(404).end(); return; }
    const file = join(mediaDir, `${color}.mp4`);
    const size = statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.writeHead(206, {
        "content-type": "video/mp4", "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mediaPort = (server.address() as { port: number }).port;
  process.env.RENDER_INTERNAL_BASE_URL = `http://127.0.0.1:${mediaPort}`;

  // Runtime seams: bundle cache under the private TMPDIR, a local Chromium when given.
  const runtime = previewStill.previewStillRuntime;
  runtime.cacheRoot = join(dir, "preview-cache");
  runtime.browserExecutable = process.env.CHROME_BIN?.trim() || null;
  runtime.timeoutMs = 120_000; // CI's first render on a cold box is slow; section J tests the deadline
  runtime.bundleWaitMs = 600_000;
  // One-time browser download (CI) happens here, before the leftover snapshot, not inside a render.
  const { ensureBrowser } = realRequire("@remotion/renderer") as typeof import("@remotion/renderer");
  await ensureBrowser({ browserExecutable: runtime.browserExecutable });

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
  async function rpc(token: string, method: string, params: unknown): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "verify-mcp-preview-frame/1.0",
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
  async function callContent(token: string, name: string, args: Json): Promise<Content[]> {
    const message = await rpc(token, "tools/call", { name, arguments: args });
    const content = (message.result as { content?: Content[] } | undefined)?.content;
    if (!content?.length) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    return content;
  }
  /** A JSON (text) reply — every refusal, and every tool other than a successful preview. */
  const fixtureOwners = new Map<string, string>();
  async function callTool(token: string, name: string, args: Json): Promise<Json> {
    const reply = await rawCallTool(token, name, args);
    if (name !== "create_video_job" || reply.code !== "confirmation_required" || typeof reply.quoteId !== "string") return reply;
    const ownerId = fixtureOwners.get(token);
    if (!ownerId) throw new Error("Unknown fixture owner");
    const { decideVideoQuote } = await import("../src/lib/mcp/video-quote.server");
    await decideVideoQuote(ownerId, reply.quoteId, "approve");
    return rawCallTool(token, name, { quoteId: reply.quoteId });
  }
  async function rawCallTool(token: string, name: string, args: Json): Promise<Json> {
    const content = await callContent(token, name, args);
    const text = content.find((block) => block.type === "text")?.text;
    if (!text) throw new Error(`tools/call ${name} has no text block: ${JSON.stringify(content).slice(0, 300)}`);
    return JSON.parse(text) as Json;
  }
  type Still = { image: Content | undefined; body: Json; jpeg: Buffer | null };
  let dumpSeq = 0;
  async function preview(token: string, args: Json): Promise<Still> {
    const content = await callContent(token, TOOL, args);
    const image = content.find((block) => block.type === "image");
    const text = content.find((block) => block.type === "text")?.text ?? "{}";
    const jpeg = image?.data ? Buffer.from(image.data, "base64") : null;
    // Optional: PREVIEW_FRAME_DUMP_DIR=<dir> keeps each still for a human look.
    if (jpeg && process.env.PREVIEW_FRAME_DUMP_DIR) {
      writeFileSync(join(process.env.PREVIEW_FRAME_DUMP_DIR, `still-${++dumpSeq}-${String(args.atMs)}ms.jpg`), jpeg);
    }
    return { image, body: JSON.parse(text) as Json, jpeg };
  }
  async function pixel(jpeg: Buffer, x: number, y: number) {
    const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const offset = ((y + dy) * info.width + (x + dx)) * info.channels;
        r += data[offset]; g += data[offset + 1]; b += data[offset + 2]; n += 1;
      }
    }
    return { r: r / n, g: g / n, b: b / n };
  }
  /** Pixels in rows [y0, y1) that are clearly NOT the background colour (text, boxes). */
  async function foreignPixels(jpeg: Buffer, y0: number, y1: number, isBackground: (p: { r: number; g: number; b: number }) => boolean) {
    const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * info.channels;
        if (!isBackground({ r: data[offset], g: data[offset + 1], b: data[offset + 2] })) count += 1;
      }
    }
    return count;
  }
  const isGreen = (p: { r: number; g: number; b: number }) => p.g > 140 && p.r < 90 && p.b < 90;
  const isRed = (p: { r: number; g: number; b: number }) => p.r > 140 && p.g < 90 && p.b < 90;

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
    const { token } = await createMcpToken(id, "verify-mcp-preview-frame");
    fixtureOwners.set(token, user.id);
    return { user, token };
  }
  // Internal-tester emails pass the MCP Editor Project gate; example.com does not.
  const tester = await makeUser("u-preview", "qa-preview@aoacademy.co");
  const otherTester = await makeUser("u-preview-2", "qa-preview-2@aoacademy.co");
  const outsider = await makeUser("u-preview-outsider", "preview-outsider@example.com");

  let renderSeq = 0;
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
          const request = (body ?? {}) as { subtitleOverlayConfig?: unknown; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-preview-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          await prisma.renderJob.create({
            data: {
              id, userId, parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER", status: "DONE",
              payload: "{}", videoUrl, reservedQuota: true, reservedMinutes: 1,
            },
          });
          await prisma.user.update({ where: { id: userId }, data: { minutesUsed: { increment: 1 } } });
          await recordChargedClip(userId, videoUrl, 1);
          return { jobId: id } as T;
        }
        if (path.startsWith("/api/videos/render-cancel")) return {} as T;
        if (path === "/api/videos") return { id: `gallery-preview-${renderSeq}` } as T;
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(): Promise<T> { return {} as T; },
      async get<T>(path: string): Promise<T> {
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
  async function heldRootVia(who: { user: { id: string }; token: string }, key: string) {
    const reply = await callTool(who.token, "create_video_job", {
      script: SCRIPT, voiceProvider: "gemini", exportMode: "hold", idempotencyKey: key,
    });
    if (typeof reply.jobId !== "string") throw new Error(`fixture: hold create failed: ${JSON.stringify(reply)}`);
    const root = await runJob(reply.jobId, who.user.id);
    if (root.status !== "done" || !root.projectId) throw new Error(`fixture: held root ended ${root.status}: ${root.errorMessage}`);
    return root;
  }
  const rateUsed = (userId: string) => previewFrame.previewFrameRateUsed(userId);
  const lastAudit = (userId: string) => prisma.toolCallAudit.findFirst({
    where: { userId, toolName: TOOL }, orderBy: { createdAt: "desc" },
  });

  // ── A ──
  await section("A) tools/list: beta sees get_preview_frame, non-beta does not; schema is agent-neutral", async () => {
    const betaTools = await listTools(tester.token);
    check("beta tools/list includes get_preview_frame", betaTools.some((tool) => tool.name === TOOL));
    const outsiderNames = (await listTools(outsider.token)).map((tool) => tool.name);
    check("non-beta tools/list hides get_preview_frame", !outsiderNames.includes(TOOL));
    const problems = verifyAgentNeutralSchemas(betaTools, [TOOL]);
    check("G13: emitted schema is agent-neutral (flat jobId + atMs)", problems.length === 0, problems.join("; "));
    const schema = betaTools.find((tool) => tool.name === TOOL)?.inputSchema as { properties?: Json; required?: string[] } | undefined;
    check("schema: jobId + atMs, both required",
      !!schema?.properties?.jobId && !!schema?.properties?.atMs
        && (schema.required ?? []).includes("jobId") && (schema.required ?? []).includes("atMs"), JSON.stringify(schema));
    check("server instructions tell agents about get_preview_frame", SERVER_INSTRUCTIONS.includes(TOOL));
  });

  // ── B ──
  await section("B) non-beta: a direct call is refused with feature_not_enabled, audited denied, nothing rendered", async () => {
    const reply = await callTool(outsider.token, TOOL, { jobId: "any", atMs: 0 });
    check("feature_not_enabled envelope", reply.error === "feature_not_enabled" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    check("the refusal is audited as denied", (await lastAudit(outsider.user.id))?.status === "denied");
    check("no rate-limit slot spent", rateUsed(outsider.user.id) === 0);
  });

  const root = await heldRootVia(tester, "preview-held-1");

  // ── C ──
  await section("C) auth/ownership exactly like get_edit_state; atMs validated; refusals spend no quota", async () => {
    const unknown = await callTool(tester.token, TOOL, { jobId: "no-such-job", atMs: 0 });
    check("unknown jobId → invalid_input (G14)", unknown.error === "invalid_input" && checkFailureEnvelope(unknown).length === 0, JSON.stringify(unknown));
    const foreign = await callTool(otherTester.token, TOOL, { jobId: root.id, atMs: 0 });
    const foreignState = await callTool(otherTester.token, "get_edit_state", { jobId: root.id });
    check("another beta user's held job → same refusal as get_edit_state",
      foreign.error === "invalid_input" && foreign.message === foreignState.message, `${JSON.stringify(foreign)} vs ${JSON.stringify(foreignState)}`);
    const blank = await callTool(tester.token, TOOL, { jobId: "   ", atMs: 0 });
    check("blank jobId → invalid_input", blank.error === "invalid_input");
    for (const atMs of [-1, 4_000, 999_999_999]) {
      const reply = await callTool(tester.token, TOOL, { jobId: root.id, atMs });
      check(`atMs ${atMs} → invalid_input naming the valid range`,
        reply.error === "invalid_input" && checkFailureEnvelope(reply).length === 0 && String(reply.message).includes("3999"),
        JSON.stringify(reply));
    }
    check("no rate-limit slot spent by any refusal", rateUsed(tester.user.id) === 0 && rateUsed(otherTester.user.id) === 0);
    check("nothing fetched from the media base yet", mediaHits.length === 0, mediaHits.join(","));
  });

  // ── C2 ──
  await section("C2) kill switch: MCP_PREVIEW_FRAME_DISABLED=1 refuses first, in Thai, with no work done", async () => {
    process.env.MCP_PREVIEW_FRAME_DISABLED = "1";
    try {
      const reply = await callTool(tester.token, TOOL, { jobId: root.id, atMs: 1_000 });
      check("own held job → preview_disabled (G14)",
        reply.error === "preview_disabled" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
      check("Thai message says the preview is switched off for now", String(reply.message).includes("ปิดชั่วคราว"), JSON.stringify(reply));
      // Checked before the job lookup: an unknown jobId gets the same answer, not invalid_input.
      const unknown = await callTool(tester.token, TOOL, { jobId: "no-such-job", atMs: 0 });
      check("checked first: an unknown jobId also → preview_disabled", unknown.error === "preview_disabled", JSON.stringify(unknown));
      check("no rate-limit slot spent", rateUsed(tester.user.id) === 0);
      check("nothing fetched from the media base", mediaHits.length === 0, mediaHits.join(","));
      check("no bundle built", !existsSync(join(previewStill.ownPreviewBundleDir(), "index.html")));
    } finally {
      delete process.env.MCP_PREVIEW_FRAME_DISABLED;
    }
    const other = await callTool(tester.token, TOOL, { jobId: "no-such-job", atMs: 0 });
    check("any other value leaves the tool on", other.error === "invalid_input", JSON.stringify(other));
  });

  // Draft edits the frame must show: a headline (0–3 s, the shortest allowed) and new text on card 1.
  const hook = await callTool(tester.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: "พาดหัวทดสอบ", durationMs: 3_000 });
  if (hook.error) throw new Error(`fixture: set_headline_hook refused: ${JSON.stringify(hook)}`);
  const NEW_TEXT = "ข้อความใหม่จากเอเจนต์";
  const edited = await callTool(tester.token, "set_caption_text", { jobId: root.id, index: 1, text: NEW_TEXT });
  if (edited.error) throw new Error(`fixture: set_caption_text refused: ${JSON.stringify(edited)}`);
  const tmpBefore = listTmp();

  // ── D ──
  let firstLatency: Json | null = null;
  await section("D) cold bundle: first call answers warming_up (no quota), the next one renders the draft (headline)", async () => {
    runtime.bundleWaitMs = 0;
    const warming = await callTool(tester.token, TOOL, { jobId: root.id, atMs: 1_000 });
    check("cold cache → preview_warming_up (G14)", warming.error === "preview_warming_up" && checkFailureEnvelope(warming).length === 0, JSON.stringify(warming));
    check("warming_up spends no rate-limit slot", rateUsed(tester.user.id) === 0);
    runtime.bundleWaitMs = 600_000;

    const started = Date.now();
    const still = await preview(tester.token, { jobId: root.id, atMs: 1_000 });
    const wallMs = Date.now() - started;
    check("reply = one image block + one text block", !!still.image && still.image.mimeType === "image/jpeg" && !!still.jpeg, JSON.stringify(still.body));
    if (!still.jpeg) return;
    const meta = await sharp(still.jpeg).metadata();
    check("JPEG 540x960", meta.format === "jpeg" && meta.width === 540 && meta.height === 960, `${meta.format} ${meta.width}x${meta.height}`);
    check("JPEG under 200 KB", still.jpeg.length < 200_000, `${still.jpeg.length} bytes`);
    const center = await pixel(still.jpeg, 270, 640);
    check("path A: the frame shows the held preview's base render (green)", isGreen(center), JSON.stringify(center));
    const headlineInk = await foreignPixels(still.jpeg, 60, 400, isGreen);
    check("the pending headline is drawn in the top band", headlineInk > 2_000, `${headlineInk} non-green pixels`);
    const body = still.body;
    check("text: jobId / atMs / frame / draftRevision", body.jobId === root.id && body.atMs === 1_000 && body.frame === 30
      && typeof body.draftRevision === "number", JSON.stringify(body));
    check("text: says the headline is in the frame", (body.includes as Json | undefined)?.headline === true, JSON.stringify(body.includes));
    const timing = body.timing as Json | undefined;
    check("text: first-call latency reported (bundle built + render ms)",
      timing?.bundle === "built" && typeof timing.renderMs === "number" && typeof timing.totalMs === "number", JSON.stringify(timing));
    check("text: has next", typeof body.next === "string" && String(body.next).length > 0);
    firstLatency = { ...(timing ?? {}), wallMs };
    console.log(`        first call latency: ${JSON.stringify(firstLatency)}`);
    const audit = await lastAudit(tester.user.id);
    check("audited ok, and the audit row stores no image bytes", audit?.status === "ok" && audit.responseJson === null
      && !(audit.requestJson ?? "").includes("base64"), JSON.stringify(audit));
    check("one rate-limit slot spent", rateUsed(tester.user.id) === 1);
  });

  // ── E ──
  await section("E) warm bundle: the edited caption is in the frame; the bundle is reused", async () => {
    const started = Date.now();
    const still = await preview(tester.token, { jobId: root.id, atMs: 3_200 });
    if (!still.jpeg) { check("rendered", false, JSON.stringify(still.body)); return; }
    check("bundle reused (cached)", (still.body.timing as Json | undefined)?.bundle === "cached", JSON.stringify(still.body.timing));
    console.log(`        warm call latency: ${JSON.stringify({ ...(still.body.timing as Json), wallMs: Date.now() - started })}`);
    const captionInk = await foreignPixels(still.jpeg, 600, 960, isGreen);
    check("caption text drawn in the lower band", captionInk > 2_000, `${captionInk} non-green pixels`);
    const headlineInk = await foreignPixels(still.jpeg, 60, 400, isGreen);
    check("headline gone after its 3 s", headlineInk < 500, `${headlineInk} non-green pixels`);
    const includes = still.body.includes as Json | undefined;
    check("text: names the caption on screen (the draft's new text)", includes?.captionIndex === 1 && includes?.captionText === NEW_TEXT, JSON.stringify(includes));
  });

  // ── F ──
  await section("F) a pending B-roll window in the draft is drawn (path B); a not-ready import is reported, not drawn", async () => {
    const ready = await prisma.mediaImport.create({
      data: {
        userId: tester.user.id, purpose: "broll_video", source: "upload", status: "ready",
        resultSrc: "/api/stocks/preview-red.mp4", durationMs: 4_000, deadlineAt: new Date(Date.now() + 3_600_000),
      },
    });
    const pending = await prisma.mediaImport.create({
      data: {
        userId: tester.user.id, purpose: "broll_video", source: "upload", status: "pending",
        deadlineAt: new Date(Date.now() + 3_600_000),
      },
    });
    const seeded = await draftLib.updatePendingEditDraft(tester.user.id, root, (draft) => {
      draft.windowEdits = [
        { index: 1, src: null, importId: ready.id, replacementKind: "upload" },
        { index: 0, src: null, importId: pending.id, replacementKind: "upload" },
      ];
      return { ok: true, draft };
    });
    check("fixture: window edits seeded into the draft", seeded.ok, JSON.stringify(seeded));

    const inWindow = await preview(tester.token, { jobId: root.id, atMs: 3_300 });
    if (!inWindow.jpeg) { check("rendered", false, JSON.stringify(inWindow.body)); return; }
    const center = await pixel(inWindow.jpeg, 270, 480);
    check("path B: window #1 shows the replacement (red), not the base render", isRed(center), JSON.stringify(center));
    const includes = inWindow.body.includes as Json | undefined;
    check("text: names the pending window", includes?.pendingWindowIndex === 1, JSON.stringify(includes));
    const captionInk = await foreignPixels(inWindow.jpeg, 600, 960, isRed);
    check("path B keeps the draft caption on top of the new B-roll", captionInk > 2_000, `${captionInk} non-red pixels`);

    const notReady = await preview(tester.token, { jobId: root.id, atMs: 1_000 });
    if (!notReady.jpeg) { check("rendered", false, JSON.stringify(notReady.body)); return; }
    check("a window whose import is still pending falls back to the base render (green)", isGreen(await pixel(notReady.jpeg, 270, 640)));
    const notes = (notReady.body.notes ?? []) as string[];
    check("…and says so in the text", notes.some((note) => note.includes("#0")), JSON.stringify(notes));
    check("never fetched anything outside our own media paths", mediaHits.every((hit) => hit.startsWith("/api/")), mediaHits.join(","));
    const seededRevision = seeded.ok ? seeded.state.revision : -1;
    const revisionNow = (await prisma.editorProject.findUniqueOrThrow({ where: { id: root.projectId! } })).pendingEditRevision;
    check("previewing is read-only (draft revision unchanged)", revisionNow === seededRevision, `${revisionNow} vs ${seededRevision}`);
    await draftLib.updatePendingEditDraft(tester.user.id, root, (draft) => { draft.windowEdits = []; return { ok: true, draft }; });
  });

  // ── F2 ──
  await section("F2) the draft's logo is drawn from the caller's own brand asset; a missing one is reported", async () => {
    const userDir = join(process.env.BRAND_ASSET_ROOT!, tester.user.id);
    mkdirSync(userDir, { recursive: true });
    await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .png().toFile(join(userDir, "logo.png"));
    const asset = await prisma.brandAsset.create({
      data: {
        userId: tester.user.id, storageKey: `${tester.user.id}/logo.png`, originalName: "logo.png",
        mimeType: "image/png", sizeBytes: 100, width: 200, height: 200,
      },
    });
    const setLogo = (assetId: string | null) => draftLib.updatePendingEditDraft(tester.user.id, root, (draft) => {
      if (assetId) draft.logoOverlay = { enabled: true, assetId, position: "center", sizePct: 35, opacity: 1 };
      else delete draft.logoOverlay;
      return { ok: true, draft };
    });
    check("fixture: logo set on the draft", (await setLogo(asset.id)).ok);
    const withLogo = await preview(tester.token, { jobId: root.id, atMs: 3_200 });
    if (!withLogo.jpeg) { check("rendered", false, JSON.stringify(withLogo.body)); return; }
    const center = await pixel(withLogo.jpeg, 270, 480);
    check("the logo (white) is drawn at the centre", center.r > 200 && center.g > 200 && center.b > 200, JSON.stringify(center));
    check("text: logo in the frame", (withLogo.body.includes as Json | undefined)?.logo === true, JSON.stringify(withLogo.body.includes));

    check("fixture: logo pointed at an asset that does not exist", (await setLogo("no-such-asset")).ok);
    const missing = await preview(tester.token, { jobId: root.id, atMs: 3_200 });
    if (!missing.jpeg) { check("rendered", false, JSON.stringify(missing.body)); return; }
    check("a missing logo is left out (base render at the centre)", isGreen(await pixel(missing.jpeg, 270, 480)));
    check("…reported in includes + notes", (missing.body.includes as Json | undefined)?.logo === false
      && ((missing.body.notes ?? []) as string[]).some((note) => note.includes("โลโก้")), JSON.stringify(missing.body));
    await setLogo(null);
  });

  async function planProps(atMs: number): Promise<Json | null> {
    const held = await editTools.resolveHeldRoot(tester.user.id, root.id);
    if (!held.ok) return null;
    const loaded = await editTools.loadState(tester.user.id, held.root);
    if (!loaded.ok) return null;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: tester.user.id } });
    const burn = draftLib.toBurnConfig(loaded.state.draft, loaded.state.base);
    const plan = await previewFrame.planStill(user, held.root, loaded.state, burn, atMs, []);
    return "error" in plan ? null : (plan.inputProps as Json);
  }

  // ── F3 ──
  await section("F3) a pending tail hold (set_tail_hold) is in the still: the last frame is held, as the export holds it", async () => {
    const held = await callTool(tester.token, "set_tail_hold", { jobId: root.id, tailHoldMs: 1_000 });
    check("fixture: set_tail_hold 1000 accepted", !held.error, JSON.stringify(held));
    const still = await preview(tester.token, { jobId: root.id, atMs: 4_500 });
    if (!still.jpeg) { check("rendered inside the hold", false, JSON.stringify(still.body)); }
    else {
      check("frame 135 is inside the hold (atMs range grew by the hold)", still.body.frame === 135, JSON.stringify(still.body));
      check("the held frame is the base's last frame (green), not black", isGreen(await pixel(still.jpeg, 270, 480)), JSON.stringify(await pixel(still.jpeg, 270, 480)));
    }
    // Remotion clamps a past-the-end OffthreadVideo to its last frame, so pixels cannot tell a
    // Freeze from no Freeze on a solid fixture: the plan itself must carry the export's prop.
    const props = await planProps(4_500);
    check("path A carries the export's tailHoldFrames (30)", props?.tailHoldFrames === 30, JSON.stringify(props?.tailHoldFrames));
    const reset = await callTool(tester.token, "set_tail_hold", { jobId: root.id, tailHoldMs: 0 });
    check("fixture: tail hold back to 0", !reset.error, JSON.stringify(reset));
    check("no hold → no tailHoldFrames prop (today's burn, unchanged)", (await planProps(500))?.tailHoldFrames === undefined);
  });

  // ── F4 ──
  await section("F4) the draft's headline anchor and B-roll style (fit / transition) are in the still", async () => {
    const isYellow = (p: { r: number; g: number; b: number }) => p.r > 140 && p.g > 140 && p.b < 90;
    // Headline anchored to the bottom: nothing in the top band any more.
    const bottom = await callTool(tester.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: "พาดหัวทดสอบ", durationMs: 3_000, anchor: "bottom", offsetPercent: 30 });
    check("fixture: headline anchored bottom", !bottom.error, JSON.stringify(bottom));
    const anchored = await preview(tester.token, { jobId: root.id, atMs: 1_000 });
    if (!anchored.jpeg) check("rendered (anchored headline)", false, JSON.stringify(anchored.body));
    else {
      check("headline anchored bottom → the top band is empty", await foreignPixels(anchored.jpeg, 60, 400, isGreen) < 500);
      check("…and it is drawn lower down", await foreignPixels(anchored.jpeg, 400, 960, isGreen) > 2_000);
      check("text: headline in the frame", (anchored.body.includes as Json | undefined)?.headline === true, JSON.stringify(anchored.body.includes));
    }
    check("plan carries the anchor", ((await planProps(1_000))?.headlineHook as Json | undefined)?.anchor === "bottom");
    const top = await callTool(tester.token, "set_headline_hook", { jobId: root.id, enabled: true, headline: "พาดหัวทดสอบ", durationMs: 3_000, anchor: "top", offsetPercent: 12 });
    check("fixture: headline back to the top", !top.error, JSON.stringify(top));

    // A style-only window edit (no new media) is a pending re-render too: drawn through path B.
    const fit = await callTool(tester.token, "set_broll_style", { jobId: root.id, windowIndex: 1, fit: "contain", transition: "cut" });
    check("fixture: set_broll_style window 1 contain + cut", !fit.error, JSON.stringify(fit));
    const styled = await preview(tester.token, { jobId: root.id, atMs: 3_300 });
    if (!styled.jpeg) check("rendered (styled window)", false, JSON.stringify(styled.body));
    else {
      check("style-only window → path B shows window #1's own stock (yellow), not the base render",
        isYellow(await pixel(styled.jpeg, 270, 480)), JSON.stringify(await pixel(styled.jpeg, 270, 480)));
      check("text: names the pending window", (styled.body.includes as Json | undefined)?.pendingWindowIndex === 1, JSON.stringify(styled.body.includes));
    }
    const styledProps = await planProps(3_300);
    const window1 = ((styledProps?.bgVideos ?? []) as Json[]).find((video) => video.sourceIndex === 1 || video.windowIndex === 1) ?? ((styledProps?.bgVideos ?? []) as Json[])[1];
    check("plan: window #1 carries fit contain + cut", window1?.fit === "contain" && window1?.transition === "cut", JSON.stringify(window1));

    // Project-wide transition: carried into path B; on path A the still says it cannot show it.
    const project = await callTool(tester.token, "set_broll_style", { jobId: root.id, transition: "cut" });
    check("fixture: project transition cut", !project.error, JSON.stringify(project));
    check("plan (path B): the draft's project transition is applied", (await planProps(3_300))?.brollTransition === "cut");
    check("plan (path B): the still waits for the webfonts (awaitWebfonts)", (await planProps(3_300))?.awaitWebfonts === true);
    const notes: string[] = [];
    const held = await editTools.resolveHeldRoot(tester.user.id, root.id);
    if (held.ok) {
      const loaded = await editTools.loadState(tester.user.id, held.root);
      if (loaded.ok) {
        const user = await prisma.user.findUniqueOrThrow({ where: { id: tester.user.id } });
        await previewFrame.planStill(user, held.root, loaded.state, draftLib.toBurnConfig(loaded.state.draft, loaded.state.base), 500, notes);
      }
    }
    check("path A: a pending project transition is named in notes", notes.some((note) => note.includes("transition")), JSON.stringify(notes));
    await draftLib.updatePendingEditDraft(tester.user.id, root, (draft) => {
      draft.windowEdits = [];
      delete draft.brollTransition;
      return { ok: true, draft };
    });
  });

  // ── F5 ──
  // A still is always the FIRST frame of a fresh browser, so it shoots before the Google Fonts
  // sheet arrives unless the composition holds the frame for it. Only the still asks for that
  // hold (awaitWebfonts); exports keep exactly the props they had.
  await section("F5) only the still waits for the webfonts: the plan sets awaitWebfonts, the export's props never do", async () => {
    check("plan (path A): awaitWebfonts true", (await planProps(1_000))?.awaitWebfonts === true);
    const held = await editTools.resolveHeldRoot(tester.user.id, root.id);
    const loaded = held.ok ? await editTools.loadState(tester.user.id, held.root) : null;
    const burn = loaded?.ok ? (draftLib.toBurnConfig(loaded.state.draft, loaded.state.base) as unknown as Json) : null;
    check("export burn config (toBurnConfig) has no awaitWebfonts", !!burn && !("awaitWebfonts" in burn), JSON.stringify(burn && Object.keys(burn)));
    // Source scan: the prop is SET only by the preview tool; the render route, the render worker
    // and the export path never mention it.
    const mentions: string[] = [];
    const setters: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = readFileSync(full, "utf8");
        const rel = full.slice(ROOT.length + 1);
        if (text.includes("awaitWebfonts")) mentions.push(rel);
        if (/awaitWebfonts:\s*true/.test(text)) setters.push(rel);
      }
    };
    walk(join(ROOT, "src"));
    check("only the preview tool sets awaitWebfonts: true", setters.join(",") === "src/lib/mcp/preview-frame.ts", setters.join(","));
    const allowed = new Set([
      "src/lib/mcp/preview-frame.ts",
      "src/lib/render/preview-still.ts",
      "src/remotion/types.ts",
      "src/remotion/webfont-gate.ts",
      "src/remotion/SubtitleOverlayComposition.tsx",
      "src/remotion/ShortVideoComposition.tsx",
    ]);
    const stray = mentions.filter((rel) => !allowed.has(rel));
    check("no export path (render route, worker, burn config) mentions awaitWebfonts", stray.length === 0, stray.join(","));
    check("both compositions read the prop", mentions.includes("src/remotion/SubtitleOverlayComposition.tsx") && mentions.includes("src/remotion/ShortVideoComposition.tsx"), mentions.join(","));
  });

  // ── G ──
  await section("G) the render worker's published bundle is preferred; a stale or broken pointer is ignored", async () => {
    const fingerprint = pointer.remotionSourceFingerprint();
    const ownBundle = previewStill.ownPreviewBundleDir();
    check("fixture: own bundle exists", existsSync(join(ownBundle, "index.html")));
    pointer.publishRenderWorkerBundle(ownBundle, fingerprint, runtime.cacheRoot);
    check("lib: a matching pointer resolves", pointer.readRenderWorkerBundle(fingerprint, runtime.cacheRoot) === ownBundle);
    check("lib: a pointer for other sources is ignored", pointer.readRenderWorkerBundle(`${fingerprint}|changed`, runtime.cacheRoot) === null);
    const empty = mkdtempSync(join(dir, "no-index-"));
    pointer.publishRenderWorkerBundle(empty, fingerprint, runtime.cacheRoot);
    check("lib: a pointer to a bundle without index.html is ignored", pointer.readRenderWorkerBundle(fingerprint, runtime.cacheRoot) === null);
    pointer.publishRenderWorkerBundle(null, fingerprint, runtime.cacheRoot);
    check("lib: publishing null never throws and leaves the last pointer", true);
    pointer.publishRenderWorkerBundle(ownBundle, fingerprint, runtime.cacheRoot);

    previewStill.resetPreviewStillForTests();
    const still = await preview(tester.token, { jobId: root.id, atMs: 500 });
    check("route: a fresh process uses the worker's bundle (no build)", (still.body.timing as Json | undefined)?.bundle === "render-worker", JSON.stringify(still.body.timing));
    const workerSource = readFileSync(join(ROOT, "scripts/render-worker.ts"), "utf8");
    check("render-worker publishes its bundle when it caches one",
      /publishRenderWorkerBundle\(\s*location\s*,\s*mtime\s*\)/.test(workerSource));
  });

  // ── H ──
  await section("H) per-user rate limit: 20 per 10 minutes, Thai refusal with retryAfterSec", async () => {
    previewFrame.resetPreviewFrameRateForTests();
    const t0 = Date.now();
    for (let i = 0; i < previewFrame.PREVIEW_FRAME_RATE_LIMIT; i++) previewFrame.tryConsumePreviewFrameRate(tester.user.id, t0);
    const reply = await callTool(tester.token, TOOL, { jobId: root.id, atMs: 500 });
    check("21st call in the window → rate_limited (G14)", reply.error === "rate_limited" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    check("retryAfterSec is a positive whole number", Number.isInteger(reply.retryAfterSec) && Number(reply.retryAfterSec) > 0, JSON.stringify(reply));
    check("the limit is per user: another beta user is not limited",
      previewFrame.tryConsumePreviewFrameRate(otherTester.user.id, t0).ok);
    check("lib: the window slides (a slot frees after 10 minutes)",
      previewFrame.tryConsumePreviewFrameRate(tester.user.id, t0 + previewFrame.PREVIEW_FRAME_RATE_WINDOW_MS + 1).ok);
    previewFrame.resetPreviewFrameRateForTests();
  });

  // ── I ──
  await section("I) global concurrency 1 + a one-deep queue: fail fast in Thai, never pile up", async () => {
    const holder = await previewStill.acquirePreviewSlot(0);
    check("fixture: took the only render slot", typeof holder === "function");
    // 1) slot busy, queue free: the call waits its turn, then gives up with preview_busy.
    runtime.queueWaitMs = 300;
    const started = Date.now();
    const waited = await callTool(tester.token, TOOL, { jobId: root.id, atMs: 500 });
    check("busy slot → preview_busy after the short wait (G14)", waited.error === "preview_busy" && checkFailureEnvelope(waited).length === 0, JSON.stringify(waited));
    check("…within ~the queue wait, not a render's worth", Date.now() - started < 5_000, `${Date.now() - started} ms`);
    // 2) slot busy AND the one queue place taken: refused immediately.
    runtime.queueWaitMs = 60_000;
    const queued = previewStill.acquirePreviewSlot(60_000);
    const fastStart = Date.now();
    const refused = await callTool(tester.token, TOOL, { jobId: root.id, atMs: 500 });
    const fastMs = Date.now() - fastStart;
    check("queue full → preview_busy immediately", refused.error === "preview_busy" && fastMs < 1_500, `${JSON.stringify(refused)} in ${fastMs} ms`);
    check("busy refusals spend no rate-limit slot", rateUsed(tester.user.id) === 0);
    holder!();
    const next = await queued;
    check("the queued waiter gets the slot when it frees", typeof next === "function");
    // 3) a waiting call proceeds once the slot frees.
    const pendingCall = preview(tester.token, { jobId: root.id, atMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    next!();
    const still = await pendingCall;
    check("a call queued behind a render runs when the slot frees", !!still.jpeg, JSON.stringify(still.body));
    const after = await previewStill.acquirePreviewSlot(0);
    check("the slot is free again afterwards", typeof after === "function");
    after?.();
  });

  // ── J ──
  await section("J) timeout: a render past the deadline answers preview_timeout and frees the slot", async () => {
    runtime.timeoutMs = 1;
    const reply = await callTool(tester.token, TOOL, { jobId: root.id, atMs: 500 });
    runtime.timeoutMs = 120_000;
    check("preview_timeout (G14)", reply.error === "preview_timeout" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    check("default deadline is 30 s", previewStill.PREVIEW_STILL_TIMEOUT_MS === 30_000);
    const deadline = Date.now() + 15_000;
    let slot: (() => void) | null = null;
    while (!slot && Date.now() < deadline) {
      slot = await previewStill.acquirePreviewSlot(500);
    }
    check("slot released after the timed-out render settles", typeof slot === "function");
    slot?.();
  });

  // ── K ──
  await section("K) no disk leftovers: TMPDIR holds exactly what it held before the renders", async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tmpAfter = listTmp();
    const added = tmpAfter.filter((name) => !tmpBefore.includes(name));
    // Chrome's own per-launch entries (Linux: `com.google.Chrome.XXXXXX`, a socket dir, and
    // `com.google.Chrome.chrome_chrome_url_fetcher_.XXXXXX`) survive because Remotion stops Chrome
    // with SIGKILL — exactly as after every render-worker render today. They are tiny and not
    // ours to name or delete; anything else would be a real leftover.
    const chromeOwn = /^\.?(com\.google\.Chrome|org\.chromium\.Chromium)\.[A-Za-z0-9_.]+$/;
    const ours = added.filter((name) => !chromeOwn.test(name));
    check("no new entries in TMPDIR (browser profiles, frame dirs, downloads all removed)", ours.length === 0, ours.join(", "));
    const chromeBytes = added.filter((name) => chromeOwn.test(name)).reduce((sum, name) => sum + treeBytes(join(privateTmp, name)), 0);
    check("Chrome's own per-launch temp entries (Linux only) are tiny", chromeBytes < 256 * 1024, `${added.length - ours.length} entries, ${chromeBytes} bytes`);
    if (added.length > ours.length) console.log(`        note: ${added.length - ours.length} Chrome-owned temp entries (${chromeBytes} bytes), as after any Remotion render`);
    const cacheEntries = existsSync(runtime.cacheRoot) ? readdirSync(runtime.cacheRoot).sort() : [];
    check("the bundle cache holds one bundle + its pointer, nothing per call",
      cacheEntries.every((name) => ["bundle", "render-worker-bundle.json"].includes(name)), cacheEntries.join(", "));
  });

  server.close();
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (firstLatency) console.log(`first-call latency (local): ${JSON.stringify(firstLatency)}`);
  rmSync(privateTmp, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
