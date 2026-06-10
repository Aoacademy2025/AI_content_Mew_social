import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { normalizeTelemetryBatch, recordTelemetryBatch } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const payload = await req.json().catch(() => null);
    const events = normalizeTelemetryBatch(payload);
    if (events.length === 0) return NextResponse.json({ ok: true, count: 0 });

    const user = await getCurrentUser().catch(() => null);
    const result = await recordTelemetryBatch(user?.id ?? null, events);
    return NextResponse.json({ ok: true, count: result.count });
  } catch {
    return NextResponse.json({ ok: true, count: 0 });
  }
}
