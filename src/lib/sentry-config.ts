import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import type * as Sentry from "@sentry/nextjs";
import { isThirdPartyFrontendNoise } from "@/lib/frontend-error-noise";
import {
  consumeEditorDiagnostics,
  EDITOR_DIAGNOSTICS_CONTEXT_KEY,
} from "@/lib/editor-diagnostics";

type SentryDataCollection = NonNullable<
  Parameters<typeof Sentry.init>[0]["dataCollection"]
>;

/** @sentry/nextjs does not re-export TransactionEvent; take it from init's own hook. */
type TransactionEvent = Parameters<
  NonNullable<Parameters<typeof Sentry.init>[0]["beforeSendTransaction"]>
>[0];

const SENSITIVE_KEY =
  /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|private[-_]?key|webhook[-_]?secret)/i;

const URL_KEY = /^(?:url|uri|href|endpoint|callback)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s)\]}>'"]+/g;
const PATH_QUERY_IN_TEXT =
  /(^|\s)(\/[A-Z0-9._~!$&'()*+,;=:@%/-]+)\?[^\s)\]}>'"]+/gi;
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_IN_TEXT = /\b(Bearer\s+)[A-Z0-9._~+/=-]+/gi;
const KNOWN_SECRET_IN_TEXT =
  /\b(?:lin_api_|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|heroai_pat_|heroai_up_)[A-Z0-9_-]+\b/gi;
// The Media Import upload link carries its single-use token as a path segment
// (`/api/mcp-uploads/<token>`, Task 11) — scrub the segment wherever the path shows up. A
// segment starting with a bracket is left alone: that is the route's own `[token]` name (in
// parameterized transaction names and stack-frame file paths) or an already-scrubbed
// `[Filtered]`, so the scrub is idempotent and never breaks source-map lookups.
const MCP_UPLOAD_TOKEN_SEGMENT = /(\/api\/mcp-uploads\/)[^/?#\s"'<>()[\]{}]+/gi;

export const sentryDataCollection: SentryDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: false,
    response: false,
  },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: {
    document: false,
    variables: false,
  },
  genAI: {
    inputs: false,
    outputs: false,
  },
  databaseQueryData: false,
  stackFrameVariables: false,
  frameContextLines: 3,
};

export function parseSentrySampleRate(
  value: string | undefined,
  fallback: number,
): number {
  if (!value?.trim()) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }

  return parsed;
}

/** Pure: replaces the upload-link token segment and any bare upload token with [Filtered]. */
export function redactMcpUploadTokens(value: string): string {
  return value
    .replace(MCP_UPLOAD_TOKEN_SEGMENT, "$1[Filtered]")
    .replace(KNOWN_SECRET_IN_TEXT, "[Filtered]");
}

function withoutQueryString(value: string): string {
  let stripped: string;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    stripped = url.toString();
  } catch {
    const queryStart = value.indexOf("?");
    stripped = queryStart >= 0 ? value.slice(0, queryStart) : value;
  }
  return redactMcpUploadTokens(stripped);
}

export function sanitizeSentryText(value: string): string {
  return redactMcpUploadTokens(
    value
      .replace(URL_IN_TEXT, (url) => withoutQueryString(url))
      .replace(PATH_QUERY_IN_TEXT, "$1$2")
      .replace(EMAIL_IN_TEXT, "[Email]")
      .replace(BEARER_IN_TEXT, "$1[Filtered]"),
  );
}

/** Every string inside `value` passed through redactMcpUploadTokens (depth-bounded, in place). */
function redactUploadTokensDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.includes("mcp-uploads") || value.includes("heroai_up_") ? redactMcpUploadTokens(value) : value;
  }
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = redactUploadTokensDeep(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) record[key] = redactUploadTokensDeep(record[key], depth + 1);
  return value;
}

function sanitizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[Filtered]";
  if (depth > 6) return "[Truncated]";
  if (typeof value === "string") {
    return key && URL_KEY.test(key)
      ? withoutQueryString(value)
      : sanitizeSentryText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, undefined, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeValue(childValue, childKey, depth + 1),
    ]),
  );
}

function errorText(event: ErrorEvent): string {
  return [
    event.message,
    ...(event.exception?.values ?? []).map((exception) => exception.value),
  ]
    .filter(Boolean)
    .join("\n");
}

function frameOrigin(frame: { filename?: string; abs_path?: string }): string {
  return (frame.filename ?? frame.abs_path ?? "").trim();
}

