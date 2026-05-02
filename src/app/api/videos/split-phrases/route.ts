import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 30;
export const runtime = "nodejs";

const SRT_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const SRT_ARROW_RE = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;

function stripSrtArtifacts(input: string): string {
  return input
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l === "✕" || l === "···" || l === "..." || l === "…") return false;
      if (SRT_ARROW_RE.test(l) || SRT_TIME_RE.test(l)) return false;
      if (/^\d{1,6}$/.test(l)) return false;
      if (/^(CTA|HOOK|BODY|OUTRO|INTRO)$/i.test(l)) return false;
      return true;
    })
    .join("\n")
    .replace(/\([^\n]{0,80}\n[^\n]{0,80}\)/g, (m) => m.replace(/\n/g, " "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * POST /api/videos/split-phrases
 * Body: { script: string, audioDurationMs?: number }
 * Returns: { phrases: string[], tags: ("hook"|"body"|"cta")[] }
 *
 * Uses LLM to rewrite thai script into natural subtitle-ready lines + tags.
 * It is allowed to shorten/rephrase slightly, but meaning should stay intact.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { script: rawScript, audioDurationMs } = body ?? {};
  if (!rawScript?.trim()) return NextResponse.json({ error: "script required" }, { status: 400 });

  // Pre-process: normalize ellipsis and quotes so LLM gets clean split points
  // Replace "..." with newline (treat as breath/pause), strip leading/trailing quotes per line
  const script = stripSrtArtifacts(rawScript)
    .replace(/\.{3,}/g, "\n")          // ... → newline (split point)
    .replace(/["“”’「」]/g, "")  // remove all quote variants
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0)
    .join("\n");

  // Target density is generous so captions can be rewritten and merged/split naturally.
  // ~2–4s per subtitle for short clips, longer clips tend to need more chunks.
  const durationSec = audioDurationMs ? audioDurationMs / 1000 : null;
  const minPhrases = durationSec ? Math.max(2, Math.floor(durationSec / 5)) : 2;
  const maxPhrases = durationSec ? Math.max(minPhrases + 2, Math.ceil(durationSec / 2)) : 8;
  const targetRange = `${minPhrases}-${maxPhrases}`;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { geminiKey: true, openaiKey: true, ttsProvider: true },
  });
  const openAiModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
  let apiKey = process.env.SERVER_OPENAI_API_KEY ?? null;
  let useGemini = false;
  if (!apiKey) {
    const preferGemini = user?.ttsProvider === "gemini";
    const preferOpenAI = user?.ttsProvider === "elevenlabs" || user?.ttsProvider === "openai";
    if (preferGemini && user?.geminiKey) { apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
    else if (preferOpenAI && user?.openaiKey) { apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
    else if (user?.geminiKey) { apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
    else if (user?.openaiKey) { apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
    else return NextResponse.json({ error: "Gemini or OpenAI key not set", missingKey: "gemini" }, { status: 400 });
  }

  const prompt = `You are a Thai subtitle splitter for TikTok/Reels.

TASK: Split this Thai script into subtitle phrases exactly as written — DO NOT rewrite, rephrase, or remove words.

━━━ CRITICAL RULE ━━━
• COPY words EXACTLY from the script. Do NOT paraphrase, summarize, or drop any words.
• Only task is to decide WHERE to split into subtitle lines.
• Every word in the script must appear in the output phrases — nothing removed.

━━━ SPLITTING RULES ━━━
• Audio duration: ${durationSec ? `${durationSec.toFixed(1)}s` : "unknown"} → target ${targetRange} phrases total
• Each phrase = one complete thought unit (8–30 Thai chars ideal, hard max 40 chars). If a phrase exceeds 40 chars, you MUST split it.
• Split at: sentence-ending punctuation (. ? ! ฯ), major conjunctions (แต่, และ, เพราะ, จึง), natural breath points (สรุป, โดย, ขณะที่, พร้อม, ระบุ, ชี้).
• NEVER split mid-sentence just to hit a char limit.
• Short punchy lines like "ผิดสัตว์", "ลองดูก่อน" → keep as ONE phrase.
• Long sentences with numbers/stats: split before/after each stat unit.
• NEVER split a date expression (keep Thai month name + date + year as ONE phrase).

━━━ TAGGING RULES ━━━
• "hook" = opening attention-grabbing line(s) — FIRST 1–2 phrases only.
• "body" = main content — the majority of phrases.
• "cta"  = explicit action words only: กดติดตาม, กด like, กดแชร์, สมัครเลย, subscribe, follow.

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON — no markdown, no explanation:
{"phrases":["phrase1","phrase2"],"tags":["hook","body","cta"]}

━━━ EXAMPLES ━━━
Script: "โลกที่คุณเห็น สงครามที่คุณได้ยิน วิกฤตเศรษฐกิจที่กำลังสูบเงินในกระเป๋าคุณ คุณคิดว่ามันเป็นเรื่องบังเอิญงั้นหรอ ผิดสัตว์ กดติดตามไว้เลย"
Output: {"phrases":["โลกที่คุณเห็น สงครามที่คุณได้ยิน","วิกฤตเศรษฐกิจที่กำลังสูบเงินในกระเป๋าคุณ","คุณคิดว่ามันเป็นเรื่องบังเอิญงั้นหรอ","ผิดสัตว์","กดติดตามไว้เลย"],"tags":["hook","body","body","body","cta"]}

Script: "คุณเคยสังเกตไหมว่าทำไมคนรวยนอนน้อย แต่ยังมีพลังงาน นั่นเป็นเพราะพวกเขาจัดการเวลาต่างออกไป ลองทำตามนี้ดู"
Output: {"phrases":["คุณเคยสังเกตไหมว่าทำไมคนรวยนอนน้อย","แต่ยังมีพลังงาน","นั่นเป็นเพราะพวกเขาจัดการเวลาต่างออกไป","ลองทำตามนี้ดู"],"tags":["hook","hook","body","body"]}

Script: "กรมการขนส่งทางราง เผยยอดใช้ระบบรางวันแรกกว่า 1.11 ล้านคน-เที่ยว สรุปยอดสะสม 7 วันเทศกาลสงกรานต์ทะลุ 8.22 ล้านคน-เที่ยว"
Output: {"phrases":["กรมการขนส่งทางราง","เผยยอดใช้ระบบรางวันแรก","กว่า 1.11 ล้านคน-เที่ยว","สรุปยอดสะสม 7 วัน","เทศกาลสงกรานต์ทะลุ 8.22 ล้านคน-เที่ยว"],"tags":["hook","body","body","body","body"]}

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
      body: JSON.stringify({ model: openAiModel, messages: [{ role: "user", content: prompt }], max_tokens: 800, temperature: 0, response_format: { type: "json_object" } }),
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

  // Post-process: clean up subtitle display artifacts
  function cleanPhrase(p: string): string {
    return p
      .replace(/["“”’「」]/g, "")  // remove all quotes
      .replace(/\.{2,}/g, "")  // remove all ellipsis
      .trim();
  }

  try {
    const parsed = JSON.parse(text);
    const phrases: string[] = Array.isArray(parsed.phrases)
      ? parsed.phrases.map((p: string) => cleanPhrase(p)).filter(Boolean)
      : [];

    if (phrases.length === 0) throw new Error("empty");

    // Validate: only Thai chars matter — ignore spaces, punctuation, numbers
    const thaiOnly = (s: string) => s.replace(/[^\u0E00-\u0E7F]/g, "");
    const origThai = thaiOnly(script.trim());
    const outThai = thaiOnly(phrases.join(""));
    const charRatio = origThai.length > 0 ? outThai.length / origThai.length : 0;
    console.log(`[split-phrases] thaiRatio=${charRatio.toFixed(3)} orig=${origThai.length} out=${outThai.length}`);
    // No rewrite allowed — output must preserve nearly all Thai chars from input.
    // Allow 0.70-1.30 to accommodate scripts with English/numbers mixed in.
    if (charRatio < 0.70 || charRatio > 1.30) {
      console.warn(`[split-phrases] LLM dropped/added Thai text! ratio=${charRatio.toFixed(3)}\n  original: ${origThai.slice(0, 100)}\n  phrases:  ${outThai.slice(0, 100)}`);
      throw new Error("text-mismatch");
    }

    // Always compute tags ourselves — never trust GPT tags blindly
    const normalizedTags = autoTag(phrases);
    console.log(`[split-phrases] OK: ${phrases.length} phrases, tags:`, normalizedTags);
    return NextResponse.json({ phrases, tags: normalizedTags });
  } catch {
    // Fallback: split by newlines then by sentence-ending punctuation
    const rawLines = script.trim().split(/\n+/);
    const lines: string[] = [];
    for (const line of rawLines) {
      // Split long lines at Thai sentence boundaries
      const parts = line.split(/(?<=[.?!ฯ])\s+|(?<=[฀-๿])\s+(?=แต่|และ|เพราะ|จึง|โดย|สรุป)/);
      for (const p of parts) {
        const cleaned = cleanPhrase(p);
        if (cleaned) lines.push(cleaned);
      }
    }
    const fallbackTags = autoTag(lines.length > 0 ? lines : [script.trim()]);
    console.log(`[split-phrases] fallback: ${lines.length} lines, tags:`, fallbackTags);
    return NextResponse.json({ phrases: lines.length > 0 ? lines : [cleanPhrase(script.trim())], tags: fallbackTags });
  }
}

