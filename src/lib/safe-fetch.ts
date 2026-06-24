import { lookup } from "dns/promises";
import net from "net";

/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * The video pipeline fetches user-provided asset URLs (avatar audio/bg, transcribe
 * audio, scene images). Without a guard a user can point those at internal services
 * (`http://127.0.0.1:<port>`, link-local `169.254.169.254`, private LAN, `file://`)
 * and use the server as an SSRF proxy. We allow only http/https to publicly-routable
 * hosts, and resolve the hostname so a public name that points at a private IP is
 * still rejected (basic DNS-rebinding defense).
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

function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → unsafe
  const [a, b, c] = p;
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

function ipIsPrivate(ip: string): boolean {
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  if (v4mapped) return ipv4IsPrivate(v4mapped[1]);
  if (net.isIPv4(ip)) return ipv4IsPrivate(ip);
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;  // loopback / unspecified
  if (/^fe[89ab]/.test(lower)) return true;            // link-local fe80::/10
  if (/^f[cd]/.test(lower)) return true;               // unique-local fc00::/7
  if (lower.startsWith("ff")) return true;             // multicast ff00::/8
  return false;
}

/**
 * Throws UnsafeUrlError if `rawUrl` is not an http(s) URL to a publicly-routable host.
 * Call this immediately before any `fetch()` of a user-supplied URL.
 */
export async function assertSafeFetchUrl(rawUrl: string): Promise<void> {
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
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
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
export async function isSafeFetchUrl(rawUrl: string): Promise<boolean> {
  try {
    await assertSafeFetchUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
