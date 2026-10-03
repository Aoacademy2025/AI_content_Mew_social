// Media Import guarded fetch (PR-B, Task 10, G23, ADR 0065).
//
// Downloads an agent-supplied URL, from any public HTTPS host, to a private temp file
// for the Media Import pipeline: T9's broll-pipeline.ts / presenter-checks.ts, run by
// the T12 import lane. The URL is attacker-chosen, so this module is an SSRF and
// resource-exhaustion boundary. Every rule below is load-bearing:
//
//   • `https:` only, on every hop. Anything else → url_not_https.
//   • Port 443 only, on every hop. Any other explicit port → url_not_public: the VPS
//     reaching its own public IP travels over `lo`, which the firewall allows, so an
//     arbitrary port would reach services bound to 0.0.0.0 behind nginx's back.
//   • The host's own interface addresses (os.networkInterfaces(), re-read every 10 s;
//     IPv4-mapped forms included) are refused like private ones, before the connect and
//     again on the peer → url_not_public.
//   • Pinned connect. Each hop resolves its hostname ONCE, inside the socket's own
//     `lookup` (the https.request option, which runs at connect time). Every answer is
//     classified with safe-fetch's `ipIsPrivate` (hardened in PR-0: IPv4-mapped incl.
//     hex, IPv4-compatible, NAT64, 6to4, Teredo). One private answer refuses the whole
//     host. The socket connects only to the answers that were classified, so a rebinding
//     resolver never gets a second question. IP-literal hosts skip DNS and are
//     classified directly. Once TCP connects, the peer address is classified again,
//     before any HTTP byte is sent.
//   • TLS is verified against the URL's hostname (SNI + certificate), never the IP.
//   • Redirects are manual: at most 5, each hop re-parsed and re-validated as above.
//   • Byte cap per detected kind: refused on Content-Length, and enforced while
//     streaming. The socket is destroyed mid-body the moment the cap is crossed.
//   • Connect timeout 10 s (DNS + TCP + TLS), idle-read timeout 30 s, and a total
//     wall-clock deadline of 10 min across every hop and the body, which a slow-loris
//     drip (headers or body) cannot outlast.
//   • The leading bytes pick the kind (media-probe-args sniffers), never Content-Type or
//     the URL's extension. The whole file is sniffed again before it is returned.
//     ffprobe in the T9 pipeline stays the final type check (G22).
//   • Errors carry a fixed code and nothing else: no upstream text, IP, hostname, port
//     or path, and no `cause`. This module logs nothing.
//   • The temp file (mode 0600, server-generated name) is removed on every failure. On
//     success the caller owns it and must move or delete it. By default it lives in a
//     dedicated folder, mediaImportTempDir() (0700, owned by this uid). A crash can still
//     leave files there; the import worker calls sweepStaleImportTemp() at start.
//
// Callers pass the byte cap for each kind they accept. B-roll: broll-pipeline's
// MAX_BROLL_IMAGE_BYTES / MAX_BROLL_VIDEO_BYTES. Presenter clip: video only, 500 MB,
// the same as upload-avatar.
import fs from "fs";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "dns";
import { Transform, type TransformCallback } from "stream";
import { pipeline } from "stream/promises";
import type { ClientRequest, IncomingMessage } from "http";
import { ipIsPrivate, type ResolveAllAddresses } from "@/lib/safe-fetch";
import { sniffMediaBuffer, sniffMediaFile, type MediaContainer } from "@/lib/media-probe-args";

export const MEDIA_FETCH_ERROR_CODES = [
  "url_not_https",
  "url_not_public",
  "too_many_redirects",
  "file_too_large",
  "unsupported_media",
  "fetch_failed",
  "fetch_timeout",
] as const;
export type MediaFetchErrorCode = (typeof MEDIA_FETCH_ERROR_CODES)[number];

/** The only error this module throws for a bad URL or a failed download. Message = code. */
export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;
  constructor(code: MediaFetchErrorCode) {
    super(code);
    this.name = "MediaFetchError";
    this.code = code;
  }
}

export const MEDIA_FETCH_MAX_REDIRECTS = 5;
export const MEDIA_FETCH_CONNECT_TIMEOUT_MS = 10_000;
export const MEDIA_FETCH_IDLE_TIMEOUT_MS = 30_000;
export const MEDIA_FETCH_DEADLINE_MS = 10 * 60_000;

