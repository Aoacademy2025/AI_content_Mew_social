import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";
import { mapCardTextsToRangesTolerant, type CardPiece } from "@/lib/tts-timing";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";

export const maxDuration = 60;
export const runtime = "nodejs";

// POST /api/videos/split-script
// Body: { text, maxCardChars? }
// Returns: { cards: [{ startChar, endChar, tag? }] } — char ranges on `text`.
//
// Viral-style card cutting WITHOUT timestamps (plan §6 phase 2): the LLM only
// chooses WHERE to cut; timing comes from TTS, and mapCardTextsToRanges
// guarantees the LLM cannot change a single visible character. Any deviation
// → 422 and the editor falls back to deterministic sentence cards, so this
// route can never make subtitles worse — only prettier.
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const { text, maxCardChars = 28 } = body ?? {};
    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }
    if (text.length > 12_000) {
      return NextResponse.json({ error: "text too long" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, plan: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    let apiKey: string;
    try {
      apiKey = resolveGeminiKey(user).key;
    } catch (e) {
      if (e instanceof KeyRequiredError) {
        return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
      }
      throw e;
    }

    const cardCap = Math.min(Math.max(Math.round(Number(maxCardChars) || 28), 12), 60);

    // Rules 1-3 + tags ported from the transcribe prompt (its กฎ 5-6 +
    // timestamp rules are timing-specific and no longer the LLM's job).
    const prompt = `คุณคือผู้ตัดซับไตเติ้ลภาษาไทยสำหรับ TikTok/Reels มืออาชีพ

แบ่ง SCRIPT ข้างล่างเป็นซับการ์ดสั้น ๆ — งานนี้คือ "เลือกจุดตัดข้อความ" เท่านั้น (เวลามีระบบอื่นจัดการแล้ว)

━━━ กฎเหล็ก — ห้ามแก้ข้อความ ━━━
ทุกการ์ดต้องเป็นข้อความจาก SCRIPT แบบคำต่อคำ ตามลำดับเดิม ครบทุกตัวอักษร
ห้ามแก้คำ ห้ามสะกดใหม่ ห้ามเพิ่ม ห้ามตัดทิ้ง ห้ามสลับลำดับ ห้ามสรุป
ตัวเลข ลำดับ และคำขึ้นต้น (เช่น "ข้อที่1", "ตอนที่2") ก็เป็นส่วนของ SCRIPT — ต้องอยู่ในการ์ดด้วย ห้ามข้าม
เครื่องหมายทุกตัวก็เป็นส่วนของ SCRIPT — ขีด (—) เครื่องหมายคำพูด (‘ ’ “ ”) จุดไข่ปลา (...) ต้องติดไปกับการ์ดเสมอ ห้ามทิ้ง
ห้ามเปลี่ยนหรือตัดคำเล็ก ๆ เช่น "แค่" "ก็" "นะ" — ลอกตามตัวอักษรเท่านั้น
(เว้นวรรค/ขึ้นบรรทัดใหม่ปรับได้)

━━━ กฎ 1 — ตัดที่จุดหายใจ ไม่ตัดกลางวลี ━━━
ตัดหลังจุลภาค จุด หรือจุดจบวลีตามธรรมชาติ
ห้ามตัดกลางประโยคที่ความหมายยังค้างอยู่
ห้ามตัดกลางคำเด็ดขาด เช่น ห้ามแยก "ธุรกิจ" เป็น "ธุ" กับ "รกิจ" — จุดตัดต้องอยู่ระหว่างคำเสมอ
✗ ผิด: "มึงเคยคิดปะ ว่า" | "ความรู้ที่เรียนมา"
✓ ถูก: "มึงเคยคิดปะ..." | "ว่าความรู้ที่เรียนมา"

━━━ กฎ 2 — 1 ซับ = 1 ความคิด ━━━
ถ้าประโยคมี 2 ไอเดีย ให้แยกเป็น 2 การ์ด แม้จะสั้น

━━━ กฎ 3 — ซับช็อก ให้สั้นพิเศษ ━━━
twist / punchline / คำเด็ด → 3-8 คำ การ์ดเดี่ยว

━━━ กฎ 4 — ความยาวการ์ด ━━━
การ์ดละไม่เกิน ${cardCap} ตัวอักษร (ประมาณ ≤5 วินาทีพูด)

━━━ tags ━━━
"hook"=การ์ดแรก (ดึงดูด), "cta"=ชวนติดตาม/ไลค์/แชร์ (ไม่เกิน 2 การ์ด), "body"=ที่เหลือ

━━━ SCRIPT ━━━
${text}

━━━ OUTPUT — JSON เท่านั้น ไม่มี markdown ━━━
{"cards":[{"text":"...","tag":"hook"},{"text":"...","tag":"body"},...]}`;

    const raw = await geminiGenerateText(apiKey, prompt, 8192, 0);

    // Strip markdown fences if the model added them, then take the outer JSON.
    const jsonText = raw.replace(/```(?:json)?/g, "").trim();
    const match = jsonText.match(/\{[\s\S]*\}/);
    let pieces: CardPiece[] | null = null;
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { cards?: CardPiece[] };
        if (Array.isArray(parsed.cards)) pieces = parsed.cards;
      } catch { /* fall through to 422 */ }
    }
    if (!pieces) {
      console.warn(`[split-script] unparseable LLM output (${raw.length} chars)`);
      return NextResponse.json({ error: "LLM output unparseable" }, { status: 422 });
    }

    // Partial acceptance: verbatim pieces become viral cards; deviating
    // pieces fall back to sentence cards for THEIR span only. One normalized
    // em-dash no longer costs the whole clip its viral cut.
    const result = mapCardTextsToRangesTolerant(text, pieces, cardCap);
    if (!result) {
      console.warn(`[split-script] no LLM piece reproduces the script verbatim (${pieces.length} pieces) — client should fall back to sentence cards`);
      return NextResponse.json({ error: "cards mismatch script" }, { status: 422 });
    }

    if (result.rejected > 0) {
      console.warn(`[split-script] ${result.rejected}/${result.accepted + result.rejected} pieces rejected → sentence-filled. First mismatch: ${result.firstMismatch}`);
    }
    console.log(`[split-script] ${text.length} chars → ${result.cards.length} cards (${result.accepted} viral, ${result.rejected} rejected)`);
    return NextResponse.json({ cards: result.cards });
  } catch (error) {
    return apiError({ route: "POST /api/videos/split-script", error, notifyUser: false });
  }
}
