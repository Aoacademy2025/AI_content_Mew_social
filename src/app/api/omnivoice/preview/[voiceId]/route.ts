import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { omnivoiceBaseUrl, omnivoiceAuthHeaders, isValidOmniVoiceId } from "@/lib/omnivoice";

export const runtime = "nodejs";

// GET /api/omnivoice/preview/[voiceId] — proxy ไฟล์เสียงตัวอย่าง (audio/wav)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ voiceId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { voiceId } = await params;
  if (!isValidOmniVoiceId(voiceId)) {
    return NextResponse.json({ error: "voice_id ไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const res = await fetch(`${omnivoiceBaseUrl()}/voices/${voiceId}/preview`, {
      headers: omnivoiceAuthHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `OmniVoice ตอบ ${res.status}` }, { status: res.status === 404 ? 404 : 502 });
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    console.error("[omnivoice/preview] fetch failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "เชื่อมต่อ OmniVoice server ไม่ได้" }, { status: 503 });
  }
}
