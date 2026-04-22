import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * POST /api/videos/split-phrases
 * Body: { script: string, audioDurationMs?: number }
 * Returns: { phrases: string[], tags: ("hook"|"body"|"cta")[] }
 *
 * Uses GPT to split a Thai script into natural subtitle phrases AND tag each one.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { script, audioDurationMs } = body ?? {};
  if (!script?.trim()) return NextResponse.json({ error: "script required" }, { status: 400 });

  // ~2–5s per subtitle phrase; give ±2 flexibility so LLM isn't over-constrained
  const durationSec = audioDurationMs ? audioDurationMs / 1000 : null;
  const minPhrases = durationSec ? Math.max(2, Math.floor(durationSec / 5)) : 2;
  const maxPhrases = durationSec ? Math.max(minPhrases + 2, Math.ceil(durationSec / 2)) : 8;
  const targetRange = `${minPhrases}-${maxPhrases}`;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { geminiKey: true, openaiKey: true },
  });
  let apiKey = process.env.SERVER_OPENAI_API_KEY ?? null;
  let useGemini = false;
  if (!apiKey) {
    if (user?.geminiKey) { apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
    else if (user?.openaiKey) { apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
    else return NextResponse.json({ error: "Gemini or OpenAI key not set", missingKey: "gemini" }, { status: 400 });
  }

  const prompt = `You are an expert Thai short-video subtitle editor for TikTok/Reels.

TASK: Split the script into subtitle phrases AND tag each one.

━━━ TAGGING RULES ━━━
• "hook" = The OPENING attention-grabbing line(s) only — typically the FIRST 1–2 phrases that create curiosity/shock. Once the content shifts to explaining or giving value, switch to "body". Do NOT tag the whole script as hook.
• "body" = The MAIN CONTENT — explanations, facts, story, value delivery. This is usually the MAJORITY of phrases (the middle section).
• "cta"  = EXPLICIT call-to-action words ONLY: กดติดตาม, กด like, กดแชร์, ลิงก์ในไบโอ, สมัครเลย, subscribe, follow. "คอมเมนต์บอก" or "คอมเมนต์ไว้" = "body" NOT cta. A punchy closing that is NOT asking viewer to tap/click is still "body".

━━━ TAGGING DISTRIBUTION (approximate) ━━━
• hook: 1–3 phrases (opening only)
• body: most phrases (middle, the bulk)
• cta: 0–2 phrases (ending, only if explicit action request)
• If there is no explicit CTA in the script, do NOT force a "cta" tag.

━━━ CRITICAL ━━━
• NEVER change, correct, or modify any word from the original script. Copy every character exactly as-is.

━━━ SPLITTING RULES ━━━
• Audio duration: ${durationSec ? `${durationSec.toFixed(1)}s` : "unknown"} → target ${targetRange} phrases total
• Each phrase = one complete thought unit (8–30 chars). If a phrase exceeds 35 chars, you MUST split it.
• Split at sentence-ending punctuation (. ? ! ฯ) or major conjunctions (แต่, และ, เพราะ, จึง) or at natural breath points (สรุป, โดย, ขณะที่, พร้อม, ระบุ, ชี้).
• NEVER split mid-sentence just to hit a char limit.
• Short punchy lines like "ผิดสัตว์", "ลองดูก่อน" → keep as ONE phrase.
• Long sentences with numbers/stats: split before/after each stat unit — e.g. "กว่า 1.11 ล้านคน-เที่ยว" is one unit, "สรุปยอดสะสม 7 วัน" is another.
• NEVER split a date expression — keep "วันที่ 13 เมษายน 2569", "13 เมษายน 2569", "เมษายน 2569" as ONE phrase each. Date = any phrase containing a Thai month name (มกราคม/กุมภาพันธ์/มีนาคม/เมษายน/พฤษภาคม/มิถุนายน/กรกฎาคม/สิงหาคม/กันยายน/ตุลาคม/พฤศจิกายน/ธันวาคม).

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON — no markdown, no explanation:
{"phrases":["phrase1","phrase2"],"tags":["hook","body","cta"]}

━━━ EXAMPLES ━━━
Script: "โลกที่คุณเห็น สงครามที่คุณได้ยิน วิกฤตเศรษฐกิจที่กำลังสูบเงินในกระเป๋าคุณ คุณคิดว่ามันเป็นเรื่องบังเอิญงั้นหรอ ผิดสัตว์ กดติดตามไว้เลย"
Output: {"phrases":["โลกที่คุณเห็น สงครามที่คุณได้ยิน","วิกฤตเศรษฐกิจที่กำลังสูบเงินในกระเป๋าคุณ","คุณคิดว่ามันเป็นเรื่องบังเอิญงั้นหรอ","ผิดสัตว์","กดติดตามไว้เลย"],"tags":["hook","body","body","body","cta"]}

Script: "คุณเคยสังเกตไหมว่าทำไมคนรวยนอนน้อย แต่ยังมีพลังงาน นั่นเป็นเพราะพวกเขาจัดการเวลาต่างออกไป ลองทำตามนี้ดู"
Output: {"phrases":["คุณเคยสังเกตไหมว่าทำไมคนรวยนอนน้อย","แต่ยังมีพลังงาน","นั่นเป็นเพราะพวกเขาจัดการเวลาต่างออกไป","ลองทำตามนี้ดู"],"tags":["hook","hook","body","body"]}

Script: "กรมการขนส่งทางราง\nเผยยอดใช้ระบบรางเปิดทำงานวันแรกกว่า 1.11 ล้านคน-เที่ยว สรุปยอดสะสม 7 วันเทศกาลสงกรานต์ทะลุ 8.22 ล้านคน-เที่ยว"
Output: {"phrases":["กรมการขนส่งทางราง","เผยยอดใช้ระบบรางเปิดทำงานวันแรก","กว่า 1.11 ล้านคน-เที่ยว","สรุปยอดสะสม 7 วัน","เทศกาลสงกรานต์ทะลุ 8.22 ล้านคน-เที่ยว"],"tags":["hook","body","body","body","body"]}

━━━ SCRIPT TO PROCESS ━━━
${script.trim()}`;

  let text = "{}";
  if (useGemini) {
    try {
      const raw = await geminiGenerateText(apiKey, prompt, 4096);
      console.log(`[split-phrases] Gemini raw:`, raw);
      const stripped = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      text = jsonMatch ? jsonMatch[0] : stripped;
    } catch (e) {
      console.error("[split-phrases] Gemini error:", e);
      return NextResponse.json({ error: `Gemini failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
    }
  } else {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 800, temperature: 0, response_format: { type: "json_object" } }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return NextResponse.json({ error: `OpenAI failed: ${err.slice(0, 200)}` }, { status: 500 });
    }
    const data = await res.json();
    text = data.choices?.[0]?.message?.content ?? "{}";
  }
  console.log(`[split-phrases] GPT raw:`, text.slice(0, 400));

  // CTA keyword detector — only tag as cta if explicit action words present
  const CTA_RE = /กดติดตาม|กด\s*like|กด\s*แชร์|ลิงก์ในไบโอ|สมัครเลย|subscribe|follow now/i;

  // Hook detector — questions, shocking openers, "เคย", "รู้ไหม", "รู้มั้ย" etc.
  const HOOK_RE = /ไหม[?？]?$|มั้ย[?？]?$|หรอ[?？]?$|จริงๆ[?？]?$|เคย|รู้ไหม|รู้มั้ย|คุณเคย|เชื่อไหม|[?？]$/;

  function autoTag(phrases: string[]): ("hook" | "body" | "cta")[] {
    const n = phrases.length;
    const tags: ("hook" | "body" | "cta")[] = phrases.map(() => "body");

    // First phrase is always hook
    if (n > 0) tags[0] = "hook";

    // Tag any phrase with explicit CTA keyword as cta
    for (let i = 0; i < n; i++) {
      if (CTA_RE.test(phrases[i])) tags[i] = "cta";
    }

    // Extend hook forward: consecutive phrases from start that look like hook openers
    for (let i = 1; i < Math.min(3, n); i++) {
      if (tags[i] === "body" && HOOK_RE.test(phrases[i])) tags[i] = "hook";
      else break; // stop extending at first non-hook phrase
    }

    return tags;
  }

  try {
    const parsed = JSON.parse(text);
    const phrases: string[] = Array.isArray(parsed.phrases) ? parsed.phrases.map((p: string) => p.trim()).filter(Boolean) : [];

    if (phrases.length === 0) throw new Error("empty");

    // Validate: only Thai chars matter — ignore spaces, punctuation, numbers
    const thaiOnly = (s: string) => s.replace(/[^\u0E00-\u0E7F]/g, "");
    const origThai = thaiOnly(script.trim());
    const outThai = thaiOnly(phrases.join(""));
    const charRatio = origThai.length > 0 ? outThai.length / origThai.length : 0;
    console.log(`[split-phrases] thaiRatio=${charRatio.toFixed(3)} orig=${origThai.length} out=${outThai.length}`);
    if (charRatio < 0.80 || charRatio > 1.15) {
      console.warn(`[split-phrases] LLM dropped/added Thai text! ratio=${charRatio.toFixed(3)}\n  original: ${origThai.slice(0, 100)}\n  phrases:  ${outThai.slice(0, 100)}`);
      throw new Error("text-mismatch");
    }

    // Always compute tags ourselves — never trust GPT tags blindly
    const normalizedTags = autoTag(phrases);
    console.log(`[split-phrases] OK: ${phrases.length} phrases, tags:`, normalizedTags);
    return NextResponse.json({ phrases, tags: normalizedTags });
  } catch {
    // Fallback: split by newlines, auto-tag based on content
    const lines = script.trim().split(/\n+/).map((s: string) => s.trim()).filter(Boolean);
    const fallbackTags = autoTag(lines);
    console.log(`[split-phrases] fallback: ${lines.length} lines, tags:`, fallbackTags);
    return NextResponse.json({ phrases: lines, tags: fallbackTags });
  }
}
