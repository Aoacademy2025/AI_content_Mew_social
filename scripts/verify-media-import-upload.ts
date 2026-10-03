// Task 11 (PR-B, docs/plans/2026-10-03-mcp-edit-before-export.md, G25/G26/G27, ADR 0065):
// the Media Import upload link — `create_upload_url` + `PUT /api/mcp-uploads/<token>` — and
// the DB admission caps behind it.
//
// Covers, against a throwaway SQLite file:
//   A. wiring: proxy matcher skips /api/mcp-uploads/ (compiled with Next's own matcher code),
//      explicit public-route entry, nginx locations (every response path — maintenance 503,
//      nginx's own errors, plain http — logged redacted, never redirected), Sentry redaction
//      (errors AND transactions), route.ts registers the tool.
//   B. create_upload_url: gated (beta only, listed + agent-neutral), reply shape, 15-min expiry,
//      only the SHA-256 of the token persisted (raw token absent from every DB byte), the link
//      is always https on the configured origin (fix round 1, S3).
//   C. PUT: single-use (sequential and racing), 15-minute expiry, bound to its user and kind,
//      over-cap aborted (Content-Length and mid-stream), empty body, identical refusal for
//      unknown / malformed / used / expired links, admission re-checked with the link kept;
//      fix round 1: global staged-bytes budget + free-disk floor (S1), rows past their
//      deadline hold no slot (R-A4), DB unavailable before staging → 503 envelope (R-A1).
//   D. admission caps across TWO real processes on one SQLite file (3 active, 30/hour,
//      10 links/hour): exactly the cap is admitted, never more.
//   E. IDOR (G27): missing, foreign and wrong-purpose ids get one identical `invalid_input`.
//   F. the staged file is handed to T9's pipelines (real ffmpeg/ffprobe).
//
// Needs real ffmpeg + ffprobe (runs in CI's G24 step, which installs them).
// Run: node --conditions=react-server --import tsx scripts/verify-media-import-upload.ts
import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHILD_FLAG = "--admission-child";
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const MINUTE = 60_000;

/** Minimal nginx config parser: blocks with their header, own directives and children. */
type NginxBlock = { header: string; directives: string[]; children: NginxBlock[] };
function parseNginx(source: string): NginxBlock {
  const root: NginxBlock = { header: "", directives: [], children: [] };
  const stack = [root];
  let buffer = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      buffer += ch;
      if (ch === "\\") { buffer += source[i + 1] ?? ""; i += 1; } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buffer += ch; continue; }
    if (ch === "#") { while (i < source.length && source[i] !== "\n") i += 1; buffer += " "; continue; }
    if (ch === "{") {
      const block: NginxBlock = { header: buffer.trim().replace(/\s+/g, " "), directives: [], children: [] };
      stack[stack.length - 1].children.push(block);
      stack.push(block);
      buffer = "";
    } else if (ch === "}") {
      stack.pop();
      buffer = "";
    } else if (ch === ";") {
      const directive = buffer.trim().replace(/\s+/g, " ");
      if (directive) stack[stack.length - 1].directives.push(directive);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return root;
}
/** A block's directives including those of its nested `if` blocks. */
function allDirectives(block: NginxBlock): string[] {
  return [...block.directives, ...block.children.flatMap(allDirectives)];
}

// ── child mode: one "process" racing for admission ─────────────────────────────────────────

type ChildSpec =
  | { op: "issue"; userId: string; kind: "image" | "video" | "presenter"; attempts: number; goFile: string }
  | { op: "admit"; tokens: string[]; goFile: string };

async function runChild(): Promise<void> {
  const spec = JSON.parse(process.argv[3] ?? "{}") as ChildSpec;
  const lib = await import("../src/lib/media-import/imports");
  const { prisma } = await import("../src/lib/prisma");
  await prisma.$queryRawUnsafe("SELECT 1"); // connect before the barrier
  fs.writeFileSync(`${spec.goFile}.ready-${process.pid}`, "ready");
  while (!fs.existsSync(spec.goFile)) await new Promise((resolve) => setTimeout(resolve, 2));
  const results: Array<{ ok: boolean; code?: string }> = [];
  if (spec.op === "issue") {
    const out = await Promise.all(
      Array.from({ length: spec.attempts }, () => lib.issueUploadToken(spec.userId, spec.kind)),
    );
    for (const r of out) results.push(r.ok ? { ok: true } : { ok: false, code: r.code });
  } else {
    const out = await Promise.all(spec.tokens.map(async (raw) => {
      const row = await lib.findUsableUploadToken(raw);
      if (!row) return { ok: false, code: "upload_link_invalid" };
      const admitted = await lib.admitUpload(row);
      return admitted.ok ? { ok: true } : { ok: false, code: admitted.code };
    }));
    results.push(...out);
  }
  process.stdout.write(`RESULT ${JSON.stringify(results)}\n`);
  await prisma.$disconnect();
}

function runChildren(specs: ChildSpec[], goFile: string): Promise<Array<Array<{ ok: boolean; code?: string }>>> {
  const children = specs.map((spec) => new Promise<Array<{ ok: boolean; code?: string }>>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", __filename, CHILD_FLAG, JSON.stringify(spec)],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("exit", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (code !== 0 || !line) return reject(new Error(`child exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line.slice("RESULT ".length)));
    });
  }));
  // Every child loads + connects first, then all start on the same signal.
  const dir = path.dirname(goFile);
  const readyPrefix = `${path.basename(goFile)}.ready-`;
  const barrier = setInterval(() => {
    if (fs.readdirSync(dir).filter((name) => name.startsWith(readyPrefix)).length >= specs.length) {
      clearInterval(barrier);
      fs.writeFileSync(goFile, "go");
    }
  }, 5);
  return Promise.all(children).finally(() => clearInterval(barrier));
}

