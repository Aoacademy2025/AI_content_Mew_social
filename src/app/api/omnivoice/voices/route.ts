import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { omnivoiceBaseUrl, type OmniVoiceInfo } from "@/lib/omnivoice";

export const runtime = "nodejs";

// GET /api/omnivoice/voices — proxy รายการเสียงจาก OmniVoice server
// preview_url ถูกเขียนใหม่ให้ชี้ผ่าน proxy ของเรา (client ไม่เห็น/ไม่ต้องถึง host ภายใน)
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const res = await fetch(`${omnivoiceBaseUrl()}/voices`, {
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `OmniVoice server ตอบ ${res.status}` }, { status: 502 });
    }
    const voices = (await res.json()) as OmniVoiceInfo[];
    return NextResponse.json(
      voices.map(v => ({
        voice_id: v.voice_id,
        desc: v.desc,
        instruct: v.instruct,
        preview_url: `/api/omnivoice/preview/${encodeURIComponent(v.voice_id)}`,
      })),
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (e) {
    console.error("[omnivoice/voices] fetch failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "เชื่อมต่อ OmniVoice server ไม่ได้" }, { status: 503 });
  }
}
