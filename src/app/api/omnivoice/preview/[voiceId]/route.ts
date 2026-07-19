import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  isOmniVoiceUserAllowed,
  isValidOmniVoiceId,
  OmniVoiceConfigError,
  omnivoiceAuthHeaders,
  omnivoiceConfig,
} from "@/lib/omnivoice";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ voiceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOmniVoiceUserAllowed(user.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { voiceId } = await context.params;
  if (!isValidOmniVoiceId(voiceId)) return NextResponse.json({ error: "Invalid voice" }, { status: 400 });

  try {
    const config = omnivoiceConfig();
    const response = await fetch(`${config.baseUrl}/voices/${encodeURIComponent(voiceId)}/preview`, {
      headers: omnivoiceAuthHeaders(config.apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: response.status === 404 ? "ไม่พบเสียงที่เลือก" : "Hero Voice ยังไม่พร้อมใช้งาน" },
        { status: response.status === 404 ? 404 : 503 },
      );
    }
    return new NextResponse(response.body, {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (!(error instanceof OmniVoiceConfigError)) {
      console.error("[omnivoice/preview] request failed:", error instanceof Error ? error.message : error);
    }
    return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน" }, { status: 503 });
  }
}
