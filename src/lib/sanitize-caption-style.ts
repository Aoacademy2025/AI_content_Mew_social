// Reject CSS values that could trigger an outbound fetch (SSRF-lite via `url()`) or
// other CSS escalation from the render-time Chromium. `customCaptionStyle` arrives
// UNVALIDATED from the render API (and the MCP client), then flows into Remotion inline
// styles. Preset/generated styles are `url()`-free, so this only ever strips
// attacker-injected values — degrading gracefully to "no style" rather than rejecting.
const DANGEROUS_CSS = /url\s*\(|expression\s*\(|@import|javascript:/i;

export function stripDangerousCss<T>(value: T): T {
  if (typeof value === "string") {
    return (DANGEROUS_CSS.test(value) ? "" : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripDangerousCss(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripDangerousCss(v);
    }
    return out as unknown as T;
  }
  return value;
}
