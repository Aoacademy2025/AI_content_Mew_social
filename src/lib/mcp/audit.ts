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

export async function recordToolCall(entry: {
  userId?: string | null;
  toolName: string;
  status: "ok" | "denied" | "error";
  durationMs?: number;
  requestJson?: unknown;
}): Promise<void> {
  try {
    await prisma.toolCallAudit.create({
      data: {
        userId: entry.userId ?? null,
        toolName: entry.toolName,
        status: entry.status,
        durationMs: entry.durationMs ?? null,
        requestJson: entry.requestJson ? JSON.stringify(redactRequest(entry.requestJson)).slice(0, 4000) : null,
      },
    });
  } catch {
    // audit must never break a tool call
  }
}