const MAX_URL_LENGTH = 4096;
const HTTPS_PORT = 443;
const OWN_ADDRESS_TTL_MS = 10_000;
const TEMP_DIR_NAME = "hero-media-import";
// Exactly the names saveBody creates: a .part while streaming, then the sniffed extension.
const TEMP_FILE_NAME = /^media-import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(part|jpg|png|webp|mp4|webm)$/;
// Enough leading bytes for every signature media-probe-args knows (12 for WebP/RIFF).
const SNIFF_HEAD_BYTES = 64;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "HeroAI-MediaImport/1.0 (+https://studio.heroaiengine.com)";

export type MediaFetchKind = "image" | "video";
export type MediaFetchExt = "jpg" | "png" | "webp" | "mp4" | "webm";

// The containers Media Import accepts, by kind (G22: jpg/png/webp images, mp4/mov/webm
// video). A QuickTime .mov is ISO-BMFF too and is saved as .mp4 (same mov demuxer).
const ACCEPTED_CONTAINERS: Partial<Record<MediaContainer, { kind: MediaFetchKind; ext: MediaFetchExt; mime: string }>> = {
  jpeg: { kind: "image", ext: "jpg", mime: "image/jpeg" },
  png: { kind: "image", ext: "png", mime: "image/png" },
  webp: { kind: "image", ext: "webp", mime: "image/webp" },
  isobmff: { kind: "video", ext: "mp4", mime: "video/mp4" },
  matroska: { kind: "video", ext: "webm", mime: "video/webm" },
};

export interface MediaFetchOptions {
  /** The kinds this import accepts, each with its byte cap. The file's bytes pick the kind. */
  accept: Partial<Record<MediaFetchKind, number>>;
  /** Shortens the 10-min total deadline (e.g. to the import's `deadlineAt`). Never lengthens it. */
  deadlineMs?: number;
  /** Directory for the temp file. Default: mediaImportTempDir(). */
  tmpDir?: string;
}

export interface FetchedMedia {
  /** Temp file (0600) holding the body. The caller owns it from here. */
  path: string;
  kind: MediaFetchKind;
  ext: MediaFetchExt;
  mime: string;
  bytes: number;
}

/** Seams for scripts/verify-media-import-fetch.ts only. App code never passes these. */
export interface MediaFetchTestHooks {
  /** DNS. Default: dns.lookup(hostname, { all: true }). */
  resolve?: ResolveAllAddresses;
  /** Address classifier. Default: safe-fetch's ipIsPrivate. */
  isPrivateAddress?: (ip: string) => boolean;
  /** This host's own addresses, read at every check. Default: os.networkInterfaces(), cached 10 s. */
  ownAddresses?: () => string[];
  /** Ports allowed instead of 443 (test servers cannot bind 443). */
  allowedPorts?: number[];
  /** Extra trust anchor (a test server's self-signed cert). */
  ca?: string | Buffer;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Replaces the 10-min deadline (options.deadlineMs can still shorten it). */
  deadlineMs?: number;
}

/** Fetch `url` to a temp file under the G23 guard. Throws MediaFetchError on any refusal. */
export function fetchMediaToTempFile(url: string, options: MediaFetchOptions): Promise<FetchedMedia> {
  return fetchMedia(url, options, {});
}

/** Test entry point: the same code path with injected DNS, classifier, CA and timers. */
export function fetchMediaToTempFileForTests(
  url: string,
  options: MediaFetchOptions,
  hooks: MediaFetchTestHooks,
): Promise<FetchedMedia> {
  return fetchMedia(url, options, hooks);
}

/** The dedicated folder Media Import downloads into by default. */
export function mediaImportTempDir(): string {
  return path.join(os.tmpdir(), TEMP_DIR_NAME);
}

/**
 * Delete Media Import temp files (in-flight `.part` or finished-but-unclaimed) last
 * modified more than `olderThanMs` ago, left behind by a crash or restart. Only names this
 * module creates, only regular files, never recursing. Call at import-worker start with
 * at least the import deadline. Returns how many files were removed.
 */
