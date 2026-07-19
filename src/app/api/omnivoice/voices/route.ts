import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  isOmniVoiceInfo,
  isOmniVoiceUserAllowed,
  OmniVoiceConfigError,
  omnivoiceAuthHeaders,
  omnivoiceConfig,
} from "@/lib/omnivoice";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOmniVoiceUserAllowed(user.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const config = omnivoiceConfig();
    const response = await fetch(`${config.baseUrl}/voices`, {
      headers: omnivoiceAuthHeaders(config.apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[omnivoice/voices] upstream status=${response.status}`);
      return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน" }, { status: 503 });
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("invalid voices payload");
    const voices = payload
      .filter(isOmniVoiceInfo)
      .map((voice) => ({
        voice_id: voice.voice_id,
        desc: voice.desc.slice(0, 160),
        instruct: voice.instruct.slice(0, 240),
        preview_url: `/api/omnivoice/preview/${encodeURIComponent(voice.voice_id)}`,
      }));
    if (voices.length === 0) throw new Error("no valid voices returned");
    return NextResponse.json(voices, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    if (!(error instanceof OmniVoiceConfigError)) {
      console.error("[omnivoice/voices] request failed:", error instanceof Error ? error.message : error);
    }
    return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน" }, { status: 503 });
  }
}
