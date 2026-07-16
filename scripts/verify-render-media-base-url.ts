// Verify STAB-1 media-base-url selection: the render route absolutizes OUR-OWN
// media to this base for the render-worker's Chromium to fetch. The critical
// property is FAIL-SAFE: unset/blank/malformed/non-http env must fall back to the
// proven public baseUrl so a bad env can never break renders; a valid http(s)
// origin must switch media fetches to loopback (bypassing nginx).
//
// Run: npx tsx scripts/verify-render-media-base-url.ts
import { resolveMediaBaseUrl } from "../src/lib/render/media-base-url";

const PUBLIC = "https://studio.heroaiengine.com";
const LOOPBACK = "http://127.0.0.1:3000";

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got=${JSON.stringify(got)}${ok ? "" : ` want=${JSON.stringify(want)}`})`);
  ok ? pass++ : fail++;
}

// --- fail-safe: fall back to baseUrl (byte-identical to pre-STAB-1) ---
check("undefined env -> baseUrl", resolveMediaBaseUrl(PUBLIC, undefined), PUBLIC);
check("null env -> baseUrl", resolveMediaBaseUrl(PUBLIC, null), PUBLIC);
check("empty env -> baseUrl", resolveMediaBaseUrl(PUBLIC, ""), PUBLIC);
check("whitespace env -> baseUrl", resolveMediaBaseUrl(PUBLIC, "   "), PUBLIC);
check("malformed env -> baseUrl", resolveMediaBaseUrl(PUBLIC, "not a url"), PUBLIC);
check("bare host (no scheme) -> baseUrl", resolveMediaBaseUrl(PUBLIC, "127.0.0.1:3000"), PUBLIC);
check("non-http scheme (file:) -> baseUrl", resolveMediaBaseUrl(PUBLIC, "file:///etc/passwd"), PUBLIC);
check("non-http scheme (ftp:) -> baseUrl", resolveMediaBaseUrl(PUBLIC, "ftp://x/y"), PUBLIC);

// --- enabled: switch to the internal loopback base ---
check("loopback env -> loopback", resolveMediaBaseUrl(PUBLIC, LOOPBACK), LOOPBACK);
check("loopback trailing slash trimmed", resolveMediaBaseUrl(PUBLIC, LOOPBACK + "/"), LOOPBACK);
check("localhost host accepted", resolveMediaBaseUrl(PUBLIC, "http://localhost:3000"), "http://localhost:3000");
check("padded value trimmed", resolveMediaBaseUrl(PUBLIC, `  ${LOOPBACK}  `), LOOPBACK);
check("https internal accepted", resolveMediaBaseUrl(PUBLIC, "https://internal:8443"), "https://internal:8443");

// --- onIgnore fires exactly on the fallback branches, not on success ---
let ignores = 0;
resolveMediaBaseUrl(PUBLIC, "not a url", () => ignores++);
resolveMediaBaseUrl(PUBLIC, "file:///x", () => ignores++);
resolveMediaBaseUrl(PUBLIC, LOOPBACK, () => ignores++); // valid -> must NOT fire
check("onIgnore fired only for the 2 invalid values", ignores, 2);

// --- end-to-end: the exact template the route uses to absolutize each media kind ---
// Proves the swap yields loopback URLs when enabled and public URLs when off.
function absolutize(base: string, rel: string) {
  return `${base}${rel}`;
}
const off = resolveMediaBaseUrl(PUBLIC, undefined);
const on = resolveMediaBaseUrl(PUBLIC, LOOPBACK);
check("OFF: stock stays public", absolutize(off, "/api/stocks/s.mp4"), `${PUBLIC}/api/stocks/s.mp4`);
check("OFF: music stays public", absolutize(off, "/api/music/m.mp3"), `${PUBLIC}/api/music/m.mp3`);
check("OFF: render stays public", absolutize(off, "/api/renders/r.mp4"), `${PUBLIC}/api/renders/r.mp4`);
check("ON: stock -> loopback", absolutize(on, "/api/stocks/s.mp4"), `${LOOPBACK}/api/stocks/s.mp4`);
check("ON: music -> loopback", absolutize(on, "/api/music/m.mp3"), `${LOOPBACK}/api/music/m.mp3`);
check("ON: render -> loopback", absolutize(on, "/api/renders/r.mp4"), `${LOOPBACK}/api/renders/r.mp4`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