export function sweepStaleImportTemp(olderThanMs: number, dir: string = mediaImportTempDir()): number {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw new TypeError("sweepStaleImportTemp: olderThanMs must be >= 0");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // nothing downloaded yet
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of names) {
    if (!TEMP_FILE_NAME.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      fs.unlinkSync(full);
      removed++;
    } catch {}
  }
  return removed;
}

/** Create the default temp folder; refuse one that is a symlink or someone else's. */
function ensureDefaultTempDir(): string {
  const dir = mediaImportTempDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new MediaFetchError("fetch_failed");
  return dir;
}

let ownAddressCache: { at: number; list: net.BlockList } | null = null;

function blockListOf(addresses: Iterable<string>): net.BlockList {
  const list = new net.BlockList();
  for (const address of addresses) {
    const family = net.isIP(address);
    if (!family) continue;
    try {
      list.addAddress(address, family === 6 ? "ipv6" : "ipv4");
    } catch {}
  }
  return list;
}

function interfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address));
}

/** True when `ip` (any textual form, IPv4-mapped included) is one of this host's addresses. */
function hostOwnsAddress(ip: string, ownAddresses: MediaFetchTestHooks["ownAddresses"]): boolean {
  const family = net.isIP(ip);
  if (!family) return true;
  try {
    let list: net.BlockList;
    if (ownAddresses) {
      list = blockListOf(ownAddresses());
    } else {
      const now = Date.now();
      if (!ownAddressCache || now - ownAddressCache.at > OWN_ADDRESS_TTL_MS) {
        ownAddressCache = { at: now, list: blockListOf(interfaceAddresses()) };
      }
      list = ownAddressCache.list;
    }
    return list.check(ip, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return true; // cannot tell → refuse
  }
}

interface Ctx {
  resolve: ResolveAllAddresses;
  isPrivate: (ip: string) => boolean;
  /** This host's own addresses (hairpin over `lo`). */
  isOwn: (ip: string) => boolean;
  allowedPorts: ReadonlySet<number>;
  ca?: string | Buffer;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /** The first timer or guard that fired. It wins over the generic error it causes. */
  failure: MediaFetchErrorCode | null;
  /** The in-flight request, destroyed by the total deadline. */
  current: ClientRequest | null;
}

const defaultResolve: ResolveAllAddresses = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });

const noop = () => {};

async function fetchMedia(rawUrl: string, options: MediaFetchOptions, hooks: MediaFetchTestHooks): Promise<FetchedMedia> {
  const caps = validateAccept(options.accept);
  const requested = typeof options.deadlineMs === "number" && Number.isFinite(options.deadlineMs)
    ? Math.max(0, options.deadlineMs)
    : Infinity;
  const deadlineMs = Math.min(hooks.deadlineMs ?? MEDIA_FETCH_DEADLINE_MS, requested);

  const ctx: Ctx = {
    resolve: hooks.resolve ?? defaultResolve,
    isPrivate: hooks.isPrivateAddress ?? ipIsPrivate,
    isOwn: (ip) => hostOwnsAddress(ip, hooks.ownAddresses),
    allowedPorts: new Set(hooks.allowedPorts ?? [HTTPS_PORT]),
    ca: hooks.ca,
    connectTimeoutMs: hooks.connectTimeoutMs ?? MEDIA_FETCH_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: hooks.idleTimeoutMs ?? MEDIA_FETCH_IDLE_TIMEOUT_MS,
    failure: null,
    current: null,
  };
  const deadline = setTimeout(() => {
    ctx.failure ??= "fetch_timeout";
    ctx.current?.destroy(new MediaFetchError("fetch_timeout"));
  }, deadlineMs);

  try {
    let url = parseHttpsUrl(rawUrl);
    const tmpDir = options.tmpDir ?? ensureDefaultTempDir();
    for (let redirects = 0; ; redirects++) {
      if (ctx.failure) throw new MediaFetchError(ctx.failure);
      const { req, res } = await openHop(url, ctx);
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        const location = res.headers.location;
        req.destroy();
        if (!location) throw new MediaFetchError("fetch_failed");
        if (redirects >= MEDIA_FETCH_MAX_REDIRECTS) throw new MediaFetchError("too_many_redirects");
        url = parseHttpsUrl(location, url);
        continue;
      }
      if (status !== 200) {
        req.destroy();
        throw new MediaFetchError("fetch_failed");
      }
      return await saveBody(res, caps, tmpDir);
    }
  } catch (error) {
    ctx.current?.destroy();
    // Always a fresh error: Node may have decorated the one it carried with host/port.
    throw new MediaFetchError(error instanceof MediaFetchError ? error.code : ctx.failure ?? "fetch_failed");
  } finally {
    clearTimeout(deadline);
  }
}

