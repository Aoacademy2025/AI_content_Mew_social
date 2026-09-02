import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { heroVoiceBrief, RUNPOD_HERO_VOICES } from "@/lib/hero-voice-preview";
import type { OmniVoiceInfo } from "@/lib/tts-providers";
import { listUserVoices, userVoiceIdFor } from "@/lib/user-voices.server";
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
  if (!isOmniVoiceUserAllowed(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Custom clone voices — admin-only v1, listed first so they're easy to find.
  const cloneVoices = user.role === "ADMIN"
    ? (await listUserVoices(user.id)).map((voice) => ({
        voice_id: userVoiceIdFor(voice.id),
        desc: `🎙 ${voice.name} (เสียงโคลน)`,
        instruct: "เสียงโคลนจากตัวอย่างของคุณ",
        preview_url: `/api/omnivoice/user-voices/${encodeURIComponent(voice.id)}`,
      }))
    : [];

  try {
    const config = omnivoiceConfig();
    if (config.backend === "runpod") {
      // The queue worker intentionally exposes only TTS jobs. Keep its served
      // catalog server-owned so listing voices never calls the retired KVM2 API.
      return NextResponse.json([...cloneVoices, ...RUNPOD_HERO_VOICES], {
        headers: { "Cache-Control": "private, max-age=300" },
      });
    }
    // worker แยกคลังตามภาษาไว้ตั้งใจ: `/voices` เปล่า ๆ คืนเฉพาะชุดหลัก (ไทย/อังกฤษ)
    // และจะไม่ปนเสียงที่กำกับภาษาไว้เข้ามาเลย ต้องขอด้วย `?language=` แยกอีกที
    // จึงต้องดึงทั้งสองชุดมารวมเอง ไม่งั้นเสียงลาวจะไม่โผล่ใน UI ตลอดกาล
    const fetchCatalog = (language?: string) =>
      fetch(`${config.baseUrl}/voices${language ? `?language=${encodeURIComponent(language)}` : ""}`, {
        headers: omnivoiceAuthHeaders(config.apiKey),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });

    // ชุดหลักคือตัวชี้ขาดว่า worker ใช้ได้ไหม — ส่วนคลังลาวเป็นของเสริม (worker
    // รุ่นเก่าไม่มี `voices_lao/` แล้วตอบ 200 พร้อม [] หรือ error ก็ได้) จึง fail-open
    const [response, laoResponse] = await Promise.all([
      fetchCatalog(),
      fetchCatalog("lao").catch(() => null),
    ]);
    if (!response.ok) {
      console.error(`[omnivoice/voices] upstream status=${response.status}`);
      return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน" }, { status: 503 });
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("invalid voices payload");
    const laoPayload: unknown = laoResponse?.ok
      ? await laoResponse.json().catch(() => null)
      : null;

    const toVoice = (voice: OmniVoiceInfo) => ({
      voice_id: voice.voice_id,
      desc: voice.desc.slice(0, 160),
      instruct: voice.instruct.slice(0, 240),
      // ส่งภาษาที่แคตตาล็อกระบุต่อให้ UI แยกคลังไทย/ลาวได้ — ตัดความยาวกัน payload บวม
      language: typeof voice.language === "string" ? voice.language.slice(0, 32) : null,
      // บรีฟเป็นข้อมูลฝั่งแอป (ดู hero-voice-preview.ts) — worker ไม่ได้ส่งมา
      brief: heroVoiceBrief(voice.voice_id),
      preview_url: `/api/omnivoice/preview/${encodeURIComponent(voice.voice_id)}`,
    });

    const mainVoices = payload.filter(isOmniVoiceInfo).map(toVoice);
    const laoVoices = (Array.isArray(laoPayload) ? laoPayload : []).filter(isOmniVoiceInfo).map(toVoice);
    // กัน worker ที่คืนเสียงเดิมซ้ำในทั้งสองชุด — ชุดหลักชนะ
    const seen = new Set(mainVoices.map((voice) => voice.voice_id));
    const voices = [...mainVoices, ...laoVoices.filter((voice) => !seen.has(voice.voice_id))];
    if (voices.length === 0) throw new Error("no valid voices returned");
    return NextResponse.json([...cloneVoices, ...voices], { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    if (!(error instanceof OmniVoiceConfigError)) {
      console.error("[omnivoice/voices] request failed:", error instanceof Error ? error.message : error);
    }
    // Stock catalog unavailable (worker down / disabled) — still serve the
    // caller's own clone voices so they never vanish from the pickers.
    if (cloneVoices.length > 0) {
      return NextResponse.json(cloneVoices, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน" }, { status: 503 });
  }
}