// ── parent ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-import-upload-"));
  const dbPath = path.join(tmp, "media-import-upload.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  for (const key of ["MCP_EDITOR_PROJECT_PUBLIC", "INTERNAL_AI_ALLOWED_EMAILS", "INTERNAL_AI_ALLOWED_DOMAINS"]) {
    delete process.env[key];
  }
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const lib = await import("../src/lib/media-import/imports");
  const staging = await import("../src/lib/media-import/upload-staging");
  const tools = await import("../src/lib/mcp/media-import-tools");
  const route = await import("../src/app/api/mcp-uploads/[token]/route");
  const { prisma } = await import("../src/lib/prisma");
  const { getFfmpegPath } = await import("../src/lib/ffmpeg-path");

  const now = new Date();
  async function makeUser(id: string, email: string, plan: "PRO" | "FREE" = "PRO") {
    await prisma.user.create({
      data: {
        id, name: id, email, plan,
        minutesLimit: 80, minutesUsed: 0, usagePeriodStartedAt: now, trialEndsAt: null,
        usageLimit: 100, usageCount: 0,
        ...(plan === "PRO"
          ? { subStatus: "active", stripeSubscriptionId: `sub_${id}`, planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * MINUTE) }
          : {}),
      },
    });
    if (plan === "PRO") {
      await prisma.payment.create({
        data: { userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900, status: "PAID", periodDays: 30, paidAt: now },
      });
    }
    return prisma.user.findUniqueOrThrow({ where: { id } });
  }

  // Fixtures (real media, tiny).
  const ff = (args: string[]) => execFileSync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const pngPath = path.join(tmp, "still.png");
  const portraitPath = path.join(tmp, "portrait.mp4");
  const landscapePath = path.join(tmp, "landscape.mp4");
  ff(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", pngPath]);
  ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", portraitPath]);
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", landscapePath]);
  const png = fs.readFileSync(pngPath);
  const portrait = fs.readFileSync(portraitPath);
  const landscape = fs.readFileSync(landscapePath);

  type PutResult = { status: number; body: Record<string, unknown>; cacheControl?: string | null };
  async function put(token: string, body: BodyInit | null, headers: Record<string, string> = {}): Promise<PutResult> {
    const request = new Request(`https://studio.test/api/mcp-uploads/${encodeURIComponent(token)}`, {
      method: "PUT",
      body,
      headers,
      // @ts-expect-error -- Node's fetch Request needs duplex for a streamed body
      duplex: "half",
    });
    const response = await route.PUT(request, { params: Promise.resolve({ token }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function putWithHeaders(token: string, body: BodyInit | null, headers: Record<string, string> = {}): Promise<PutResult> {
    const request = new Request(`https://studio.test/api/mcp-uploads/${encodeURIComponent(token)}`, {
      method: "PUT",
      body,
      headers,
      // @ts-expect-error -- Node's fetch Request needs duplex for a streamed body
      duplex: "half",
    });
    const response = await route.PUT(request, { params: Promise.resolve({ token }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, cacheControl: response.headers.get("cache-control") };
  }
  // Each section starts with no links and no imports, so the hourly caps never leak between them.
  async function reset() {
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
  }
  async function issue(userId: string, kind: "image" | "video" | "presenter") {
    const issued = await lib.issueUploadToken(userId, kind);
    if (!issued.ok) throw new Error(`fixture: issue refused ${issued.code}`);
    return issued;
  }

  const owner = await makeUser("u-owner", "qa-upload-owner@aoacademy.co");
  const other = await makeUser("u-other", "qa-upload-other@aoacademy.co");
  const outsider = await makeUser("u-outsider", "outsider@example.com");
  const downgraded = await makeUser("u-free", "qa-upload-free@aoacademy.co", "FREE");

  // ── A. wiring ────────────────────────────────────────────────────────────────────────────
  await section("A1) proxy matcher: /api/mcp-uploads/ never runs the proxy (no body clone), everything else still does", async () => {
    const proxySource = fs.readFileSync(path.join(ROOT, "src/proxy.ts"), "utf8");
    const matcherBlock = proxySource.match(/matcher:\s*(\[[\s\S]*?\]),\s*\n\s*\};/);
    check("matcher array found in src/proxy.ts", !!matcherBlock);
    const matchers = new Function(`return ${matcherBlock?.[1] ?? "[]"};`)() as string[];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getMiddlewareRouteMatcher } = require("next/dist/shared/lib/router/utils/middleware-route-matcher");
    const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(matchers, { basePath: "" }));
    const runs = (pathname: string) => matches(pathname, { headers: {} }, {});
    check("proxy does NOT run for /api/mcp-uploads/<token>", !runs("/api/mcp-uploads/heroai_up_abcDEF123_-xyz"));
    for (const p of ["/api/mcp", "/api/mcp/sse", "/api/videos/upload-avatar", "/api/internal/story-film-media/presenter-upload", "/dashboard", "/", "/api/mcp-uploadsx"]) {
      check(`proxy still runs for ${p}`, runs(p));
    }
    check("explicit public-route entry for /api/mcp-uploads(.*)", proxySource.includes(`"/api/mcp-uploads(.*)"`));
  });

  await section("A2) nginx: streaming location, 510M, maintenance guard, every response path logged redacted", async () => {
    const nginx = fs.readFileSync(path.join(ROOT, "deploy/nginx.conf"), "utf8");
    const conf = parseNginx(nginx);
    const servers = conf.children.filter((b) => b.header === "server");
    const https = servers.find((b) => b.directives.some((d) => d.startsWith("listen 443")));
    const plain = servers.find((b) => b.directives.some((d) => d === "listen 80"));
    check("both server blocks found", !!https && !!plain);
    const location = https?.children.find((b) => b.header === "location ^~ /api/mcp-uploads/");
    const block = location ? allDirectives(location) : [];
    check("location ^~ /api/mcp-uploads/ exists", !!location);
    check("client_max_body_size 510M", block.includes("client_max_body_size 510M"));
    check("proxy_request_buffering off", block.includes("proxy_request_buffering off"));
    const maintenance = location?.children.find((b) => b.header === "if (-f /var/www/ai-content/.deploy-maintenance)");
    check("maintenance barrier", !!maintenance && maintenance.directives.some((d) => d.startsWith("return 503")));
    check("service-auth headers stripped", block.includes(`proxy_set_header x-heroai-service-secret ""`) && block.includes(`proxy_set_header x-heroai-act-as ""`));
    check("access_log uses the redacted format", block.some((d) => /^access_log \S+ heroai_mcp_upload_redacted$/.test(d)));
    const format = nginx.match(/log_format heroai_mcp_upload_redacted([\s\S]*?);\n/)?.[1] ?? "";
    check("log_format heroai_mcp_upload_redacted is defined before the server blocks",
      format.length > 0 && nginx.indexOf("log_format heroai_mcp_upload_redacted") < nginx.indexOf("server {"));
    const leaksRequest = /\$(request|request_uri|uri|document_uri|args|query_string|http_referer)\b/;
    check("redacted format never logs the request line / URI", format.length > 0 && !leaksRequest.test(format), format);

    // Fix round 1 (S2/R-A2): no response path for an upload URL may end in a location that logs
    // the request line — nginx writes the access log with the FINAL location's settings.
    const upload503 = location?.directives.find((d) => d.startsWith("error_page"));
    check("the location sets its own error_page (drops the server's `error_page 503 /maintenance.html` redirect)",
      upload503 === "error_page 503 @mcp_upload_unavailable", String(upload503));
    const named = https?.children.find((b) => b.header === "location @mcp_upload_unavailable");
    check("named 503 location exists and answers itself (return with a body, so no further redirect)",
      !!named && named.directives.some((d) => /^return 503 '\{.*"code":"maintenance".*\}'$/.test(d)), JSON.stringify(named?.directives));
    const httpLocation = plain?.children.find((b) => b.header === "location ^~ /api/mcp-uploads/");
    check("port 80: upload URLs are refused in place (403 with a body), never redirected to https",
      !!httpLocation && httpLocation.directives.some((d) => /^return 403 '\{.*"code":"https_required".*\}'$/.test(d))
        && !allDirectives(httpLocation).some((d) => d.startsWith("return 30")), JSON.stringify(httpLocation?.directives));
    const uploadBlocks = ([["443", location], ["443", named], ["80", httpLocation]] as const)
      .filter((entry): entry is readonly [string, NginxBlock] => !!entry[1]);
    for (const [port, block] of uploadBlocks) {
      const b = { ...block, header: `port ${port} ${block.header}` };
      const ds = allDirectives(block);
      check(`${b.header}: access_log is the redacted format and nothing else`,
        ds.filter((d) => d.startsWith("access_log")).length > 0 && ds.filter((d) => d.startsWith("access_log")).every((d) => /^access_log \S+ heroai_mcp_upload_redacted$/.test(d)));
      check(`${b.header}: error_log raised to crit (nginx error lines quote the request line)`,
        ds.some((d) => /^error_log \S+ crit$/.test(d)));
      check(`${b.header}: every error_page stays inside a redacted named location`,
        ds.filter((d) => d.startsWith("error_page")).every((d) => / @mcp_upload_\w+$/.test(d)));
      check(`${b.header}: never echoes the request URI`, !ds.some((d) => leaksRequest.test(d)));
    }
  });

  await section("A3) Sentry: the token path segment and the token prefix are redacted (errors + transactions)", async () => {
    const sentry = await import("../src/lib/sentry-config");
    const raw = "heroai_up_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
    const event = sentry.beforeSendSentryEvent({
      event_id: "e1",
      transaction: `PUT /api/mcp-uploads/${raw}`,
      message: `upload failed at https://studio.test/api/mcp-uploads/${raw}`,
      request: { method: "PUT", url: `https://studio.test/api/mcp-uploads/${raw}?x=1` },
      exception: { values: [{ type: "Error", value: `bad token ${raw}` }] },
      tags: { route: `/api/mcp-uploads/${raw}` },
      breadcrumbs: [{ category: "http", level: "error", data: { url: `/api/mcp-uploads/${raw}` } }],
    } as never);
    const serialized = JSON.stringify(event);
    check("error event: no raw token anywhere", !!event && !serialized.includes(raw) && !serialized.includes(raw.slice(10)), serialized);
    check("error event: request.url keeps the route with [Filtered]", event?.request?.url === "https://studio.test/api/mcp-uploads/[Filtered]", String(event?.request?.url));
    const tx = sentry.beforeSendSentryTransaction({
      type: "transaction",
      transaction: `PUT /api/mcp-uploads/${raw}`,
      request: { method: "PUT", url: `http://localhost:3000/api/mcp-uploads/${raw}` },
      spans: [{ description: `PUT /api/mcp-uploads/${raw}`, data: { "http.target": `/api/mcp-uploads/${raw}`, "url.full": `http://x/api/mcp-uploads/${raw}` } }],
      contexts: { trace: { data: { "http.route": `/api/mcp-uploads/${raw}` } } },
    } as never);
    const txSerialized = JSON.stringify(tx);
    check("transaction event: no raw token anywhere", !!tx && !txSerialized.includes(raw) && !txSerialized.includes(raw.slice(10)), txSerialized);
    check("transaction event: name keeps the route", tx?.transaction === "PUT /api/mcp-uploads/[Filtered]", String(tx?.transaction));
    const routeFrame = "app:///_next/server/app/api/mcp-uploads/[token]/route.js";
    const framed = sentry.beforeSendSentryEvent({
      event_id: "e2",
      transaction: "PUT /api/mcp-uploads/[token]",
      exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ filename: routeFrame, abs_path: routeFrame }] } }] },
    } as never);
    check("route name [token] (transaction + stack frame paths) is left intact — idempotent, source maps still resolve",
      framed?.transaction === "PUT /api/mcp-uploads/[token]" && framed?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename === routeFrame,
      JSON.stringify(framed));
    check("scrubbing twice changes nothing", sentry.redactMcpUploadTokens(sentry.redactMcpUploadTokens(`/api/mcp-uploads/${raw}`)) === "/api/mcp-uploads/[Filtered]");
    const crumb = sentry.beforeSentryBreadcrumb({ category: "fetch", level: "error", message: `PUT /api/mcp-uploads/${raw}` });
    check("breadcrumb: redacted", !!crumb && !JSON.stringify(crumb).includes(raw));
    check("sanitizeSentryText: bare token prefix redacted", !sentry.sanitizeSentryText(`token=${raw}`).includes(raw));
    for (const file of ["sentry.server.config.ts", "sentry.edge.config.ts", "src/instrumentation-client.ts"]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      check(`${file} wires beforeSendTransaction`, /beforeSendTransaction:\s*beforeSendSentryTransaction/.test(source));
    }
  });

  await section("A4) route.ts registers the media-import tools; the PUT route never logs the token", async () => {
    const mcpRoute = fs.readFileSync(path.join(ROOT, "src/app/api/[transport]/route.ts"), "utf8");
    check("route.ts calls registerMediaImportTools(server, getRequestPrincipal(), runTool)",
      mcpRoute.includes("registerMediaImportTools(server, getRequestPrincipal(), runTool)"));
    const putSource = fs.readFileSync(path.join(ROOT, "src/app/api/mcp-uploads/[token]/route.ts"), "utf8");
    const logCalls = putSource.match(/console\.(?:log|info|warn|error|debug)\([^;]*;/g) ?? [];
    check("PUT route log lines never include the token, URL or request",
      logCalls.every((line) => !/\btoken\b|\burl\b|req(?:uest)?\b|params/i.test(line.replace(/^console\.\w+\(/, ""))), logCalls.join("\n"));
    check("PUT route runs on nodejs", /export const runtime = "nodejs"/.test(putSource));
  });

  // ── B. create_upload_url ─────────────────────────────────────────────────────────────────
  await section("B1) create_upload_url: beta-gated, agent-neutral schema, reply shape", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { verifyAgentNeutralSchemas, checkFailureEnvelope } = await import("./mcp-agent-neutral-checks");
    // Stand-in for route.ts's runTool (plan guard + audit are covered by the edit-tool harnesses).
    const runnerFor = (principalUser: typeof owner) =>
      async (_name: string, _extra: unknown, fn: (p: { userId: string; user: typeof owner }) => Promise<unknown>) =>
        ({ content: [{ type: "text" as const, text: JSON.stringify(await fn({ userId: principalUser.id, user: principalUser })) }] });
    async function client(principalUser: typeof owner) {
      const server = new McpServer({ name: "heroai", version: "0.0.0" }, { capabilities: { tools: {} } });
      tools.registerMediaImportTools(server, { userId: principalUser.id, user: principalUser }, runnerFor(principalUser) as never);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      return c;
    }
    const beta = await client(owner);
    const listed = (await beta.listTools()).tools;
    check("beta principal: create_upload_url is listed", listed.some((t) => t.name === "create_upload_url"));
    const problems = verifyAgentNeutralSchemas(listed as never, ["create_upload_url"]);
    check("create_upload_url schema is agent-neutral (no oneOf/anyOf/allOf/$ref)", problems.length === 0, problems.join("; "));
    const outsiderClient = await client(outsider);
    const outsiderListed = (await outsiderClient.listTools()).tools;
    check("non-beta principal: create_upload_url is NOT listed", !outsiderListed.some((t) => t.name === "create_upload_url"));
    const gated = await outsiderClient.callTool({ name: "create_upload_url", arguments: { kind: "image" } });
    const gatedBody = JSON.parse((gated.content as Array<{ text: string }>)[0].text);
    check("non-beta direct call gets the G14 feature envelope", checkFailureEnvelope(gatedBody).length === 0 && gatedBody.code === "feature_not_enabled", JSON.stringify(gatedBody));

    const reply = await beta.callTool({ name: "create_upload_url", arguments: { kind: "video" } });
    const body = JSON.parse((reply.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
    const uploadUrl = String(body.uploadUrl ?? "");
    check("reply has uploadId, PUT uploadUrl on the public origin, maxBytes, expiresAt, next",
      typeof body.uploadId === "string" && body.method === "PUT" && uploadUrl.startsWith("https://studio.test/api/mcp-uploads/heroai_up_")
        && body.maxBytes === 200 * 1024 * 1024 && typeof body.expiresAt === "string" && typeof body.next === "string" && /[฀-๿]/u.test(String(body.next)),
      JSON.stringify(body));
    const raw = uploadUrl.split("/").pop() ?? "";
    const tokenRow = await prisma.mcpUploadToken.findUnique({ where: { importId: String(body.uploadId) } });
    check("token row: userId + kind bound, hash stored", tokenRow?.userId === owner.id && tokenRow?.kind === "video" && tokenRow?.tokenHash === sha256(raw));
    check("expiresAt = issuedAt + 15 min", !!tokenRow && new Date(String(body.expiresAt)).getTime() === tokenRow.issuedAt.getTime() + 15 * MINUTE);
    check("token is ≥128-bit random (43 base64url chars after the prefix)", /^heroai_up_[A-Za-z0-9_-]{43}$/.test(raw));
    await prisma.mcpUploadToken.deleteMany({ where: { userId: owner.id } });
  });

  await section("B2) no raw token persisted — not in any column, not in any byte of the DB file", async () => {
    const issued = await issue(owner.id, "image");
    const put1 = await put(issued.token, png, { "content-length": String(png.length) });
    check("upload accepted", put1.status === 202, JSON.stringify(put1));
    const rows = JSON.stringify([
      await prisma.mcpUploadToken.findMany(),
      await prisma.mediaImport.findMany(),
      await prisma.toolCallAudit.findMany(),
    ]);
    check("no column holds the raw token", !rows.includes(issued.token) && !rows.includes(issued.token.slice(10)));
    await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
    const bytes = Buffer.concat([dbPath, `${dbPath}-wal`, `${dbPath}-journal`].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p)));
    check("raw token absent from the SQLite file bytes", !bytes.includes(Buffer.from(issued.token)) && !bytes.includes(Buffer.from(issued.token.slice(10))));
    check("its hash IS stored", bytes.includes(Buffer.from(sha256(issued.token))));
    staging.removeStagedUpload(issued.importId);
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
  });

  await section("B3) the upload link is always https, on the configured origin (fix round 1, S3)", async () => {
    await reset();
    const env = process.env as Record<string, string | undefined>;
    const savedOrigin = env.MCP_PUBLIC_ORIGIN;
    const savedNodeEnv = env.NODE_ENV;
    type Reply = { uploadUrl?: string; code?: string; error?: string; message?: string; next?: string };
    const attempt = async (origin: string, nodeEnv: string) => {
      env.MCP_PUBLIC_ORIGIN = origin;
      env.NODE_ENV = nodeEnv;
      const before = await prisma.mcpUploadToken.count();
      const reply = (await tools.createUploadUrlTool(owner.id, { kind: "image" })) as Reply;
      return { reply, issuedRow: (await prisma.mcpUploadToken.count()) > before };
    };
    try {
      const { checkFailureEnvelope } = await import("./mcp-agent-neutral-checks");
      for (const nodeEnv of ["production", "development"]) {
        const http = await attempt("http://studio.test", nodeEnv);
        check(`${nodeEnv}: an http:// public origin → refused upload_unavailable (G14, Thai), no link issued`,
          http.reply.code === "upload_unavailable" && checkFailureEnvelope(http.reply).length === 0 && /[฀-๿]/u.test(String(http.reply.message)) && !http.issuedRow,
          JSON.stringify(http.reply));
        const odd = await attempt("ftp://studio.test", nodeEnv);
        check(`${nodeEnv}: a non-web origin → refused, no link issued`, odd.reply.code === "upload_unavailable" && !odd.issuedRow, JSON.stringify(odd.reply));
      }
      const prodLoopback = await attempt("http://localhost:3000", "production");
      check("production: even http://localhost is refused", prodLoopback.reply.code === "upload_unavailable" && !prodLoopback.issuedRow, JSON.stringify(prodLoopback.reply));
      const devLoopback = await attempt("http://localhost:3000", "development");
      check("development: http://localhost (never leaves the machine) still works for local testing",
        String(devLoopback.reply.uploadUrl).startsWith("http://localhost:3000/api/mcp-uploads/heroai_up_"), JSON.stringify(devLoopback.reply));
      const secure = await attempt("https://studio.test/some/base/path", "production");
      check("https origin → https link on exactly that origin",
        String(secure.reply.uploadUrl).startsWith("https://studio.test/api/mcp-uploads/heroai_up_"), JSON.stringify(secure.reply));
      const toolSource = fs.readFileSync(path.join(ROOT, "src/lib/mcp/media-import-tools.ts"), "utf8");
      check("the link origin comes from configuration only (no request Host / forwarded headers)",
        !/headers|x-forwarded|\bhost\b/i.test(toolSource.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")));
    } finally {
      env.MCP_PUBLIC_ORIGIN = savedOrigin;
      env.NODE_ENV = savedNodeEnv;
    }
    await reset();
  });

  // ── C. PUT ───────────────────────────────────────────────────────────────────────────────
  await section("C1) happy path: 202, a pending MediaImport for the token's user + kind, staged privately", async () => {
    await reset();
    const issued = await issue(owner.id, "presenter");
    const res = await putWithHeaders(issued.token, portrait, { "content-length": String(portrait.length) });
    check("202 with uploadId = importId and status pending", res.status === 202 && res.body.uploadId === issued.importId && res.body.status === "pending", JSON.stringify(res));
    const row = await prisma.mediaImport.findUnique({ where: { id: issued.importId } });
    check("MediaImport: owner, purpose presenter, source upload, pending, deadline in the future",
      row?.userId === owner.id && row?.purpose === "presenter" && row?.source === "upload" && row?.status === "pending" && row.deadlineAt.getTime() > Date.now(),
      JSON.stringify(row));
    const token = await prisma.mcpUploadToken.findUnique({ where: { importId: issued.importId } });
    check("token consumed (usedAt set)", !!token?.usedAt);
    const stagedPath = staging.stagedUploadPath(issued.importId);
    const stat = fs.existsSync(stagedPath) ? fs.statSync(stagedPath) : null;
    check("staged file holds the exact bytes, mode 0600", !!stat && stat.size === portrait.length && (stat.mode & 0o777) === 0o600 && fs.readFileSync(stagedPath).equals(portrait));
    const dirStat = fs.statSync(staging.mediaImportStagingDir());
    check("staging dir mode 0700", (dirStat.mode & 0o777) === 0o700, (dirStat.mode & 0o777).toString(8));
    check("reply is Cache-Control: no-store", res.cacheControl === "no-store", String(res.cacheControl));

    const again = await put(issued.token, portrait, { "content-length": String(portrait.length) });
    check("single-use: the same link again → 404 upload_link_invalid", again.status === 404 && again.body.code === "upload_link_invalid", JSON.stringify(again));
    check("…and no second import row", (await prisma.mediaImport.count({ where: { userId: owner.id } })) === 1);
    staging.removeStagedUpload(issued.importId);
    await prisma.mediaImport.deleteMany({});
  });

  await section("C2) single-use under a race: two PUTs on one link → exactly one 202", async () => {
    await reset();
    const issued = await issue(owner.id, "image");
    const [a, b] = await Promise.all([put(issued.token, png), put(issued.token, png)]);
    const statuses = [a.status, b.status].sort();
    check("one 202, one 404", statuses[0] === 202 && statuses[1] === 404, JSON.stringify([a, b]));
    check("exactly one MediaImport", (await prisma.mediaImport.count({ where: { userId: owner.id } })) === 1);
    staging.removeStagedUpload(issued.importId);
    await prisma.mediaImport.deleteMany({});
  });

  await section("C3) expiry: 15 minutes after issue the link is dead; just before, it works", async () => {
    await reset();
    const expired = await issue(owner.id, "image");
    await prisma.mcpUploadToken.update({ where: { importId: expired.importId }, data: { issuedAt: new Date(Date.now() - 15 * MINUTE - 1_000) } });
    const res = await put(expired.token, png);
    check("issued 15m01s ago → 404 upload_link_invalid", res.status === 404 && res.body.code === "upload_link_invalid", JSON.stringify(res));
    check("expired link creates no import", (await prisma.mediaImport.count({ where: { id: expired.importId } })) === 0);
    const fresh = await issue(owner.id, "image");
    await prisma.mcpUploadToken.update({ where: { importId: fresh.importId }, data: { issuedAt: new Date(Date.now() - 14 * MINUTE) } });
    const ok = await put(fresh.token, png);
    check("issued 14m ago → accepted", ok.status === 202, JSON.stringify(ok));
    staging.removeStagedUpload(fresh.importId);
    await prisma.mediaImport.deleteMany({});
  });

  await section("C4) no existence leak: unknown, malformed, used and expired links get one identical 404", async () => {
    await reset();
    const used = await issue(owner.id, "image");
    await put(used.token, png);
    const expired = await issue(owner.id, "image");
    await prisma.mcpUploadToken.update({ where: { importId: expired.importId }, data: { issuedAt: new Date(Date.now() - 60 * MINUTE) } });
    const unknown = `heroai_up_${"A".repeat(43)}`;
    const results = [
      await put(unknown, png),
      await put("not-a-token", png),
      await put(`${unknown}/../../etc`, png),
      await put(used.token, png),
      await put(expired.token, png),
    ];
    const first = JSON.stringify(results[0]);
    check("all five refusals are byte-identical (status + body)", results.every((r) => JSON.stringify(r) === first), results.map((r) => JSON.stringify(r)).join("\n"));
    check("…a G14 envelope with a Thai message", results[0].status === 404 && results[0].body.error === "upload_link_invalid" && results[0].body.code === "upload_link_invalid"
      && /[฀-๿]/u.test(String(results[0].body.message)) && typeof results[0].body.next === "string");
    staging.removeStagedUpload(used.importId);
    await prisma.mediaImport.deleteMany({});
  });

  await section("C5) bound to its kind: the bytes must be what the link was issued for", async () => {
    await reset();
    const cases: Array<["image" | "video" | "presenter", Buffer, string]> = [
      ["image", portrait, "image link + mp4"],
      ["video", png, "video link + png"],
      ["presenter", png, "presenter link + png"],
      ["video", Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\nhttp://169.254.169.254/x.ts\n"), "video link + HLS playlist text"],
    ];
    for (const [kind, bytes, label] of cases) {
      const issued = await issue(owner.id, kind);
      const res = await put(issued.token, bytes);
      const row = await prisma.mediaImport.findUnique({ where: { id: issued.importId } });
      check(`${label} → 415 unsupported_media, import failed, staged bytes deleted`,
        res.status === 415 && res.body.code === "unsupported_media" && row?.status === "failed" && row?.errorCode === "unsupported_media"
          && !fs.existsSync(staging.stagedUploadPath(issued.importId)),
        JSON.stringify({ res, row }));
    }
    const purposeByKind = { image: "broll_image", video: "broll_video", presenter: "presenter" } as const;
    for (const [kind, bytes] of [["image", png], ["video", landscape]] as const) {
      const issued = await issue(owner.id, kind);
      const res = await put(issued.token, bytes);
      const row = await prisma.mediaImport.findUnique({ where: { id: issued.importId } });
      check(`${kind} link + matching bytes → 202, purpose ${purposeByKind[kind]}`, res.status === 202 && row?.purpose === purposeByKind[kind], JSON.stringify(res));
      staging.removeStagedUpload(issued.importId);
    }
    await prisma.mediaImport.deleteMany({});
  });

  await section("C6) bound to its user: the import belongs to the token's user; a lost entitlement kills the link", async () => {
    await reset();
    const issued = await issue(other.id, "image");
    const res = await put(issued.token, png);
    const row = await prisma.mediaImport.findUnique({ where: { id: issued.importId } });
    check("import owned by the issuing user, not anyone else", res.status === 202 && row?.userId === other.id);
    staging.removeStagedUpload(issued.importId);

    const freeLink = await lib.issueUploadToken(downgraded.id, "image"); // DB-level issue; the tool refuses FREE (plan guard)
    if (!freeLink.ok) throw new Error("fixture");
    const freeRes = await put(freeLink.token, png);
    check("user no longer PRO/BUSINESS → same 404, link NOT consumed", freeRes.status === 404 && freeRes.body.code === "upload_link_invalid"
      && (await prisma.mcpUploadToken.findUnique({ where: { importId: freeLink.importId } }))?.usedAt === null);
    const outLink = await lib.issueUploadToken(outsider.id, "image");
    if (!outLink.ok) throw new Error("fixture");
    const outRes = await put(outLink.token, png);
    check("user outside the beta gate → same 404", outRes.status === 404 && outRes.body.code === "upload_link_invalid");
    await prisma.mediaImport.deleteMany({});
  });

  await section("C7) over-cap is refused before reading (Content-Length) and aborted mid-stream (chunked)", async () => {
    await reset();
    const declared = await issue(owner.id, "image");
    const res = await put(declared.token, png, { "content-length": String(20 * 1024 * 1024 + 1) });
    check("Content-Length over the 20 MB image cap → 413 file_too_large", res.status === 413 && res.body.code === "file_too_large", JSON.stringify(res));
    check("…link kept, no import row", (await prisma.mcpUploadToken.findUnique({ where: { importId: declared.importId } }))?.usedAt === null
      && (await prisma.mediaImport.count({ where: { id: declared.importId } })) === 0);

    const streamed = await issue(owner.id, "image");
    const CHUNK = 1024 * 1024;
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        const chunk = new Uint8Array(CHUNK);
        if (pulled === 1) chunk.set(png.subarray(0, Math.min(png.length, CHUNK)));
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const res2 = await put(streamed.token, endless);
    const row = await prisma.mediaImport.findUnique({ where: { id: streamed.importId } });
    check("lying/chunked body over the cap → 413 file_too_large", res2.status === 413 && res2.body.code === "file_too_large", JSON.stringify(res2));
    check("the body stream was cancelled (upload aborted)", cancelled);
    check("read stopped right after the cap (≤ 21 × 1 MB chunks pulled)", pulled <= 22, `pulled=${pulled}`);
    check("partial file deleted, import failed file_too_large", !fs.existsSync(staging.stagedUploadPath(streamed.importId)) && row?.status === "failed" && row?.errorCode === "file_too_large", JSON.stringify(row));

    const empty = await issue(owner.id, "image");
    const res3 = await put(empty.token, new Uint8Array(0));
    check("empty body → 400 empty_file", res3.status === 400 && res3.body.code === "empty_file", JSON.stringify(res3));
    const presenterCap = await issue(owner.id, "presenter");
    const res4 = await put(presenterCap.token, png, { "content-length": String(500 * 1024 * 1024 + 1) });
    check("presenter cap is 500 MB", res4.status === 413);
    const presenterOk = await issue(owner.id, "presenter");
    const res5 = await put(presenterOk.token, null, { "content-length": String(500 * 1024 * 1024) });
    check("presenter at exactly 500 MB declared passes the pre-check (then fails as empty body)", res5.status === 400 && res5.body.code === "empty_file", JSON.stringify(res5));
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
  });

  await section("C8) the PUT re-checks admission and keeps the link when refused", async () => {
    await reset();
    const issued = await issue(owner.id, "image");
    const busy = await Promise.all([1, 2, 3].map((i) => prisma.mediaImport.create({
      data: { userId: owner.id, purpose: "broll_image", source: "url", status: i === 3 ? "processing" : "pending", deadlineAt: new Date(Date.now() + 10 * MINUTE) },
    })));
    const res = await put(issued.token, png);
    check("3 imports active → 429 too_many_active_imports", res.status === 429 && res.body.code === "too_many_active_imports", JSON.stringify(res));
    check("…link NOT consumed", (await prisma.mcpUploadToken.findUnique({ where: { importId: issued.importId } }))?.usedAt === null);
    await prisma.mediaImport.update({ where: { id: busy[0].id }, data: { status: "ready" } });
    const retry = await put(issued.token, png);
    check("one import finishes → the same link now works", retry.status === 202, JSON.stringify(retry));
    staging.removeStagedUpload(issued.importId);
    await prisma.mediaImport.deleteMany({});

    const hourly = await issue(owner.id, "image");
    await prisma.mediaImport.createMany({
      data: Array.from({ length: 30 }, () => ({ userId: owner.id, purpose: "broll_image", source: "url", status: "ready", deadlineAt: new Date() })),
    });
    const res2 = await put(hourly.token, png);
    check("30 imports this hour → 429 import_hourly_limit", res2.status === 429 && res2.body.code === "import_hourly_limit", JSON.stringify(res2));
    await prisma.mediaImport.updateMany({ where: { userId: owner.id }, data: { createdAt: new Date(Date.now() - 61 * MINUTE) } });
    const res3 = await put(hourly.token, png);
    check("imports older than an hour do not count", res3.status === 202, JSON.stringify(res3));
    staging.removeStagedUpload(hourly.importId);
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
  });

  await section("C9) create_upload_url admission (same caps, plus 10 links per hour)", async () => {
    await reset();
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await lib.issueUploadToken(owner.id, "image"));
    check("10 links per hour, the 11th refused upload_link_hourly_limit",
      results.slice(0, 10).every((r) => r.ok) && !results[10].ok && (results[10] as { code: string }).code === "upload_link_hourly_limit");
    check("refused issue left no row", (await prisma.mcpUploadToken.count({ where: { userId: owner.id } })) === 10);
    await prisma.mcpUploadToken.updateMany({ where: { userId: owner.id }, data: { issuedAt: new Date(Date.now() - 61 * MINUTE) } });
    check("links older than an hour do not count", (await lib.issueUploadToken(owner.id, "image")).ok);
    await prisma.mcpUploadToken.deleteMany({});
    await prisma.mediaImport.createMany({
      data: Array.from({ length: 3 }, () => ({ userId: owner.id, purpose: "broll_video", source: "url", status: "pending", deadlineAt: new Date(Date.now() + MINUTE) })),
    });
    const busy = await lib.issueUploadToken(owner.id, "image");
    check("3 imports active → too_many_active_imports", !busy.ok && busy.code === "too_many_active_imports");
    await prisma.mediaImport.deleteMany({});
    await prisma.mediaImport.createMany({
      data: Array.from({ length: 30 }, () => ({ userId: owner.id, purpose: "broll_video", source: "url", status: "failed", deadlineAt: new Date() })),
    });
    const hourly = await lib.issueUploadToken(owner.id, "image");
    check("30 imports this hour → import_hourly_limit", !hourly.ok && hourly.code === "import_hourly_limit");
    const otherUser = await lib.issueUploadToken(other.id, "image");
    check("caps are per user", otherUser.ok);
    const reply = await tools.createUploadUrlTool(owner.id, { kind: "image" });
    check("tool reply for a refused admission is a G14 envelope with a Thai message",
      (reply as { code?: string }).code === "import_hourly_limit" && (reply as { error?: string }).error === "import_hourly_limit" && /[฀-๿]/u.test(String((reply as { message?: string }).message)),
      JSON.stringify(reply));
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
  });

  await section("C10) storage (fix round 1, S1): global staged-bytes budget + free-disk floor, link kept", async () => {
    await reset();
    const presenterLink = await issue(owner.id, "presenter");
    // 20 live presenter imports elsewhere reserve 20 × 500 MB = 10,000 MiB of the 10 GiB budget.
    const fillers = await prisma.mediaImport.createManyAndReturn({
      data: Array.from({ length: 20 }, (_, i) => ({
        userId: [other.id, outsider.id, downgraded.id][i % 3], purpose: "presenter", source: "upload",
        status: i % 2 ? "pending" : "processing", deadlineAt: new Date(Date.now() + 10 * MINUTE),
      })),
    });
    const refusedIssue = await lib.issueUploadToken(owner.id, "presenter");
    check("tool: one more presenter would pass the budget → storage_busy, no link row",
      !refusedIssue.ok && refusedIssue.code === "storage_busy" && (await prisma.mcpUploadToken.count({ where: { userId: owner.id } })) === 1, JSON.stringify(refusedIssue));
    const envelope = await tools.createUploadUrlTool(owner.id, { kind: "presenter" }) as { code?: string; message?: string; next?: string };
    check("tool reply is a G14 storage_busy envelope (Thai, retry hint)", envelope.code === "storage_busy" && /[฀-๿]/u.test(String(envelope.message)) && /[฀-๿]/u.test(String(envelope.next)), JSON.stringify(envelope));
    check("tool: a 20 MB image still fits the budget", (await lib.issueUploadToken(owner.id, "image")).ok);
    const refusedPut = await put(presenterLink.token, portrait);
    check("PUT: over budget → 503 storage_busy with a retry hint", refusedPut.status === 503 && refusedPut.body.code === "storage_busy" && typeof refusedPut.body.next === "string", JSON.stringify(refusedPut));
    check("…link kept, no import row, nothing staged",
      (await prisma.mcpUploadToken.findUnique({ where: { importId: presenterLink.importId } }))?.usedAt === null
        && !(await prisma.mediaImport.findUnique({ where: { id: presenterLink.importId } }))
        && !fs.existsSync(staging.stagedUploadPath(presenterLink.importId)));
    await prisma.mediaImport.update({ where: { id: fillers[0].id }, data: { deadlineAt: new Date(Date.now() - MINUTE) } });
    const afterExpiry = await put(presenterLink.token, portrait);
    check("a filler past its deadline frees its reservation → the same link now works", afterExpiry.status === 202, JSON.stringify(afterExpiry));
    staging.removeStagedUpload(presenterLink.importId);
    await reset();

    // Free-disk floor, measured with statfs on the staging dir before admission.
    const realStatfs = fs.statfsSync;
    const floor = staging.STAGING_MIN_FREE_BYTES;
    check("floor is 5 GiB", floor === 5 * 1024 ** 3);
    const disk = staging.stagingHasRoomFor(lib.UPLOAD_KIND_MAX_BYTES.presenter);
    check("real statfs on this host's staging dir: room for a presenter upload", disk === true);
    const fakeFree = (free: number) => {
      (fs as { statfsSync: unknown }).statfsSync = (target: fs.PathLike) => {
        const real = realStatfs(target);
        return { ...real, bsize: 1, bavail: free };
      };
    };
    const link = await issue(owner.id, "video");
    try {
      fakeFree(floor + lib.UPLOAD_KIND_MAX_BYTES.video - 1);
      const low = await put(link.token, landscape);
      check("free < floor + the kind's cap → 503 storage_busy", low.status === 503 && low.body.code === "storage_busy", JSON.stringify(low));
      check("…link kept, no import row, nothing staged",
        (await prisma.mcpUploadToken.findUnique({ where: { importId: link.importId } }))?.usedAt === null
          && (await prisma.mediaImport.count()) === 0 && !fs.existsSync(staging.stagedUploadPath(link.importId)));
      (fs as { statfsSync: unknown }).statfsSync = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
      const broken = await put(link.token, landscape);
      check("statfs failing → fail closed (503 storage_busy), link kept", broken.status === 503 && broken.body.code === "storage_busy"
        && (await prisma.mcpUploadToken.findUnique({ where: { importId: link.importId } }))?.usedAt === null, JSON.stringify(broken));
      fakeFree(floor + lib.UPLOAD_KIND_MAX_BYTES.video);
      const exact = await put(link.token, landscape);
      check("free = floor + cap → accepted with the same link", exact.status === 202, JSON.stringify(exact));
    } finally {
      (fs as { statfsSync: unknown }).statfsSync = realStatfs;
    }
    staging.removeStagedUpload(link.importId);
    await reset();
  });

  await section("C11) rows past their deadline hold no slot (fix round 1, R-A4)", async () => {
    await reset();
    await prisma.mediaImport.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({
        userId: owner.id, purpose: "broll_image", source: "upload", status: i ? "pending" : "processing",
        deadlineAt: new Date(Date.now() - MINUTE),
      })),
    });
    const issued = await lib.issueUploadToken(owner.id, "image");
    check("3 stale active rows (deadline passed, no watchdog yet) → a new link is still issued", issued.ok, JSON.stringify(issued));
    if (issued.ok) {
      const res = await put(issued.token, png);
      check("…and its PUT is admitted", res.status === 202, JSON.stringify(res));
      staging.removeStagedUpload(issued.importId);
    }
    await prisma.mediaImport.updateMany({ where: { userId: owner.id }, data: { deadlineAt: new Date(Date.now() + MINUTE), createdAt: new Date(Date.now() - 2 * 60 * MINUTE) } });
    const busy = await lib.issueUploadToken(owner.id, "image");
    check("rows still inside their deadline do count → too_many_active_imports", !busy.ok && busy.code === "too_many_active_imports", JSON.stringify(busy));
    await reset();
  });

  await section("C12) DB unavailable before staging → 503 G14 envelope, link kept (fix round 1, R-A1)", async () => {
    await reset();
    const link = await issue(owner.id, "image");
    const busyError = () => Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "P1008" });
    const delegates: Array<[string, Record<string, unknown>, string]> = [
      ["token lookup", prisma.mcpUploadToken as unknown as Record<string, unknown>, "findUnique"],
      ["user lookup", prisma.user as unknown as Record<string, unknown>, "findUnique"],
      ["admission transaction", prisma as unknown as Record<string, unknown>, "$transaction"],
    ];
    const { checkFailureEnvelope } = await import("./mcp-agent-neutral-checks");
    for (const [label, target, method] of delegates) {
      const original = target[method];
      target[method] = async () => { throw busyError(); };
      let res: PutResult;
      try {
        res = await putWithHeaders(link.token, png);
      } finally {
        target[method] = original;
      }
      check(`${label} throws → 503 server_busy envelope (Thai, retry with the same link), no-store`,
        res.status === 503 && res.body.code === "server_busy" && checkFailureEnvelope(res.body).length === 0
          && /[฀-๿]/u.test(String(res.body.message)) && /ลิงก์เดิม/u.test(String(res.body.next)) && res.cacheControl === "no-store",
        JSON.stringify(res));
    }
    check("…link never consumed, no import row",
      (await prisma.mcpUploadToken.findUnique({ where: { importId: link.importId } }))?.usedAt === null && (await prisma.mediaImport.count()) === 0);
    const retry = await put(link.token, png);
    check("DB back → the same link works", retry.status === 202, JSON.stringify(retry));
    staging.removeStagedUpload(link.importId);
    await reset();
  });

  // ── D. across processes ──────────────────────────────────────────────────────────────────
  await section("D) admission caps hold across two processes sharing one SQLite file", async () => {
    // D1: 10 links/hour — two processes ask for 8 each at the same instant.
    const racerA = await makeUser("u-race-a", "qa-race-a@aoacademy.co");
    const go1 = path.join(tmp, "go-1");
    const issued = await runChildren([
      { op: "issue", userId: racerA.id, kind: "image", attempts: 8, goFile: go1 },
      { op: "issue", userId: racerA.id, kind: "image", attempts: 8, goFile: go1 },
    ], go1);
    const issuedFlat = issued.flat();
    check("links: exactly 10 of 16 admitted across both processes", issuedFlat.filter((r) => r.ok).length === 10, JSON.stringify(issued));
    check("links: the other 6 refused upload_link_hourly_limit", issuedFlat.filter((r) => !r.ok && r.code === "upload_link_hourly_limit").length === 6);
    check("links: DB holds exactly 10", (await prisma.mcpUploadToken.count({ where: { userId: racerA.id } })) === 10);
    check("links: each process finished all 8 attempts", issued.every((r) => r.length === 8),
      `admitted per process: ${issued.map((r) => r.filter((x) => x.ok).length).join(" + ")}`);
    console.log(`        admitted per process: ${issued.map((r) => r.filter((x) => x.ok).length).join(" + ")}`);

    // D2: 3 active imports — 8 valid links, two processes consume 4 each at once.
    const racerB = await makeUser("u-race-b", "qa-race-b@aoacademy.co");
    const rawsB: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const raw = `heroai_up_${String(i).padStart(43, "b")}`;
      rawsB.push(raw);
      await prisma.mcpUploadToken.create({ data: { tokenHash: sha256(raw), userId: racerB.id, kind: "video", importId: `race-b-${i}` } });
    }
    const go2 = path.join(tmp, "go-2");
    const admitted = (await runChildren([
      { op: "admit", tokens: rawsB.slice(0, 4), goFile: go2 },
      { op: "admit", tokens: rawsB.slice(4), goFile: go2 },
    ], go2)).flat();
    check("active: exactly 3 of 8 admitted", admitted.filter((r) => r.ok).length === 3, JSON.stringify(admitted));
    check("active: the other 5 refused too_many_active_imports", admitted.filter((r) => r.code === "too_many_active_imports").length === 5);
    check("active: DB holds 3 processing imports, 3 consumed links",
      (await prisma.mediaImport.count({ where: { userId: racerB.id, status: "processing" } })) === 3
        && (await prisma.mcpUploadToken.count({ where: { userId: racerB.id, usedAt: { not: null } } })) === 3);

    // D3: 30 per hour — 28 already this hour, two processes admit 3 each at once.
    const racerC = await makeUser("u-race-c", "qa-race-c@aoacademy.co");
    await prisma.mediaImport.createMany({
      data: Array.from({ length: 28 }, () => ({ userId: racerC.id, purpose: "broll_image", source: "url", status: "ready", deadlineAt: new Date() })),
    });
    const rawsC: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const raw = `heroai_up_${String(i).padStart(43, "c")}`;
      rawsC.push(raw);
      await prisma.mcpUploadToken.create({ data: { tokenHash: sha256(raw), userId: racerC.id, kind: "image", importId: `race-c-${i}` } });
    }
    const go3 = path.join(tmp, "go-3");
    const hourly = (await runChildren([
      { op: "admit", tokens: rawsC.slice(0, 3), goFile: go3 },
      { op: "admit", tokens: rawsC.slice(3), goFile: go3 },
    ], go3)).flat();
    check("hourly: exactly 2 of 6 admitted (28 + 2 = 30)", hourly.filter((r) => r.ok).length === 2, JSON.stringify(hourly));
    check("hourly: DB holds exactly 30 imports this hour", (await prisma.mediaImport.count({ where: { userId: racerC.id } })) === 30);
  });

  // ── E. IDOR ──────────────────────────────────────────────────────────────────────────────
  await section("E) G27: missing, foreign and wrong-purpose ids get one identical invalid_input", async () => {
    await reset();
    const mine = await prisma.mediaImport.create({ data: { userId: owner.id, purpose: "broll_video", source: "upload", status: "ready", deadlineAt: new Date() } });
    const theirs = await prisma.mediaImport.create({ data: { userId: other.id, purpose: "broll_video", source: "upload", status: "ready", deadlineAt: new Date() } });
    const ok = await lib.findOwnedMediaImport(owner.id, mine.id, ["broll_image", "broll_video"]);
    check("owner + right purpose → the row", ok.ok && ok.row.id === mine.id);
    const refusals = [
      await lib.findOwnedMediaImport(owner.id, "c0000000000000000000000000", ["broll_image", "broll_video"]),
      await lib.findOwnedMediaImport(owner.id, theirs.id, ["broll_image", "broll_video"]),
      await lib.findOwnedMediaImport(owner.id, mine.id, ["presenter"]),
      await lib.findOwnedMediaImport(owner.id, "../../etc/passwd", ["broll_video"]),
      await lib.findOwnedMediaImport(owner.id, "", ["broll_video"]),
    ];
    const bodies = refusals.map((r) => JSON.stringify(r));
    check("all refusals identical", bodies.every((b) => b === bodies[0]), bodies.join("\n"));
    const failure = !refusals[0].ok ? refusals[0].failure : null;
    check("…invalid_input G14 envelope, Thai, no id echoed", !!failure && failure.error === "invalid_input" && failure.code === "invalid_input"
      && /[฀-๿]/u.test(failure.message) && !bodies[1].includes(theirs.id));
    await prisma.mediaImport.deleteMany({});
  });

  // ── F. hand-off to T9's pipelines ────────────────────────────────────────────────────────
  await section("F) the staged file goes through T9's B-roll pipeline / presenter checks, then is removed", async () => {
    await reset();
    const stocksDir = path.join(tmp, "stocks");
    const outputs: string[] = [];
    try {
      const staged = async (kind: "image" | "video" | "presenter", bytes: Buffer) => {
        const issued = await issue(owner.id, kind);
        const res = await put(issued.token, bytes);
        if (res.status !== 202) throw new Error(`fixture upload refused: ${JSON.stringify(res)}`);
        const row = await prisma.mediaImport.findUniqueOrThrow({ where: { id: issued.importId } });
        // The import lane (Task 12) finishes each row; here the row just leaves "pending" so the
        // next fixture upload is not refused by the 3-active cap.
        await prisma.mediaImport.update({ where: { id: row.id }, data: { status: "ready" } });
        return row;
      };
      const image = await staged("image", png);
      const imageResult = await staging.processStagedUpload({ importId: image.id, purpose: image.purpose, plan: "PRO", stocksDir });
      check("image → Ken Burns clip under /api/stocks/, 5 s", imageResult.ok && /^\/api\/stocks\/broll-upload-[\w-]+\.mp4$/.test(imageResult.resultSrc) && imageResult.durationMs === 5000, JSON.stringify(imageResult));
      if (imageResult.ok) outputs.push(path.join(stocksDir, path.basename(imageResult.resultSrc)));
      check("image: staged file removed", !fs.existsSync(staging.stagedUploadPath(image.id)));

      const video = await staged("video", landscape);
      const videoResult = await staging.processStagedUpload({ importId: video.id, purpose: video.purpose, plan: "PRO", stocksDir });
      check("video → normalized clip under /api/stocks/ with its duration", videoResult.ok && videoResult.resultSrc.startsWith("/api/stocks/") && videoResult.durationMs > 500, JSON.stringify(videoResult));
      if (videoResult.ok) outputs.push(path.join(stocksDir, path.basename(videoResult.resultSrc)));
      check("video: staged file removed", !fs.existsSync(staging.stagedUploadPath(video.id)));

      const presenter = await staged("presenter", portrait);
      const presenterResult = await staging.processStagedUpload({ importId: presenter.id, purpose: presenter.purpose, plan: "PRO", stocksDir });
      check("presenter (portrait) → /api/renders/presenter-import-…", presenterResult.ok && /^\/api\/renders\/presenter-import-[\w-]+\.mp4$/.test(presenterResult.resultSrc), JSON.stringify(presenterResult));
      if (presenterResult.ok) outputs.push(path.join(ROOT, "public", "renders", path.basename(presenterResult.resultSrc)));
      check("presenter: staged file gone", !fs.existsSync(staging.stagedUploadPath(presenter.id)));

      const wrong = await staged("presenter", landscape);
      const wrongResult = await staging.processStagedUpload({ importId: wrong.id, purpose: wrong.purpose, plan: "PRO", stocksDir });
      check("presenter (landscape) → not_portrait, staged file removed", !wrongResult.ok && wrongResult.errorCode === "not_portrait" && !fs.existsSync(staging.stagedUploadPath(wrong.id)), JSON.stringify(wrongResult));

      const missing = await staging.processStagedUpload({ importId: "never-staged", purpose: "broll_image", plan: "PRO", stocksDir });
      check("nothing staged → upload_missing", !missing.ok && missing.errorCode === "upload_missing");
    } finally {
      // Outputs land in the real stocks/renders dirs of this checkout; never leave them behind.
      for (const file of outputs) fs.rmSync(file, { force: true });
    }
    await prisma.mediaImport.deleteMany({});
  });

  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (process.argv[2] === CHILD_FLAG) {
  runChild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
