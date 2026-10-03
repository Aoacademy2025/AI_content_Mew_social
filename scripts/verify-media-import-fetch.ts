/**
 * verify-media-import-fetch — the Media Import fetch guard (`src/lib/media-import/fetch.ts`,
 * Task 10, PR-B, G23, ADR 0065). It fetches attacker-chosen URLs server-side, so every
 * check here is an SSRF / resource-exhaustion boundary.
 *
 * Proves, against real local HTTPS servers and an injected resolver:
 *   - `https:` only — every other scheme is refused before any DNS or socket;
 *   - private address forms are refused, direct (literal and DNS) and via a redirect hop,
 *     with zero connections to the local server they would reach;
 *   - DNS rebinding: a resolver that answers public first and private second gets exactly
 *     one lookup per hop, and the private server sees zero connections (a control run of
 *     check-then-connect DOES reach it, so the rig can tell the difference);
 *   - the redirect hop cap (5), per hop;
 *   - the byte cap: refused on a declared Content-Length, aborted mid-body while
 *     streaming, and per detected kind;
 *   - connect timeout, idle timeout, and a total deadline that a slow-loris drip (body or
 *     headers) cannot outlast;
 *   - the media type comes from the bytes (HTML, HLS, DASH-in-PNG, empty → refused);
 *   - TLS is verified against the URL's hostname even though the socket is pinned to an IP;
 *   - no temp file is left behind on any failure, and no error message, error property or
 *     log line carries an IP, hostname, port, temp path or upstream text;
 *   - only this script calls the test entry point (which can swap classifier and CA).
 *
 * Needs the `openssl` CLI (a throwaway self-signed cert) and an IPv6 loopback (`::1`) for
 * the "private" server. Both exist on macOS and the GitHub ubuntu runner.
 *
 * Run: npm run verify:media-import-fetch
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { ipIsPrivate } from "../src/lib/safe-fetch";
import {
  MEDIA_FETCH_ERROR_CODES,
  MediaFetchError,
  fetchMediaToTempFile,
  fetchMediaToTempFileForTests,
  type FetchedMedia,
  type MediaFetchErrorCode,
  type MediaFetchOptions,
  type MediaFetchTestHooks,
} from "../src/lib/media-import/fetch";

let failures = 0;
let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failures++;
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}
function section(title: string): void {
  console.log(`\n# ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: media bytes. Only the leading bytes matter to the fetch guard (ffprobe runs
// later, in the T9 pipeline). Every fixture is served with a WRONG Content-Type, to prove
// the type is decided by the bytes, never by the header.
// ─────────────────────────────────────────────────────────────────────────────
const filler = (n: number) => Buffer.alloc(n, 0x41);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), filler(3000)]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a46494600", "hex"), filler(3000)]);
const MP4 = Buffer.concat([Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"), filler(3000)]);
const WEBM = Buffer.concat([Buffer.from("1a45dfa39f4286810142f7810142f2810442f381084282847765626d", "hex"), filler(3000)]);
const MP4_FROM_B = Buffer.concat([Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"), Buffer.alloc(500, 0x42)]);
const HTML = Buffer.from("<!doctype html><html><body>not media</body></html>");
const M3U8 = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nfile:///etc/passwd\n");
// A PNG signature with a DASH manifest behind it and no NUL before it: ffmpeg's dash
// demuxer would find "<MPD" in the probe buffer (media-probe-args MANIFEST_MARKERS).
const MPD_IN_PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'), filler(500)]);
const UPSTREAM_SECRET = "SECRET-UPSTREAM-TEXT 10.9.8.7 /etc/passwd";

// ─────────────────────────────────────────────────────────────────────────────
// TLS: a throwaway self-signed cert for the test hostnames (+ IP 127.0.0.1).
// ─────────────────────────────────────────────────────────────────────────────
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "verify-media-fetch-"));
const TMP = path.join(WORK, "imports"); // the fetch module's temp dir under test
fs.mkdirSync(TMP);
function makeCert(): { key: string; cert: string } {
  const keyPath = path.join(WORK, "key.pem");
  const certPath = path.join(WORK, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=media.test",
    "-addext", "subjectAltName=DNS:media.test,DNS:rebind.test,DNS:rebind-private.test,DNS:local6.test,DNS:internal.test,IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
}
const CREDS = makeCert();

// ─────────────────────────────────────────────────────────────────────────────
// Servers.
//   A  https on 127.0.0.1:P — the "public" origin (the test classifier exempts 127.0.0.1).
//   B  https on [::1]:P (same port) — the "private" origin a rebinding answer points at.
//   H  raw TLS on 127.0.0.1 — drips response HEADERS forever (header slow-loris).
//   T  plain TCP on 127.0.0.1 — accepts, never speaks (TLS handshake never completes).
// ─────────────────────────────────────────────────────────────────────────────
const counters = { a: 0, b: 0, h: 0, t: 0 };
const requestsByPath = new Map<string, number>();
const bigStream = { written: 0, closedEarly: false, finished: false };
const bigDeclared = { closed: false };
const TARGET_BIG_STREAM = 64 * 1024 * 1024;

function sendBody(res: http.ServerResponse, body: Buffer, contentType = "text/plain") {
  res.writeHead(200, { "content-type": contentType, "content-length": String(body.length) });
  res.end(body);
}

const handlerA: http.RequestListener = (req, res) => {
  const url = new URL(req.url ?? "/", "https://media.test");
  const p = url.pathname;
  requestsByPath.set(p.split("/").slice(0, 2).join("/"), (requestsByPath.get(p.split("/").slice(0, 2).join("/")) ?? 0) + 1);
  if (p === "/ok.png") return sendBody(res, PNG, "text/html");
  if (p === "/ok.jpg") return sendBody(res, JPEG, "application/octet-stream");
  if (p === "/ok.mp4") return sendBody(res, MP4, "image/png");
  if (p === "/ok.webm") return sendBody(res, WEBM, "text/plain");
  if (p === "/html") return sendBody(res, HTML, "image/png");
  if (p === "/m3u8") return sendBody(res, M3U8, "video/mp4");
  if (p === "/mpd-png") return sendBody(res, MPD_IN_PNG, "image/png");
  if (p === "/empty") return sendBody(res, Buffer.alloc(0), "image/png");
  if (p === "/mpd-late") {
    // A clean PNG head first, the DASH marker in a later chunk: only the whole-file sniff
    // (not the early head sniff) can see it.
    res.writeHead(200, { "content-type": "image/png" });
    res.write(Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), filler(120)]));
    const timer = setTimeout(() => res.end(Buffer.concat([Buffer.from('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'), filler(200)])), 80);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  if (p.startsWith("/status/")) {
    res.writeHead(Number(p.slice("/status/".length)), { "content-type": "text/plain" });
    return void res.end(UPSTREAM_SECRET);
  }
  if (p === "/redirect") {
    res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
    return void res.end(UPSTREAM_SECRET);
  }
  if (p === "/redirect-no-location") {
    res.writeHead(302);
    return void res.end(UPSTREAM_SECRET);
  }
  if (p.startsWith("/chain/")) {
    const n = Number(p.slice("/chain/".length));
    if (n <= 0) return sendBody(res, PNG, "image/png");
    res.writeHead(301, { location: `/chain/${n - 1}` });
    return void res.end();
  }
  if (p.startsWith("/loop/")) {
    const n = Number(p.slice("/loop/".length));
    res.writeHead(307, { location: `/loop/${n + 1}` });
    return void res.end();
  }
  if (p === "/big-declared") {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(1_000_000_000) });
    // Fewer bytes than the sniff head, then silence: only the up-front Content-Length
    // check can refuse this as file_too_large (anything later would time out instead).
    res.write(PNG.subarray(0, 16));
    res.on("close", () => { bigDeclared.closed = true; });
    return; // never ends — the client must refuse on the header alone
  }
  if (p === "/big-stream") {
    res.writeHead(200, { "content-type": "image/png" }); // chunked, no Content-Length
    const chunk = filler(16 * 1024);
    res.on("close", () => { if (!bigStream.finished) bigStream.closedEarly = true; });
    res.write(PNG.subarray(0, 16));
    bigStream.written += 16;
    const pump = () => {
      while (!res.destroyed && bigStream.written < TARGET_BIG_STREAM) {
        bigStream.written += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      if (!res.destroyed) { bigStream.finished = true; res.end(); }
    };
    return pump();
  }
  if (p === "/drip") {
    res.writeHead(200, { "content-type": "image/png" });
    res.write(PNG.subarray(0, 16));
    const timer = setInterval(() => { if (!res.destroyed) res.write("A"); }, 40);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (p === "/stall-body") {
    res.writeHead(200, { "content-type": "image/png" });
    res.write(PNG.subarray(0, 16));
    return; // then nothing
  }
  if (p === "/stall-headers") return; // never answers
  res.writeHead(404);
  res.end(UPSTREAM_SECRET);
};

const serverA = https.createServer({ key: CREDS.key, cert: CREDS.cert }, handlerA);
serverA.on("connection", () => { counters.a++; });
const serverB = https.createServer({ key: CREDS.key, cert: CREDS.cert }, (_req, res) => sendBody(res, MP4_FROM_B, "video/mp4"));
serverB.on("connection", () => { counters.b++; });
const dripHeaders = new Set<NodeJS.Timeout>();
const serverH = tls.createServer({ key: CREDS.key, cert: CREDS.cert }, (sock) => {
  sock.on("error", () => {});
  sock.write("HTTP/1.1 200 OK\r\n");
  const timer = setInterval(() => { if (!sock.destroyed) sock.write("X-Drip: a\r\n"); }, 40);
  dripHeaders.add(timer);
  sock.on("close", () => { clearInterval(timer); dripHeaders.delete(timer); });
});
serverH.on("connection", () => { counters.h++; });
const silentSockets = new Set<net.Socket>();
const serverT = net.createServer((sock) => {
  silentSockets.add(sock);
  sock.on("error", () => {});
  sock.on("close", () => silentSockets.delete(sock));
});
serverT.on("connection", () => { counters.t++; });

async function listen(server: net.Server, port: number, host: string): Promise<number> {
  server.listen(port, host);
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver + classifier seams.
// ─────────────────────────────────────────────────────────────────────────────
type Answer = Array<{ address: string; family?: number }>;
const resolverCalls: string[] = [];
let rebindCalls = 0;
let rebindPrivateCalls = 0;
const fam = (address: string) => (net.isIPv6(address) ? 6 : 4);
const answers: Record<string, () => Answer> = {
  "media.test": () => [{ address: "127.0.0.1", family: 4 }],
  "other-name.test": () => [{ address: "127.0.0.1", family: 4 }], // not in the cert
  "internal.test": () => [{ address: "10.0.0.7", family: 4 }],
  "local6.test": () => [{ address: "::1", family: 6 }],
  "meta.test": () => [{ address: "::ffff:a9fe:a9fe", family: 6 }],
  "ula.test": () => [{ address: "fd12::1", family: 6 }],
  "mixed.test": () => [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }],
  "garbage.test": () => [{ address: "not-an-ip", family: 4 }],
  "empty.test": () => [],
  // Public on the first lookup, private on every later one.
  "rebind.test": () => (++rebindCalls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "::1", family: 6 }]),
  // Private on the very first lookup.
  "rebind-private.test": () => (++rebindPrivateCalls === 1 ? [{ address: "::1", family: 6 }] : [{ address: "127.0.0.1", family: 4 }]),
};
async function testResolve(hostname: string): Promise<Answer> {
  resolverCalls.push(hostname);
  const answer = answers[hostname];
  if (!answer) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
    err.code = "ENOTFOUND";
    throw err;
  }
  return answer().map((a) => ({ address: a.address, family: a.family ?? fam(a.address) }));
}
/** The test servers live on 127.0.0.1, so only that exact address is treated as public. */
const testIsPrivate = (ip: string) => (ip === "127.0.0.1" ? false : ipIsPrivate(ip));

