import { lookup as dnsLookup } from "dns/promises";
import net from "net";

/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * The video pipeline fetches user-provided asset URLs (avatar audio/bg, transcribe
 * audio, scene images). Without a guard a user can point those at internal services
 * (`http://127.0.0.1:<port>`, link-local `169.254.169.254`, private LAN, `file://`)
 * and use the server as an SSRF proxy. We allow only http/https to publicly-routable
 * hosts, and resolve the hostname so a public name that points at a private IP is
 * still rejected (basic DNS-rebinding defense). Every resolved A/AAAA address is
 * checked, not just the first.
 *
 * Addresses are classified from their bytes, never by string shape: an IPv6 literal
 * such as `[::ffff:127.0.0.1]` is re-serialised by the URL parser to `[::ffff:7f00:1]`,
 * and DNS may answer in either form, so both must land on the same decision.
 *
 * IPv6 that carries an IPv4 is judged by the IPv4 the packet actually reaches:
 *   - IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` → the
 *     embedded IPv4 goes through the IPv4 rules (so `::ffff:8.8.8.8` stays allowed);
 *   - IPv4-compatible `::/96` (deprecated) and Teredo `2001::/32` (inside the blocked
 *     `2001::/23`) → refused outright.
 * Anything outside global unicast `2000::/3`, and anything that does not parse as a
 * clean IPv4/IPv6 literal, is refused (fail closed).
 *
 * Out of scope here: this checks names, it does not pin the connection to the checked
 * address, so a DNS answer that changes between this check and `fetch()` is not covered.
 * Media Import (`src/lib/media-import/fetch.ts`) does pin: it resolves once inside the
 * socket's own `lookup` and classifies every answer with `ipIsPrivate` below.
 *
 * Note: legitimate inputs are either app-relative paths (handled by callers before
 * this, never reaching here) or public providers (Pexels/Pixabay/Unsplash/kie/NASA/
 * HeyGen …) — all publicly routable, so this never blocks a real asset.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Resolves a hostname to every A/AAAA address. */
export type ResolveAllAddresses = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export interface SafeFetchUrlOptions {
  /** Test seam. Defaults to `dns.lookup(hostname, { all: true })`. */
  lookup?: ResolveAllAddresses;
}

const defaultLookup: ResolveAllAddresses = (hostname) => dnsLookup(hostname, { all: true });

/** Dotted-quad → 4 bytes, or null. `net.isIPv4` accepts only canonical dotted decimal. */
function parseIPv4(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  const bytes = ip.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return bytes;
}

/** Any textual IPv6 (compressed, full, dotted IPv4 tail) → 16 bytes, or null. */
function parseIPv6(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip;
  // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes its two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    // Rejects zone ids ("fe80::1%eth0") and any other stray character.
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const n = parseInt(group, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function ipv4IsPrivate([a, b, c]: number[]): boolean {
  if (a === 0) return true;                        // 0.0.0.0/8 "this network"
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;// private
  if (a === 192 && b === 168) return true;         // private
  if (a === 100 && b >= 64 && b <= 127) return true;// CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true;// IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true;                       // 224/4 multicast + 240/4 reserved
  return false;
}

function ipv6IsPrivate(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const embeddedV4 = b.slice(12, 16);
  // ::ffff:0:0/96 IPv4-mapped — the socket connects to the embedded IPv4.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4IsPrivate(embeddedV4);
  // ::/96 — unspecified ::, loopback ::1 and deprecated IPv4-compatible ::a.b.c.d.
  if (zero(0, 12)) return true;
  // 64:ff9b::/96 NAT64 well-known prefix — the translator forwards to the embedded IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    return ipv4IsPrivate(embeddedV4);
  }
  // 2002::/16 6to4 — the relay forwards to the IPv4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4IsPrivate(b.slice(2, 6));
  // Only global unicast 2000::/3 is publicly routable. This refuses link-local fe80::/10,
  // site-local fec0::/10, unique-local fc00::/7, multicast ff00::/8, discard 100::/64,
  // NAT64 local-use 64:ff9b:1::/48, IPv4-translated ::ffff:0:0:0/96 and every reserved block.
  if ((b[0] & 0xe0) !== 0x20) return true;
  // 2001::/23 IETF protocol assignments (the IPv6 twin of 192.0.0.0/24), incl. Teredo 2001::/32.
  // /23 = 0x2001 plus the top 7 bits of byte 2, i.e. 2001:0000 – 2001:01ff.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] <= 0x01) return true;
  // 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  return false;
}

/** True unless `ip` is a clean IPv4/IPv6 literal of a publicly-routable host. */
export function ipIsPrivate(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return ipv4IsPrivate(v4);
  const v6 = parseIPv6(ip);
  if (v6) return ipv6IsPrivate(v6);
  return true; // unparseable → unsafe
}

/**
 * Throws UnsafeUrlError if `rawUrl` is not an http(s) URL to a publicly-routable host.
 * Call this immediately before any `fetch()` of a user-supplied URL.
 */
export async function assertSafeFetchUrl(rawUrl: string, options: SafeFetchUrlOptions = {}): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError(`blocked protocol: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new UnsafeUrlError(`blocked private IP: ${host}`);
    return;
  }
  const lookup = options.lookup ?? defaultLookup;
  let addrs: ReadonlyArray<{ address: string }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new UnsafeUrlError(`DNS resolution failed: ${host}`);
  }
  if (!addrs.length) throw new UnsafeUrlError(`no DNS address: ${host}`);
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) {
      throw new UnsafeUrlError(`host resolves to a private IP: ${host} → ${a.address}`);
    }
  }
}

/** Boolean convenience wrapper — true if safe to fetch, false otherwise. */
export async function isSafeFetchUrl(rawUrl: string, options: SafeFetchUrlOptions = {}): Promise<boolean> {
  try {
    await assertSafeFetchUrl(rawUrl, options);
    return true;
  } catch {
    return false;
  }
}
