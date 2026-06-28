import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { checkAiInputCaps } from "@/lib/ai-input-caps";

const SYSTEM_PROMPT = `คุณคือ Professional Content Creator และ Social Media Strategist
ผู้เชี่ยวชาญด้านการ แบ่งสคริปต์ให้กลายเป็นฉากวิดีโอ short-form ที่ไหลลื่น เห็นภาพทันที

โหมดการทำงาน: Script Breakdown Only

ข้อกำหนดสำคัญ (ห้ามผิด):

ต้องยึด "สคริปต์ต้นฉบับ" เป็นศูนย์กลาง

ห้ามสร้างคอนเทนต์ใหม่ทุกกรณี

ห้ามเขียนประโยคใหม่

ห้ามเติมคำอธิบาย

ห้ามใช้ข้อมูลจากภายนอก

งานนี้คือ จัดฉาก + ทำ prompt ภาพเท่านั้น

คลิปวิดีโอรวมต้องไม่เกิน 1 นาที

ให้ตอบเป็นภาษาไทยทั้งหมด
(ยกเว้น Image Prompt ต้องเป็นภาษาอังกฤษ)`;

function buildUserMessage(script: string, sceneCount: number, videoDuration: number): string {
  const timePerScene = Math.floor(videoDuration / sceneCount);
  return `━━━━━━━━━━━━━━━━━━
INPUT (สคริปต์ต้นฉบับ)
━━━━━━━━━━━━━━━━━━
สคริปต์:
${script}

กติกาต้นฉบับ:

ใช้เฉพาะ "ข้อความในสคริปต์" เท่านั้น

mapping ต้องคัดจากสคริปต์แบบตรงตัว 100%

ห้ามเดา / ห้ามเติม / ห้ามสรุปใหม่ / ห้ามเปลี่ยนคำ

━━━━━━━━━━━━━━━━━━
TASK (แบ่งสคริปต์เป็นฉาก)
━━━━━━━━━━━━━━━━━━

แบ่งสคริปต์ออกเป็น ${sceneCount} ฉากพอดี ห้ามเกิน ห้ามน้อยกว่า

แบ่งสคริปต์ให้เท่าๆ กันในแต่ละฉาก — กระจายประโยคจากต้นจนจบให้ครบทุกฉาก

mapping ต้องเป็นประโยคจากสคริปต์ตรงตัวทุกคำ และรวมกันทุกฉากต้องครอบคลุมสคริปต์ทั้งหมด

สร้าง Image Prompt (ภาษาอังกฤษ บรรทัดเดียว) โดยดูจาก mapping ของฉากนั้นโดยตรง

ระยะเวลารวมทุกฉากต้องเท่ากับ ${videoDuration} วินาที แต่ละฉากใช้ประมาณ ${timePerScene} วินาที

━━━━━━━━━━━━━━━━━━
OUTPUT (JSON ONLY)
━━━━━━━━━━━━━━━━━━
ห้ามมีข้อความใด ๆ นอกเหนือจาก JSON
ห้าม markdown
ห้ามคำอธิบายเพิ่มเติม

{
  "videoScript": [
    {
      "time": "",
      "sceneType": "",
      "sceneTitle": "",
      "mapping": "",
      "videoPrompt": ""
    }
  ],
  "imagePrompts": [
    {
      "scene": 1,
      "prompt": ""
    }
  ]
}


━━━━━━━━━━━━━━━━━━
RULES: videoScript
━━━━━━━━━━━━━━━━━━

จำนวนฉาก: ต้องเป็น ${sceneCount} ฉากพอดี ห้ามเกิน ห้ามน้อยกว่า

mapping: แบ่งสคริปต์ให้เท่าๆ กันต่อฉาก รวมกันทุกฉากต้องครบทุกประโยคจากสคริปต์ต้นฉบับ ห้ามตกหล่น

ลำดับฉากต้องเรียงตามเรื่องจากสคริปต์ ตั้งแต่ต้นจนจบ

time: ใส่ช่วงเวลาแบบต่อเนื่อง แต่ละฉากประมาณ ${timePerScene} วินาที รวมทั้งหมด ${videoDuration} วินาที

sceneType: เลือกให้เหมาะกับจังหวะเรื่อง เช่น Hook / What / Why / How / Proof / Close

sceneTitle: ชื่อสั้น ชัด เห็นภาพทันที (ภาษาไทย)

━━━━━━━━━━━━━━━━━━
RULES: Image Prompt (1:1)
━━━━━━━━━━━━━━━━━━

videoPrompt ต้องเป็นภาษาอังกฤษ

1 บรรทัดเดียวเท่านั้น

ห้าม bullet / ห้ามขึ้นบรรทัดใหม่ / ห้ามใช้ label

ต้องสร้างจาก mapping ของฉากนั้นโดยตรง ห้ามอ้างอิงข้อมูลอื่น

1 ประโยคต้องมี: action, environment, mood/emotion, visual style, lighting, color tone, camera framing/composition

เหมาะกับวิดีโอ short-form แนวตั้ง อัตราส่วน 1:1

━━━━━━━━━━━━━━━━━━
RULES: imagePrompts
━━━━━━━━━━━━━━━━━━

จำนวนต้องเท่ากับ videoScript แบบ 1:1

prompt ต้องเหมือนกับ videoPrompt ของฉากนั้น ทุกตัวอักษร

scene ใช้เลขลำดับ 1..n เท่านั้น

ข้อห้ามเด็ดขาด:

ห้ามสร้างคอนเทนต์ใหม่

ห้ามแก้คำใน mapping

ห้ามใช้ข้อมูลนอกสคริปต์

ต้องได้ ${sceneCount} ฉากพอดี ห้ามเกิน ห้ามน้อยกว่า

mapping รวมกันทุกฉากต้องครบทุกประโยคจากสคริปต์ ห้ามตกหล่นแม้แต่ประโยคเดียว

ห้ามให้ความยาวคลิปรวมเกิน ${videoDuration} วินาที`;
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { script, videoDuration, numberOfImages } = await req.json();

    if (!script) {
      return NextResponse.json({ error: "Script is required" }, { status: 400 });
    }

    const inputCaps = checkAiInputCaps({ script });
    if (!inputCaps.ok) return NextResponse.json({ error: inputCaps.message }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, plan: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let apiKey: string;
    try {
      apiKey = resolveGeminiKey(user).key;
    } catch (e) {
      if (e instanceof KeyRequiredError) {
        return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
      }
      throw e;
    }
    const { geminiGenerateText } = await import("@/lib/gemini");

    // Send the full script as a single line to AI
    const singleLineScript = script.trim().replace(/\n+/g, ' ');
    const userMessage = buildUserMessage(singleLineScript, numberOfImages, videoDuration);
    const fullPrompt = SYSTEM_PROMPT + "\n\n" + userMessage;

    const content = await geminiGenerateText(apiKey, fullPrompt, 2000, 0.3);

    if (!content) {
      return NextResponse.json({ error: "No response from AI" }, { status: 500 });
    }

    const cleanContent = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(cleanContent);

    // Ensure numberOfScenes is always present for frontend compatibility
    result.numberOfScenes = Array.isArray(result.videoScript) ? result.videoScript.length : numberOfImages;

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "videos/analyze-script", error });
  }
}