let PORT = 0;
let PORT_H = 0;
let PORT_T = 0;

const CALL_WATCHDOG_MS = 15_000;
const BROLL: MediaFetchOptions["accept"] = { image: 1 << 20, video: 4 << 20 };
const PRESENTER: MediaFetchOptions["accept"] = { video: 4 << 20 };

function hooks(extra: Partial<MediaFetchTestHooks> = {}): MediaFetchTestHooks {
  return {
    resolve: testResolve,
    isPrivateAddress: testIsPrivate,
    ca: CREDS.cert,
    connectTimeoutMs: 3000,
    idleTimeoutMs: 3000,
    deadlineMs: 10_000,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leak + leftover assertions, applied to EVERY failure and success.
// ─────────────────────────────────────────────────────────────────────────────
function forbiddenFragments(): string[] {
  return [
    "127.0.0.1", "::1", "10.0.0", "169.254", "a9fe", ".test", String(PORT), String(PORT_H), String(PORT_T),
    WORK, TMP, os.tmpdir(), "SECRET", "/etc/passwd", "ECONN", "ENOTFOUND", "getaddrinfo", "certificate", "self-signed",
  ];
}

const captured: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
function captureLogs(): () => void {
  captured.length = 0;
  const grab = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  console.log = grab; console.info = grab; console.warn = grab; console.error = grab; console.debug = grab;
  return () => Object.assign(console, originalConsole);
}
const processWarnings: string[] = [];
process.on("warning", (w) => processWarnings.push(String(w)));

function tmpEntries(): string[] {
  return fs.readdirSync(TMP);
}

async function run(
  url: string,
  options: MediaFetchOptions,
  hookSet: MediaFetchTestHooks | null,
): Promise<{ ok: true; value: FetchedMedia; ms: number } | { ok: false; error: unknown; ms: number }> {
  const started = Date.now();
  const restore = captureLogs();
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const call = hookSet ? fetchMediaToTempFileForTests(url, options, hookSet) : fetchMediaToTempFile(url, options);
    // A guard that never gives up (e.g. a missing deadline) fails here instead of hanging CI.
    const stuck = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(`did not settle within ${CALL_WATCHDOG_MS} ms`)), CALL_WATCHDOG_MS);
    });
    const value = await Promise.race([call, stuck]);
    return { ok: true, value, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - started };
  } finally {
    clearTimeout(watchdog);
    restore();
  }
}

