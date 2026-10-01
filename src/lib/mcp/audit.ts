import { prisma } from "@/lib/prisma";

// Does a tool result represent a real in-band error?
// A success payload may legitimately carry an `error` KEY whose value is null
// (e.g. get_video_status's job branch returns `error: job.errorMessage ?? null`).
// We must classify by VALUE (non-null), not by key presence — otherwise every
// successful job-status poll is mislabeled "error" in the audit log.
export function isInBandError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { error?: unknown }).error != null
  );
}

// Redact bulky/sensitive fields before persisting. The user's full script is private
// content (PII / draft IP) — store only its length, never the body.
function redactRequest(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const redacted = { ...o };
    if (typeof o.script === "string") redacted.script = `[redacted ${o.script.length} chars]`;
    if (typeof o.narrativeSource === "string") {
      redacted.narrativeSource = `[redacted ${o.narrativeSource.length} chars]`;
    }
    return redacted;
  }
  return v;
}

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const MAX_USER_AGENT_LEN = 200;

// Client capture (T7, Global Constraints "Security and data" — the audit stores only
// client name, version and user-agent, never secrets/scripts/raw provider bodies/media
// URLs). The User-Agent header is untrusted input controlled by whatever MCP client sent
// it, so strip control characters (CR/LF header-injection-style noise, stray NULs) before
// it ever reaches a stored row or a log line, then cap length. A compact
// `<clientName>/<clientVersion> <ua>` string built by a caller goes through the same path
// unchanged — this function doesn't care which shape it was handed.
export function sanitizeUserAgent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_USER_AGENT_LEN);
}

export async function recordToolCall(entry: {
  userId?: string | null;
  toolName: string;
  status: "ok" | "denied" | "error";
  durationMs?: number;
  requestJson?: unknown;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await prisma.toolCallAudit.create({
      data: {
        userId: entry.userId ?? null,
        toolName: entry.toolName,
        status: entry.status,
        durationMs: entry.durationMs ?? null,
        requestJson: entry.requestJson ? JSON.stringify(redactRequest(entry.requestJson)).slice(0, 4000) : null,
        userAgent: sanitizeUserAgent(entry.userAgent),
      },
    });
  } catch {
    // audit must never break a tool call
  }
}
