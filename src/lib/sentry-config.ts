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

function sanitizeText(value: string): string {
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
      : sanitizeText(value);
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

function isKnownRemotionShutdownNoise(event: ErrorEvent): boolean {
  const text = [
    event.message,
    ...(event.exception?.values ?? []).map((exception) => exception.value),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    /ProtocolError/i.test(text) &&
    (/Target\.attachToTarget/i.test(text) ||
      /Target closed/i.test(text) ||
      /remotion\.dev\/docs\/target-closed/i.test(text))
  );
}

export function beforeSendSentryEvent(event: ErrorEvent): ErrorEvent | null {
  if (isKnownRemotionShutdownNoise(event)) return null;

  delete event.user;

  if (event.message) event.message = sanitizeText(event.message);
  if (event.logentry?.message) {
    event.logentry.message = sanitizeText(event.logentry.message);
  }
  if (event.logentry?.params) {
    event.logentry.params = sanitizeValue(event.logentry.params) as unknown[];
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = sanitizeText(exception.value);
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
    breadcrumb.message = sanitizeText(breadcrumb.message);
  }
  if (breadcrumb.data) {
    breadcrumb.data = sanitizeValue(breadcrumb.data) as Breadcrumb["data"];
  }

  return breadcrumb;
}