async function expectCode(
  name: string,
  url: string,
  code: MediaFetchErrorCode,
  options: Partial<MediaFetchOptions> = {},
  hookSet: MediaFetchTestHooks | null = hooks(),
): Promise<{ ms: number } | null> {
  const before = tmpEntries();
  const out = await run(url, { accept: BROLL, tmpDir: TMP, ...options }, hookSet);
  if (out.ok) {
    check(`${name} → ${code}`, false, `resolved with ${out.value.kind}/${out.value.ext}`);
    try { fs.unlinkSync(out.value.path); } catch {}
    return null;
  }
  const err = out.error;
  const isOurs = err instanceof MediaFetchError;
  const got = isOurs ? (err as MediaFetchError).code : `non-MediaFetchError: ${String(err)}`;
  check(`${name} → ${code}`, isOurs && got === code, `got ${got}`);
  if (isOurs) {
    const e = err as MediaFetchError;
    const visible = [e.message, JSON.stringify(Object.assign({}, e))].join(" ");
    const leaked = forbiddenFragments().filter((f) => f && visible.includes(f));
    check(`${name}: error carries no IP/host/port/path/upstream text`, leaked.length === 0, `leaked ${JSON.stringify(leaked)} in ${visible}`);
    check(`${name}: error has no cause`, (e as { cause?: unknown }).cause === undefined);
    check(`${name}: error props are just { name, code }`, Object.keys(e).every((k) => k === "name" || k === "code"), JSON.stringify(Object.keys(e)));
  }
  check(`${name}: nothing logged`, captured.length === 0, JSON.stringify(captured));
  // A destroyed write stream closes asynchronously; give it a moment before judging.
  await new Promise((r) => setTimeout(r, 20));
  const after = tmpEntries();
  check(`${name}: no temp file left behind`, after.length === before.length, JSON.stringify(after));
  return { ms: out.ms };
}