function validateAccept(accept: MediaFetchOptions["accept"]): Map<MediaFetchKind, number> {
  const caps = new Map<MediaFetchKind, number>();
  for (const kind of ["image", "video"] as const) {
    const cap = accept?.[kind];
    if (cap === undefined) continue;
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new TypeError(`media fetch: invalid ${kind} byte cap`);
    caps.set(kind, cap);
  }
  if (caps.size === 0) throw new TypeError("media fetch: accept names no kind");
  return caps;
}

function parseHttpsUrl(raw: unknown, base?: URL): URL {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) throw new MediaFetchError("url_not_https");
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new MediaFetchError("url_not_https");
  }
  if (url.protocol !== "https:" || !url.hostname) throw new MediaFetchError("url_not_https");
  return url;
}

/** Resolve once and classify every answer. Any private or own answer refuses the whole host. */
async function resolveVetted(host: string, ctx: Ctx): Promise<LookupAddress[]> {
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await ctx.resolve(host);
  } catch {
    throw new MediaFetchError("fetch_failed");
  }
  if (!answers.length) throw new MediaFetchError("fetch_failed");
  const vetted: LookupAddress[] = [];
  for (const { address } of answers) {
    const family = net.isIP(address);
    if (family === 0 || ctx.isPrivate(address) || ctx.isOwn(address)) throw new MediaFetchError("url_not_public");
    vetted.push({ address, family });
  }
  return vetted;
}

function wantedFamily(family: LookupOptions["family"]): 0 | 4 | 6 {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

/** One request/response hop. Resolves once the response headers are in. */
function openHop(url: URL, ctx: Ctx): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  // WHATWG drops an explicit :443, so `url.port` is "" for the only port production allows.
  const port = url.port ? Number(url.port) : HTTPS_PORT;
  if (!ctx.allowedPorts.has(port)) return Promise.reject(new MediaFetchError("url_not_public"));
  if (net.isIP(host) && (ctx.isPrivate(host) || ctx.isOwn(host))) return Promise.reject(new MediaFetchError("url_not_public"));

  // Called by the socket at connect time (net skips it for IP literals). The answer is
  // memoised, so even a second call never reaches the resolver again.
  let vetted: Promise<LookupAddress[]> | null = null;
  const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
    if (hostname !== host) return callback(new MediaFetchError("url_not_public"), "");
    vetted ??= resolveVetted(host, ctx);
    vetted
      .then(
        (list) => {
          const family = wantedFamily(lookupOptions.family);
          const usable = family ? list.filter((a) => a.family === family) : list;
          if (!usable.length) return callback(new MediaFetchError("fetch_failed"), "");
          if (lookupOptions.all) callback(null, usable);
          else callback(null, usable[0].address, usable[0].family);
        },
        (error: Error) => callback(error, ""),
      )
      // A throw inside net's callback must not become an unhandled rejection (which ends
      // the worker process); fail this request instead.
      .catch(() => ctx.current?.destroy(new MediaFetchError("fetch_failed")));
  };

  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: "https:",
      hostname: host,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "image/*, video/*", "accept-encoding": "identity" },
      agent: false, // a fresh socket per hop: no pooling, no proxy, no reuse across hosts
      lookup,
      ca: ctx.ca,
    });
    ctx.current = req;
    const fail = (code: MediaFetchErrorCode) => {
      ctx.failure ??= code;
      req.destroy(new MediaFetchError(code));
    };
    const connectTimer = setTimeout(() => fail("fetch_timeout"), ctx.connectTimeoutMs);
    req.once("socket", (socket) => {
      socket.once("connect", () => {
        // The peer must be an address we would have allowed. This runs before the TLS
        // handshake finishes, so no HTTP byte has gone out yet.
        const peer = socket.remoteAddress;
        if (!peer || ctx.isPrivate(peer) || ctx.isOwn(peer)) fail("url_not_public");
      });
      socket.once("secureConnect", () => clearTimeout(connectTimer));
    });
    req.setTimeout(ctx.idleTimeoutMs, () => fail("fetch_timeout"));
    req.on("error", (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    req.once("close", () => clearTimeout(connectTimer));
    req.once("response", (res) => {
      clearTimeout(connectTimer);
      // Surfaced through the body stream (or ignored after a redirect); never unhandled.
      res.on("error", noop);
      resolve({ req, res });
    });
    req.end();
  });
}

