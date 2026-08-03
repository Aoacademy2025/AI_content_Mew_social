import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { normalizeHeadlineHookSuggestions } from "@/lib/headline-hook";

export const maxDuration = 60;
export const runtime = "nodejs";

function extractJson(value: string): unknown {
  const clean = value.replace(/```(?:json)?/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch { return null; }
}
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "text_required", message: "ไม่พบเนื้อหาสำหรับเขียนพาดหัว" }, { status: 400 });
    }
    if (text.length > 12_000) {
      return NextResponse.json({ error: "text_too_long", message: "เนื้อหายาวเกิน 12,000 ตัวอักษร" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, plan: true },
    });
    if (!user) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

    let apiKey: string;
    let geminiMode: "managed" | "byok";
    try {
      const resolved = resolveGeminiKey(user);
      apiKey = resolved.key;
      geminiMode = resolved.mode;
    } catch (error) {
      if (error instanceof KeyRequiredError) {
        return NextResponse.json({
          code: "KEY_REQUIRED",
          message: "ตั้งค่า Gemini API key ก่อนใช้ AI ช่วยเขียนพาดหัว",
          action: "/settings?tab=api-keys",
        }, { status: 409 });
      }
      throw error;
    }

    const textReserve = await reserveAiTextCall(authUser.id, { enforce: geminiMode === "managed" });
    if (!textReserve.allowed) {
      return NextResponse.json({ code: "QUOTA_AI_TEXT", message: textReserve.message }, { status: 429 });
    }

    const prompt = `คุณคือบรรณาธิการพาดหัววิดีโอสั้นภาษาไทยสำหรับ Facebook Reels, TikTok และ Shorts

อ่าน TRANSCRIPT แล้วเขียนพาดหัวเปิดคลิป 3 ตัวเลือก คนดูต้องเข้าใจประเด็นได้แม้ปิดเสียง

กฎสำคัญ:
- ใช้ข้อเท็จจริงจาก TRANSCRIPT เท่านั้น ห้ามแต่งตัวเลข ชื่อ เหตุการณ์ หรือข้อสรุปใหม่
- headline กระชับ ชัด ไม่เกินประมาณ 64 ตัวอักษร และแสดงได้ไม่เกิน 2 บรรทัด
- subheadline เป็นรายละเอียดเสริม ไม่เกินประมาณ 90 ตัวอักษรและ 1 บรรทัด ถ้าไม่จำเป็นให้เป็นข้อความว่าง
- แต่ละตัวเลือกต้องใช้มุมต่างกันตามลำดับ: คำถามชวนสงสัย, ประเด็นขัดแย้ง/คาดไม่ถึง, คุณค่าหรือผลกระทบต่อคนดู
- ไม่ใช้ markdown, hashtag, emoji หรือคำเกริ่นก่อน JSON
- รักษาภาษาหลักและน้ำเสียงของ TRANSCRIPT

TRANSCRIPT:
${text}

ตอบ JSON เท่านั้น:
{"suggestions":[{"headline":"...","subheadline":"..."},{"headline":"...","subheadline":"..."},{"headline":"...","subheadline":"..."}]}`;

    const raw = await geminiGenerateText(apiKey, prompt, 1_200, 0.55);
    const suggestions = normalizeHeadlineHookSuggestions(extractJson(raw));
    if (suggestions.length === 0) {
      return NextResponse.json({
        error: "suggestions_unavailable",
        message: "AI ยังเขียนพาดหัวที่ใช้ได้ไม่สำเร็จ ลองอีกครั้งหรือแก้ข้อความเอง",
      }, { status: 422 });
    }

    return NextResponse.json({ suggestions });
  } catch (error) {
    return apiError({ route: "POST /api/videos/headline-hook-suggestions", error, notifyUser: false });
  }
}
