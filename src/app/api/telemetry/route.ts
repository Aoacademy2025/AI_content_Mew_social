import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { normalizeTelemetryBatch, recordTelemetryBatch } from "@/lib/telemetry";

export const runtime = "nodejs";

async function readTelemetryPayload(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await req.json().catch(() => null);
  }

  const text = await req.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const payload = await readTelemetryPayload(req);
    const events = normalizeTelemetryBatch(payload);
    if (events.length === 0) return NextResponse.json({ ok: true, count: 0 });

    const user = await getCurrentUser().catch(() => null);
    const result = await recordTelemetryBatch(user?.id ?? null, events);
    return NextResponse.json({ ok: true, count: result.count });
  } catch {
    return NextResponse.json({ ok: true, count: 0 });
  }
}
