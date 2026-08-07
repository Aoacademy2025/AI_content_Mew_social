import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { normalizeTelemetryBatch, recordTelemetryBatch } from "@/lib/telemetry";
import { resolveHeroScriptAccess } from "@/lib/hero-script-rollout.server";

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
    let enrichedEvents = events;
    if (user && events.some((event) => event.name.startsWith("hero_script_"))) {
      const access = await resolveHeroScriptAccess(user).catch(() => null);
      if (access) {
        enrichedEvents = events.map((event) => event.name.startsWith("hero_script_")
          ? {
              ...event,
              properties: {
                ...(event.properties ?? {}),
                cohort: access.cohort,
                entitlementSource: access.entitlementSource,
              },
            }
          : event);
      }
    }
    const result = await recordTelemetryBatch(user?.id ?? null, enrichedEvents);
    return NextResponse.json({ ok: true, count: result.count });
  } catch {
    return NextResponse.json({ ok: true, count: 0 });
  }
}