async function expectMedia(
  name: string,
  url: string,
  expected: { kind: "image" | "video"; ext: string; mime: string; body: Buffer },
  options: Partial<MediaFetchOptions> = {},
  hookSet: MediaFetchTestHooks = hooks(),
): Promise<void> {
  const out = await run(url, { accept: BROLL, tmpDir: TMP, ...options }, hookSet);
  if (!out.ok) {
    const e = out.error;
    check(name, false, e instanceof MediaFetchError ? e.code : String(e));
    return;
  }
  const m = out.value;
  const onDisk = fs.existsSync(m.path) ? fs.readFileSync(m.path) : Buffer.alloc(0);
  check(name, m.kind === expected.kind && m.ext === expected.ext && m.mime === expected.mime,
    JSON.stringify({ kind: m.kind, ext: m.ext, mime: m.mime }));
  check(`${name}: file bytes match what the server sent`, onDisk.equals(expected.body) && m.bytes === expected.body.length,
    `${onDisk.length} vs ${expected.body.length}`);
  check(`${name}: temp file is inside tmpDir and named .${expected.ext}`, path.dirname(m.path) === TMP && m.path.endsWith(`.${expected.ext}`), m.path);
  if (process.platform !== "win32") {
    check(`${name}: temp file mode is 0600`, (fs.statSync(m.path).mode & 0o777) === 0o600, (fs.statSync(m.path).mode & 0o777).toString(8));
  }
  check(`${name}: nothing logged`, captured.length === 0, JSON.stringify(captured));
  fs.unlinkSync(m.path);
}