function declaredLength(header: string | undefined): number | null {
  if (!header || !/^\s*\d+\s*$/.test(header)) return null;
  return Number(header);
}

/** Stream the 200 body to a temp file under the byte cap; sniff the kind from its bytes. */
async function saveBody(res: IncomingMessage, caps: Map<MediaFetchKind, number>, tmpDir: string): Promise<FetchedMedia> {
  const maxCap = Math.max(...caps.values());
  const declared = declaredLength(res.headers["content-length"]);
  if (declared !== null && declared > maxCap) throw new MediaFetchError("file_too_large");

  let received = 0;
  let cap = maxCap;
  let head: Buffer[] = [];
  let headBytes = 0;
  let type: { container: MediaContainer; kind: MediaFetchKind; ext: MediaFetchExt; mime: string } | null = null;

  const decide = (bytes: Buffer) => {
    const container = sniffMediaBuffer(bytes);
    const accepted = container ? ACCEPTED_CONTAINERS[container] : undefined;
    const kindCap = accepted ? caps.get(accepted.kind) : undefined;
    if (!container || !accepted || kindCap === undefined) throw new MediaFetchError("unsupported_media");
    cap = kindCap;
    if ((declared !== null && declared > cap) || received > cap) throw new MediaFetchError("file_too_large");
    type = { container, ...accepted };
  };
  // Counts and caps every byte; holds the first SNIFF_HEAD_BYTES until the kind is known.
  const gate = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      received += chunk.length;
      if (received > cap) return callback(new MediaFetchError("file_too_large"));
      if (type) return callback(null, chunk);
      head.push(chunk);
      headBytes += chunk.length;
      if (headBytes < SNIFF_HEAD_BYTES) return callback();
      const bytes = Buffer.concat(head);
      head = [];
      try {
        decide(bytes);
      } catch (error) {
        return callback(error as Error);
      }
      callback(null, bytes);
    },
    flush(callback: TransformCallback) {
      if (type) return callback();
      const bytes = Buffer.concat(head);
      try {
        decide(bytes);
      } catch (error) {
        return callback(error as Error);
      }
      callback(null, bytes);
    },
  });

  const partPath = path.join(tmpDir, `media-import-${randomUUID()}.part`);
  const out = fs.createWriteStream(partPath, { flags: "wx", mode: 0o600 });
  let opened = false;
  out.once("open", () => { opened = true; });
  const removePart = async () => {
    // Wait for the stream to close: an fd still opening would recreate the file after unlink.
    if (!out.closed) await new Promise<void>((resolve) => out.once("close", () => resolve()));
    // Never remove a file this call did not create (the exclusive open failed).
    if (opened) try { fs.unlinkSync(partPath); } catch {}
  };

  try {
    await pipeline(res, gate, out);
  } catch (error) {
    await removePart();
    throw error;
  }

  const sniffed = type as { container: MediaContainer; kind: MediaFetchKind; ext: MediaFetchExt; mime: string } | null;
  // The whole file, not just its head: a DASH/IMF manifest marker anywhere in ffmpeg's
  // 1 MiB probe window also refuses it.
  if (!sniffed || sniffMediaFile(partPath) !== sniffed.container) {
    await removePart();
    throw new MediaFetchError("unsupported_media");
  }
  const finalPath = path.join(tmpDir, `media-import-${randomUUID()}.${sniffed.ext}`);
  try {
    fs.renameSync(partPath, finalPath);
  } catch {
    await removePart();
    throw new MediaFetchError("fetch_failed");
  }
  return { path: finalPath, kind: sniffed.kind, ext: sniffed.ext, mime: sniffed.mime, bytes: received };
}
