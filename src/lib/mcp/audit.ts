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
    // T13: an agent media link (replace_broll_window) may carry a signed query token.
    if (typeof o.url === "string") redacted.url = `[redacted ${o.url.length} chars]`;
    // T14: create_video_job's presenter clip link may carry one too (clipUploadId is an
    // owner-scoped import id, not a credential, so it stays readable).
    if (typeof o.clipUrl === "string") redacted.clipUrl = `[redacted ${o.clipUrl.length} chars]`;
    return redacted;
  }
  return v;
}

// Every Unicode control (Cc: C0, DEL, C1) and format character (Cf: bidi embeddings and
// overrides U+202A–202E, isolates U+2066–2069, LRM/RLM, zero-width chars, BOM, soft hyphen),
// plus the line/paragraph separators U+2028/U+2029 (Zl/Zp). Any of them can split or visually
// spoof a log line or an admin view (PR-A security low S2).
const CONTROL_AND_FORMAT_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_USER_AGENT_LEN = 200;

// Client capture (T7, Global Constraints "Security and data" — the audit stores only
// client name, version and user-agent, never secrets/scripts/raw provider bodies/media
// URLs). The User-Agent header is untrusted input controlled by whatever MCP client sent
// it, so strip control characters (CR/LF header-injection-style noise, stray NULs) before
// it ever reaches a stored row or a log line, then cap length — counted in code points, so an
// astral character (a UTF-16 surrogate pair) is kept or dropped whole, never split. A compact
// `<clientName>/<clientVersion> <ua>` string built by a caller goes through the same path
// unchanged — this function doesn't care which shape it was handed.
export function sanitizeUserAgent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(CONTROL_AND_FORMAT_CHARS, "").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, MAX_USER_AGENT_LEN).join("");
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