// Errors thrown by extensions and in-app WebView bridges inside a visitor's
// browser. They are not this application's code and nobody can act on them,
// but each new host variant opens a fresh Sentry group and a fresh alert.
function isThirdPartyBrowserNoise(event: ErrorEvent): boolean {
  const frames = (event.exception?.values ?? []).flatMap(
    (exception) => exception.stacktrace?.frames ?? [],
  );
  return isThirdPartyFrontendNoise({
    message: errorText(event),
    filenames: frames.map(frameOrigin),
  });
}

// Clerk's browser SDK reports a failed request to its own hosted API as a
// ClerkJS network error. `clerk.<our domain>` is a CNAME to Clerk's frontend
// API served from their CDN, so no part of that request path is ours: these are
// dropped connections, suspended tabs, ad blockers and VPNs, and each variant
// opens a fresh Sentry group. Only the unattended session keep-alive and token
// refresh are filtered. A failed sign-in or sign-up stays reported, so a Clerk
// outage that blocks people from logging in can never hide behind this rule.
const CLERK_NETWORK_ERROR = /ClerkJS:\s*Network error/i;
const CLERK_SESSION_KEEPALIVE_ENDPOINT =
  /\/v1\/client\/sessions\/[^/"\s]+\/(?:touch|tokens)|\/v1\/client(?=["?\s]|$)/i;
const VISITOR_FETCH_FAILURE =
  /(?:Load failed|Failed to fetch|NetworkError when attempting to fetch resource|The network connection was lost|The Internet connection appears to be offline)/i;

function isClerkSessionKeepAliveNetworkNoise(event: ErrorEvent): boolean {
  const text = errorText(event);

  return (
    CLERK_NETWORK_ERROR.test(text) &&
    CLERK_SESSION_KEEPALIVE_ENDPOINT.test(text) &&
    VISITOR_FETCH_FAILURE.test(text)
  );
}

function isKnownRemotionShutdownNoise(event: ErrorEvent): boolean {
  const text = errorText(event);

  return (
    /ProtocolError/i.test(text) &&
    (/Target\.attachToTarget/i.test(text) ||
      /Target closed/i.test(text) ||
      /remotion\.dev\/docs\/target-closed/i.test(text))
  );
}

export function beforeSendSentryEvent(event: ErrorEvent): ErrorEvent | null {
  if (isKnownRemotionShutdownNoise(event)) return null;
  if (isThirdPartyBrowserNoise(event)) return null;
  if (isClerkSessionKeepAliveNetworkNoise(event)) return null;

  const editorDiagnostics = consumeEditorDiagnostics(event);
  if (event.contexts) delete event.contexts[EDITOR_DIAGNOSTICS_CONTEXT_KEY];

  delete event.user;

  if (event.message) event.message = sanitizeSentryText(event.message);
  if (event.logentry?.message) {
    event.logentry.message = sanitizeSentryText(event.logentry.message);
  }
  if (event.logentry?.params) {
    event.logentry.params = sanitizeValue(event.logentry.params) as unknown[];
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = sanitizeSentryText(exception.value);
  }

  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url
        ? withoutQueryString(event.request.url)
        : undefined,
    };
  }

  if (event.extra) {
    event.extra = sanitizeValue(event.extra) as ErrorEvent["extra"];
  }
  if (event.contexts) {
    event.contexts = sanitizeValue(event.contexts) as ErrorEvent["contexts"];
  }
  if (editorDiagnostics) {
    event.contexts = {
      ...event.contexts,
      [EDITOR_DIAGNOSTICS_CONTEXT_KEY]: editorDiagnostics,
    };
  }
  if (event.tags) {
    event.tags = sanitizeValue(event.tags) as ErrorEvent["tags"];
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(beforeSentryBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }

  // Last pass: the upload-link token must not survive in ANY field (transaction name, trace
  // context, stack-frame metadata...), not just the ones sanitized above.
  return redactUploadTokensDeep(event) as ErrorEvent;
}

/**
 * Performance events (5% of traces) carry the raw request path in the transaction name,
 * request.url and span descriptions/attributes. Only the upload-link token is scrubbed here;
 * everything else in a transaction is left as Sentry recorded it.
 */
export function beforeSendSentryTransaction(event: TransactionEvent): TransactionEvent | null {
  return redactUploadTokensDeep(event) as TransactionEvent;
}

export function beforeSentryBreadcrumb(
  breadcrumb: Breadcrumb,
): Breadcrumb | null {
  if (breadcrumb.category === "console" && breadcrumb.level !== "error") {
    return null;
  }

  if (breadcrumb.message) {
    breadcrumb.message = sanitizeSentryText(breadcrumb.message);
  }
  if (breadcrumb.data) {
    breadcrumb.data = sanitizeValue(breadcrumb.data) as Breadcrumb["data"];
  }

  return breadcrumb;
}
