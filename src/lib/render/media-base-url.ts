// STAB-1 (2026-07-17): choose the base URL used to absolutize OUR-OWN render media
// (stock videos, music, renders, scene images, logo, voice, bgm, subtitle video)
// that the render-worker's headless Chromium fetches DURING a render.
//
// Default: the public `baseUrl` (NEXTAUTH_URL / request host), so the worker
// round-trips back through nginx — the hop that returned 503s mid-render in the
// 2026-07-16 audit (§5) and loads render media I/O onto nginx during spikes.
//
// When RENDER_INTERNAL_BASE_URL is set to a valid http/https origin (recommended
// "http://127.0.0.1:3000"), media is absolutized to that loopback address instead,
// so the worker fetches straight from ai-content and never touches nginx for media.
//
// Fail-safe: a missing/blank/malformed/non-http value falls back to `baseUrl`
// (the proven-working path) and is logged — a bad env can never produce malformed
// media URLs that would break renders. Unset => returns baseUrl unchanged
// (byte-identical to pre-STAB-1 behavior).
export function resolveMediaBaseUrl(
  baseUrl: string,
  rawInternalBase: string | undefined | null,
  onIgnore?: (reason: string) => void,
): string {
  const raw = rawInternalBase?.trim();
  if (!raw) return baseUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    onIgnore?.(`malformed URL: ${raw}`);
    return baseUrl;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    onIgnore?.(`not http/https: ${raw}`);
    return baseUrl;
  }
  return raw.replace(/\/$/, "");
}
