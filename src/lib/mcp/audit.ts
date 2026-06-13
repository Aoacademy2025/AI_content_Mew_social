import { prisma } from "@/lib/prisma";

// Redact bulky/sensitive fields before persisting. The user's full script is private
// content (PII / draft IP) — store only its length, never the body.
function redactRequest(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.script === "string") return { ...o, script: `[redacted ${o.script.length} chars]` };
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