const deltas = () => ({ ...counters });

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  PORT = await listen(serverA, 0, "127.0.0.1");
  try {
    await listen(serverB, PORT, "::1");
  } catch (err) {
    console.log(`✗ cannot listen on [::1]:${PORT} — this test needs an IPv6 loopback (${String(err)})`);
    process.exit(1);
  }
  PORT_H = await listen(serverH, 0, "127.0.0.1");
  PORT_T = await listen(serverT, 0, "127.0.0.1");
  const A = (p: string, host = "media.test") => `https://${host}:${PORT}${p}`;

  section("0. error code vocabulary");
  check("exactly the seven G23 codes", JSON.stringify([...MEDIA_FETCH_ERROR_CODES].sort()) === JSON.stringify([
    "fetch_failed", "fetch_timeout", "file_too_large", "too_many_redirects", "unsupported_media", "url_not_https", "url_not_public",
  ]));

  section("1. success path — bytes decide the type, TLS verified, socket pinned");
  await expectMedia("png served as text/html → image/png", A("/ok.png"), { kind: "image", ext: "png", mime: "image/png", body: PNG });
  await expectMedia("jpeg → image/jpeg .jpg", A("/ok.jpg"), { kind: "image", ext: "jpg", mime: "image/jpeg", body: JPEG });
  await expectMedia("mp4 served as image/png → video/mp4", A("/ok.mp4"), { kind: "video", ext: "mp4", mime: "video/mp4", body: MP4 });
  await expectMedia("webm → video/webm", A("/ok.webm"), { kind: "video", ext: "webm", mime: "video/webm", body: WEBM });
  await expectMedia("presenter accepts mp4", A("/ok.mp4"), { kind: "video", ext: "mp4", mime: "video/mp4", body: MP4 }, { accept: PRESENTER });
  {
    const calls = resolverCalls.length;
    await expectMedia("literal public IP connects without DNS", `https://127.0.0.1:${PORT}/ok.png`, { kind: "image", ext: "png", mime: "image/png", body: PNG });
    check("literal IP: resolver not called", resolverCalls.length === calls);
  }
  {
    const calls = resolverCalls.length;
    await expectMedia("exactly 5 redirects is allowed", A("/chain/5"), { kind: "image", ext: "png", mime: "image/png", body: PNG });
    check("5 redirects: one lookup per hop (6 hops)", resolverCalls.length - calls === 6, String(resolverCalls.length - calls));
  }

  section("2. https only — refused before DNS or any socket");
  for (const url of [
    `http://media.test:${PORT}/ok.png`, `HTTP://media.test:${PORT}/ok.png`, `ftp://media.test/ok.png`, "file:///etc/passwd",
    "data:image/png;base64,iVBORw0KGgo=", "javascript:alert(1)", `wss://media.test:${PORT}/`, "not a url", "", `//media.test:${PORT}/ok.png`,
  ]) {
    const calls = resolverCalls.length;
    const before = deltas();
    await expectCode(`scheme ${JSON.stringify(url.slice(0, 32))}`, url, "url_not_https");
    check(`scheme ${JSON.stringify(url.slice(0, 32))}: no DNS, no connection`, resolverCalls.length === calls && counters.a === before.a);
  }

  section("3. private forms, direct — production classifier, zero connections");
  const literalForms = [
    `https://127.0.0.1:${PORT}/ok.png`, `https://[::ffff:7f00:1]:${PORT}/ok.png`, `https://[::ffff:127.0.0.1]:${PORT}/ok.png`,
    `https://[::1]:${PORT}/ok.png`, `https://0x7f000001:${PORT}/ok.png`, `https://2130706433:${PORT}/ok.png`,
    `https://0177.0.0.1:${PORT}/ok.png`, `https://127.1:${PORT}/ok.png`, `https://0.0.0.0:${PORT}/ok.png`, `https://[::]:${PORT}/ok.png`,
    "https://10.0.0.1/x.png", "https://172.16.0.1/x.png", "https://192.168.1.1/x.png", "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/x.png", "https://[fd00::1]/x.png", "https://[fe80::1]/x.png", "https://[::127.0.0.1]/x.png",
    "https://[64:ff9b::7f00:1]/x.png", "https://[2002:7f00:1::]/x.png", "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x.png",
    "https://[::ffff:a9fe:a9fe]/latest/meta-data/",
  ];
  const realClassifier = hooks({ isPrivateAddress: undefined, connectTimeoutMs: 500, idleTimeoutMs: 500, deadlineMs: 1500 });
  for (const url of literalForms) {
    const calls = resolverCalls.length;
    const before = deltas();
    await expectCode(`literal ${url}`, url, "url_not_public", {}, realClassifier);
    check(`literal ${url}: no DNS, no connection to A or B`, resolverCalls.length === calls && counters.a === before.a && counters.b === before.b);
  }
  for (const host of ["media.test", "local6.test", "internal.test", "meta.test", "ula.test", "mixed.test", "garbage.test"]) {
    const before = deltas();
    await expectCode(`DNS ${host} → private`, A("/ok.png", host), "url_not_public", {}, realClassifier);
    check(`DNS ${host}: no connection to A or B`, counters.a === before.a && counters.b === before.b);
  }
  {
    const before = deltas();
    await expectCode("DNS mixed public+private answer (test classifier) → refused whole host", A("/ok.png", "mixed.test"), "url_not_public");
    check("mixed answer: no connection at all", counters.a === before.a && counters.b === before.b);
  }
  {
    const before = deltas();
    // The production entry point, real DNS: /etc/hosts answers localhost without a network.
    await expectCode("production fetchMediaToTempFile: https://localhost", `https://localhost:${PORT}/ok.png`, "url_not_public", {}, null);
    await expectCode("production fetchMediaToTempFile: [::ffff:7f00:1]", `https://[::ffff:7f00:1]:${PORT}/ok.png`, "url_not_public", {}, null);
    await expectCode("production fetchMediaToTempFile: 127.0.0.1", `https://127.0.0.1:${PORT}/ok.png`, "url_not_public", {}, null);
    check("production entry point: zero connections to A or B", counters.a === before.a && counters.b === before.b);
  }
  await expectCode("DNS failure → fetch_failed", A("/ok.png", "nxdomain.test"), "fetch_failed");
  await expectCode("DNS empty answer → fetch_failed", A("/ok.png", "empty.test"), "fetch_failed");

  section("4. private forms via a redirect — each hop re-validated");
  const redirectTargets: Array<[string, string]> = [
    ["IPv4-mapped hex loopback (would reach A)", `https://[::ffff:7f00:1]:${PORT}/ok.png`],
    ["IPv6 loopback (B listens there)", `https://[::1]:${PORT}/ok.png`],
    ["name → 10.0.0.7", `https://internal.test:${PORT}/ok.png`],
    ["name → ::1", `https://local6.test:${PORT}/ok.png`],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["NAT64 loopback", `https://[64:ff9b::7f00:1]:${PORT}/ok.png`],
  ];
  for (const [label, target] of redirectTargets) {
    const before = deltas();
    await expectCode(`redirect → ${label}`, A(`/redirect?to=${encodeURIComponent(target)}`), "url_not_public");
    check(`redirect → ${label}: only the first hop connected, B untouched`, counters.a - before.a === 1 && counters.b === before.b,
      `a+${counters.a - before.a} b+${counters.b - before.b}`);
  }
  await expectCode("redirect → http:", A(`/redirect?to=${encodeURIComponent(`http://media.test:${PORT}/ok.png`)}`), "url_not_https");
  await expectCode("redirect → file:", A(`/redirect?to=${encodeURIComponent("file:///etc/passwd")}`), "url_not_https");
  await expectCode("redirect without Location → fetch_failed", A("/redirect-no-location"), "fetch_failed");

  section("5. DNS rebinding — one lookup per hop, pinned socket");
  {
    // Control: the classic check-then-connect does a second lookup and reaches B. This
    // proves the rig can see rebinding; the guard must not.
    const before = deltas();
    rebindCalls = 0;
    const first = await testResolve("rebind.test");
    const checkedPublic = first.every((a) => !testIsPrivate(a.address));
    const body = await new Promise<Buffer>((resolve, reject) => {
      const req = https.get({
        hostname: "rebind.test", port: PORT, path: "/ok.png", ca: CREDS.cert, agent: false,
        lookup: (host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          testResolve(host).then((list) => (opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family)), cb);
        },
      } as https.RequestOptions, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => resolve(Buffer.concat(parts)));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
    check("control: check-then-connect passed the check on the public answer", checkedPublic);
    check("control: …and its socket reached the private server B", counters.b - before.b === 1 && body.equals(MP4_FROM_B),
      `b+${counters.b - before.b}`);
  }
  {
    const before = deltas();
    rebindCalls = 0;
    const calls = resolverCalls.length;
    await expectMedia("rebinding resolver (public, then private) → served by A", A("/ok.png", "rebind.test"),
      { kind: "image", ext: "png", mime: "image/png", body: PNG });
    check("rebinding: the resolver was asked exactly once", rebindCalls === 1 && resolverCalls.length - calls === 1, `rebindCalls=${rebindCalls}`);
    check("rebinding: zero connections to the private server B", counters.b === before.b, `b+${counters.b - before.b}`);
  }
  {
    const before = deltas();
    rebindPrivateCalls = 0;
    await expectCode("rebinding resolver (private first) → refused at connect", A("/ok.png", "rebind-private.test"), "url_not_public");
    check("private-first: the resolver was asked exactly once", rebindPrivateCalls === 1, `calls=${rebindPrivateCalls}`);
    check("private-first: zero connections to A or B", counters.a === before.a && counters.b === before.b);
  }

  {
    // Belt and braces: even if an address got past the lookup, the peer is classified
    // again on TCP connect and the socket is dropped before the HTTP request is sent.
    let classified = 0;
    const flipsAfterLookup = (ip: string) => (++classified === 1 ? testIsPrivate(ip) : true);
    const before = deltas();
    const requestsBefore = requestsByPath.get("/ok.png") ?? 0;
    await expectCode("post-connect peer check → url_not_public", A("/ok.png"), "url_not_public", {},
      hooks({ isPrivateAddress: flipsAfterLookup }));
    check("post-connect: TCP reached A but no HTTP request was served",
      counters.a - before.a === 1 && (requestsByPath.get("/ok.png") ?? 0) === requestsBefore,
      `a+${counters.a - before.a} requests+${(requestsByPath.get("/ok.png") ?? 0) - requestsBefore}`);
  }

  section("6. redirect hop cap");
  requestsByPath.delete("/loop");
  await expectCode("endless redirects → too_many_redirects", A("/loop/0"), "too_many_redirects");
  check("hop cap: exactly 1 + 5 requests were made", requestsByPath.get("/loop") === 6, String(requestsByPath.get("/loop")));
  await expectCode("6 redirects → too_many_redirects", A("/chain/6"), "too_many_redirects");

  section("7. byte cap");
  {
    const out = await expectCode("declared Content-Length over cap → file_too_large", A("/big-declared"), "file_too_large");
    await new Promise((r) => setTimeout(r, 100));
    check("declared over cap: refused fast, connection closed", !!out && out.ms < 2000 && bigDeclared.closed, JSON.stringify({ ms: out?.ms, closed: bigDeclared.closed }));
  }
  {
    const out = await expectCode("chunked body over cap → aborted mid-body", A("/big-stream"), "file_too_large", { accept: { image: 256 * 1024 } });
    await new Promise((r) => setTimeout(r, 200));
    check("mid-body: server was cut off before it finished", bigStream.closedEarly && !bigStream.finished && bigStream.written < TARGET_BIG_STREAM / 4,
      JSON.stringify(bigStream));
    check("mid-body: refused fast", !!out && out.ms < 3000, String(out?.ms));
  }
  await expectCode("per-kind cap: png over the image cap → file_too_large", A("/ok.png"), "file_too_large", { accept: { image: 1024, video: 1 << 20 } });
  await expectMedia("per-kind cap: same-size mp4 under the video cap → ok", A("/ok.mp4"),
    { kind: "video", ext: "mp4", mime: "video/mp4", body: MP4 }, { accept: { image: 1024, video: 1 << 20 } });

  section("8. timeouts — connect, idle, and a total deadline slow-loris cannot outlast");
  {
    const out = await expectCode("TLS handshake never completes → connect timeout", `https://media.test:${PORT_T}/ok.png`, "fetch_timeout", {},
      hooks({ connectTimeoutMs: 300, idleTimeoutMs: 5000, deadlineMs: 5000 }));
    check("connect timeout fires near 300 ms", !!out && out.ms >= 250 && out.ms < 2000, String(out?.ms));
  }
  {
    const out = await expectCode("body stalls → idle timeout", A("/stall-body"), "fetch_timeout", {},
      hooks({ idleTimeoutMs: 300, deadlineMs: 5000 }));
    check("idle timeout fires near 300 ms", !!out && out.ms >= 250 && out.ms < 2000, String(out?.ms));
  }
  await expectCode("headers never come → idle timeout", A("/stall-headers"), "fetch_timeout", {}, hooks({ idleTimeoutMs: 300, deadlineMs: 5000 }));
  {
    const out = await expectCode("slow-loris body drip (1 B / 40 ms) → deadline", A("/drip"), "fetch_timeout", {},
      hooks({ idleTimeoutMs: 1000, deadlineMs: 700 }));
    check("body slow-loris stopped at the deadline, not the idle timer", !!out && out.ms >= 650 && out.ms < 2500, String(out?.ms));
  }
  {
    const out = await expectCode("slow-loris header drip → deadline", `https://media.test:${PORT_H}/`, "fetch_timeout", {},
      hooks({ idleTimeoutMs: 1000, deadlineMs: 700 }));
    check("header slow-loris stopped at the deadline", !!out && out.ms >= 650 && out.ms < 2500, String(out?.ms));
  }
  {
    // The production option can only shorten the deadline; here it does.
    const out = await expectCode("options.deadlineMs shortens the deadline", A("/drip"), "fetch_timeout", { deadlineMs: 500 },
      hooks({ idleTimeoutMs: 1000, deadlineMs: undefined }));
    check("options.deadlineMs honoured", !!out && out.ms >= 450 && out.ms < 2500, String(out?.ms));
  }

  section("9. TLS is verified against the hostname");
  await expectCode("self-signed cert without the test CA → fetch_failed", A("/ok.png"), "fetch_failed", {}, hooks({ ca: undefined }));
  await expectCode("cert does not cover the hostname → fetch_failed", A("/ok.png", "other-name.test"), "fetch_failed");

  section("10. bytes decide the type");
  await expectCode("HTML served as image/png → unsupported_media", A("/html"), "unsupported_media");
  await expectCode("HLS playlist served as video/mp4 → unsupported_media", A("/m3u8"), "unsupported_media");
  await expectCode("PNG signature hiding a DASH manifest → unsupported_media", A("/mpd-png"), "unsupported_media");
  await expectCode("DASH manifest after a clean PNG head → whole-file sniff refuses", A("/mpd-late"), "unsupported_media");
  await expectCode("empty body → unsupported_media", A("/empty"), "unsupported_media");
  await expectCode("image for a presenter (video only) → unsupported_media", A("/ok.png"), "unsupported_media", { accept: PRESENTER });

  section("11. upstream failures do not leak");
  await expectCode("404 with secret body → fetch_failed", A("/status/404"), "fetch_failed");
  await expectCode("500 with secret body → fetch_failed", A("/status/500"), "fetch_failed");

  section("12. hygiene");
  {
    // The test entry point can swap the classifier and trust store. App and worker code
    // must only ever call fetchMediaToTempFile.
    const root = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("fetchMediaToTempFileForTests")) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "scripts"));
    const allowed = new Set([path.join("src", "lib", "media-import", "fetch.ts"), path.join("scripts", "verify-media-import-fetch.ts")]);
    const misuse = offenders.filter((f) => !allowed.has(f));
    check("no app or worker code calls fetchMediaToTempFileForTests", misuse.length === 0, JSON.stringify(misuse));
  }
  check("no process warnings (e.g. TLS servername set to an IP)", processWarnings.length === 0, JSON.stringify(processWarnings));
  check("temp dir is empty at the end", tmpEntries().length === 0, JSON.stringify(tmpEntries()));
}

main()
  .catch((err) => {
    failures++;
    console.log(`✗ FAIL unexpected: ${err instanceof Error ? err.stack : String(err)}`);
  })
  .finally(async () => {
    for (const t of dripHeaders) clearInterval(t);
    for (const s of silentSockets) s.destroy();
    for (const server of [serverA, serverB, serverH, serverT]) {
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log(failures === 0 ? `\n✅ ALL ${passed} MEDIA IMPORT FETCH CHECKS PASSED` : `\n❌ ${failures} CHECK(S) FAILED (${passed} passed)`);
    process.exit(failures === 0 ? 0 : 1);
  });
