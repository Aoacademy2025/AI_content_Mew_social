import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import type * as Sentry from "@sentry/nextjs";

type SentryDataCollection = NonNullable<
  Parameters<typeof Sentry.init>[0]["dataCollection"]
>;

const SENSITIVE_KEY =
  /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|private[-_]?key|webhook[-_]?secret)/i;

const URL_KEY = /^(?:url|uri|href|endpoint|callback)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s)\]}>'"]+/g;
const PATH_QUERY_IN_TEXT =
  /(^|\s)(\/[A-Z0-9._~!$&'()*+,;=:@%/-]+)\?[^\s)\]}>'"]+/gi;
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_IN_TEXT = /\b(Bearer\s+)[A-Z0-9._~+/=-]+/gi;
const KNOWN_SECRET_IN_TEXT =
  /\b(?:lin_api_|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|heroai_pat_)[A-Z0-9_-]+\b/gi;

// Stack-frame origins that only ever hold code injected into the page by a
// browser extension or by an in-app WebView host. `app://` with a host
// (app://navigation_performance_logger_android) and `app:///scripts/` are how
// Sentry normalises those injected bundles; our own client frames always
// resolve under `_next`.
const INJECTED_FRAME_ORIGIN =
  /^(?:(?:chrome|moz|safari-web|safari|ms-browser)-extension:\/\/|webkit-masked-url:|app:\/\/[^/]|app:\/\/\/scripts\/)/i;

// Frames that belong to this application, on either runtime.
const APP_FRAME = /(?:\/?_next\/|\.next\/|^node:|\.tsx?(?::\d+)*$)/i;

// Browser APIs this application never calls. `npm run verify:sentry-config`
// asserts the filter; the absence of these APIs in `src/` is what makes
// matching on the message text safe. Re-check before adding an entry.
const FOREIGN_BROWSER_API =
  /(?:Failed to connect to MetaMask|Java object is gone|Java exception was raised during method invocation|window\.webkit\.messageHandlers)/i;

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

function withoutQueryString(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const queryStart = value.indexOf("?");
    return queryStart >= 0 ? value.slice(0, queryStart) : value;
  }
}

export function sanitizeSentryText(value: string): string {
  return value
    .replace(URL_IN_TEXT, (url) => withoutQueryString(url))
    .replace(PATH_QUERY_IN_TEXT, "$1$2")
    .replace(EMAIL_IN_TEXT, "[Email]")
    .replace(BEARER_IN_TEXT, "$1[Filtered]")
    .replace(KNOWN_SECRET_IN_TEXT, "[Filtered]");
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
  if (FOREIGN_BROWSER_API.test(errorText(event))) return true;

  const frames = (event.exception?.values ?? []).flatMap(
    (exception) => exception.stacktrace?.frames ?? [],
  );
  if (frames.length === 0) return false;

  // Positive evidence of injection, and nothing of ours anywhere in the stack.
  const origins = frames.map(frameOrigin);
  return (
    origins.some((origin) => INJECTED_FRAME_ORIGIN.test(origin)) &&
    !origins.some((origin) => APP_FRAME.test(origin))
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
  if (event.tags) {
    event.tags = sanitizeValue(event.tags) as ErrorEvent["tags"];
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(beforeSentryBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }

  return event;
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
