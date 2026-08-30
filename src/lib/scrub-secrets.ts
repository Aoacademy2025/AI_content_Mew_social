/**
 * Redact secrets (API keys/tokens) that may have leaked into an error message or
 * stack trace — e.g. an outbound `fetch` to a third-party API whose URL embeds
 * `?key=<secret>` shows up verbatim in the thrown error's `.message`. This runs
 * before anything is written to PM2 console logs or the DB-backed admin
 * notification, so secrets never land in either place.
 *
 * Deliberately its own leaf module with ZERO other imports: `src/lib/api-error.ts`
 * (which re-exports this for backward compatibility) pulls in `clerk-auth.ts` →
 * `@clerk/nextjs/server` / `next/headers`, which breaks under the `--conditions=react-server`
 * node flag several MCP orchestrator verify scripts run under. `orchestrator.ts` needs
 * this exact scrubber (for the specific-failure-code message built in its terminal catch)
 * without dragging that chain in — import it from here, never from `@/lib/api-error`.
 */
export function scrubSecrets(input: string): string {
  if (!input) return input;
  return input
    // query-string style: key=, api_key=, apikey=, access_key=, token=
    .replace(/([?&](?:key|api[_-]?key|access[_-]?key|token)=)[^&\s"'<>]+/gi, "$1<redacted>")
    // Google/Gemini style API keys (AIza...) appearing anywhere, incl. headers
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<redacted>")
    // x-goog-api-key header value if serialized into a message/stack
    .replace(/(x-goog-api-key["'\s:=]+)[A-Za-z0-9_-]{10,}/gi, "$1<redacted>")
    // Authorization: Bearer|Basic <token>
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{10,}=*/gi, "$1<redacted>")
    // OpenRouter style API keys (sk-or-...) appearing anywhere — a bare key
    // without the "Bearer " prefix would slip past the rule above.
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "<redacted>")
    // Stripe secret/restricted keys and webhook signing secrets.
    .replace(/sk_(?:live|test)_[A-Za-z0-9]+/g, "<redacted>")
    .replace(/rk_(?:live|test)_[A-Za-z0-9]+/g, "<redacted>")
    .replace(/whsec_[A-Za-z0-9]+/g, "<redacted>")
    // OpenAI project-scoped keys.
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "<redacted>")
    // RunPod API tokens.
    .replace(/rpa_[A-Za-z0-9]+/g, "<redacted>")
    // Header-style secrets serialized into a message/stack: keep the header name, redact
    // the value only — covers ElevenLabs (xi-api-key), generic (x-api-key), and a raw
    // (schemeless) Authorization header value that the Bearer/Basic rule above would miss.
    // R33: this rule must only fire in a real header/JSON context, or it eats prose — Thai
    // customer copy like "การ authorization: ล้มเหลว กรุณาลองใหม่" was being truncated to
    // "การ authorization: <redacted>". So the header name has to sit at a line start or right
    // after a quote/brace/comma/paren/space, and the VALUE has to look like a token: at least
    // 8 characters of key-ish ASCII with no spaces and no Thai.
    .replace(
      /(^|[\s"'{,(])((?:xi-api-key|x-api-key|authorization)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-.=+/]{8,})/gim,
      "$1$2<redacted>",
    )
    // Absolute server paths — never leak the VPS filesystem layout to a client or log sink.
    .replace(/\/var\/www\/[^\s"']*/g, "<path>");
}
