const SENTRY_ISSUE_ID = /^[1-9]\d{0,19}$/;
const LINEAR_ISSUE_IDENTIFIER = /^HERO-[1-9]\d{0,9}$/i;

type LinkUpdate = {
  sentryIssueId?: string | null;
  linearIssueIdentifier?: string | null;
};

export type SupportObservabilityUpdateResult =
  | { ok: true; data: LinkUpdate }
  | {
      ok: false;
      field: "sentryIssueId" | "linearIssueIdentifier";
      error: string;
    };

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function normalizeSentryIssueReference(value: string): string | null {
  const input = value.trim();
  if (SENTRY_ISSUE_ID.test(input)) return input;

  const url = parseHttpsUrl(input);
  if (!url) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let candidate: string | undefined;

  if (url.hostname === "mew-social-k0.sentry.io") {
    if (parts[0] === "issues") candidate = parts[1];
  } else if (url.hostname === "sentry.io") {
    if (
      parts[0] === "organizations" &&
      parts[1] === "mew-social-k0" &&
      parts[2] === "issues"
    ) {
      candidate = parts[3];
    }
  }

  return candidate && SENTRY_ISSUE_ID.test(candidate) ? candidate : null;
}

export function normalizeLinearIssueReference(value: string): string | null {
  const input = value.trim();
  if (LINEAR_ISSUE_IDENTIFIER.test(input)) return input.toUpperCase();

  const url = parseHttpsUrl(input);
  if (!url || url.hostname !== "linear.app") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "mew-social" ||
    parts[1] !== "issue" ||
    !LINEAR_ISSUE_IDENTIFIER.test(parts[2] ?? "")
  ) {
    return null;
  }
  return parts[2]!.toUpperCase();
}

function parseOptionalReference(
  value: unknown,
  normalize: (input: string) => string | null,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  const normalized = normalize(trimmed);
  return normalized ? { ok: true, value: normalized } : { ok: false };
}

export function parseSupportObservabilityUpdate(
  input: Record<string, unknown>,
): SupportObservabilityUpdateResult {
  const sentry = parseOptionalReference(
    input.sentryIssueId,
    normalizeSentryIssueReference,
  );
  if (!sentry.ok) {
    return {
      ok: false,
      field: "sentryIssueId",
      error: "sentryIssueId must be a HERO Studio Sentry issue ID or URL",
    };
  }

  const linear = parseOptionalReference(
    input.linearIssueIdentifier,
    normalizeLinearIssueReference,
  );
  if (!linear.ok) {
    return {
      ok: false,
      field: "linearIssueIdentifier",
      error: "linearIssueIdentifier must be a HERO issue identifier or URL",
    };
  }

  return {
    ok: true,
    data: {
      sentryIssueId: sentry.value,
      linearIssueIdentifier: linear.value,
    },
  };
}

export function buildSupportObservabilityLinks(input: {
  sentryIssueId: string | null;
  linearIssueIdentifier: string | null;
}) {
  return {
    sentryIssueUrl:
      input.sentryIssueId && SENTRY_ISSUE_ID.test(input.sentryIssueId)
        ? `https://mew-social-k0.sentry.io/issues/${input.sentryIssueId}/`
        : null,
    linearIssueUrl:
      input.linearIssueIdentifier &&
      LINEAR_ISSUE_IDENTIFIER.test(input.linearIssueIdentifier)
        ? `https://linear.app/mew-social/issue/${input.linearIssueIdentifier.toUpperCase()}`
        : null,
  };
}
