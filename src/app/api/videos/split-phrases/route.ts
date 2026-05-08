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
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, " ")                                    // join all lines first so multi-line parentheticals become single-line
    .replace(/\([A-Za-z][^)]{0,80}\)/g, "")                // remove English parentheticals e.g. (Fractional Excitons)
    .replace(/\.{3,}/g, "\n")
    .replace(/["""''`""''「」]/g, "")
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0)
    .join("\n");

  // Target density: ~3–5s per subtitle. Too-short phrases (1-2 words) are unfindable as B-roll.
  const durationSec = audioDurationMs ? audioDurationMs / 1000 : null;
  const minPhrases = durationSec ? Math.max(2, Math.floor(durationSec / 6)) : 2;
  const maxPhrases = durationSec ? Math.max(minPhrases + 2, Math.ceil(durationSec / 3)) : 8;
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

  // ── Gemini prompt: dramatic pacing, NEVER rules, examples ──────────────────
  const geminiPrompt = `You are a Thai subtitle splitter for TikTok/Reels short-form video.

GOAL: Split the script into subtitle phrases that each match ONE breath/pause in the audio.
Each phrase will be shown on screen while the speaker says those exact words,
AND will be used as a B-roll video search query — so it must be visually meaningful.

━━━ ABSOLUTE RULES ━━━
• COPY every Thai word EXACTLY — do NOT paraphrase, summarize, or drop any word.
• NEVER produce a phrase shorter than 10 Thai characters — merge with next/prev phrase instead.
• NEVER split mid-word or mid-thought — split only at natural pause/breath points.
• NEVER split a date (Thai month + year = one phrase).
• English parenthetical notes like (Anyons), (Fractional Excitons) → REMOVE from output.

━━━ SPLITTING STYLE ━━━
• Audio: ${durationSec ? `${durationSec.toFixed(1)}s` : "unknown"} → aim for ${targetRange} phrases
• Each phrase = 1 complete thought the speaker finishes before pausing (15–35 Thai chars ideal)
• Split at: sentence-end (. ? ! ฯ), major conjunctions (แต่ / และ / เพราะ / จึง), dramatic pauses
• Short punchy exclamations ("แม่งบ้าไปแล้ว", "สัตว์!") → MERGE with surrounding phrase
• Numbers/stats → keep number + unit as ONE phrase

━━━ TAGGING ━━━
• "hook" = first 1–2 phrases that grab attention
• "body" = main content
• "cta" = explicit call-to-action only (กดติดตาม, กดแชร์, subscribe, follow)

━━━ OUTPUT — JSON only, no markdown ━━━
{"phrases":["phrase1","phrase2",...],"tags":["hook","body",...]}

━━━ EXAMPLES ━━━
Script: "โลกที่คุณเห็น สงครามที่คุณได้ยิน วิกฤตเศรษฐกิจที่กำลังสูบเงินในกระเป๋าคุณ คุณคิดว่ามันเป็นเรื่องบังเอิญงั้นหรอ ผิดสัตว์ กดติดตามไว้เลย"
Output: {"phrases":["โลกที่คุณเห็น สงครามที่คุณได้ยิน","วิกฤตเศรษฐกิจที่กำลังสูบเงินในกระเป๋าคุณ","คุณคิดว่ามันเป็นเรื่องบังเอิญงั้นหรอ","ผิดสัตว์","กดติดตามไว้เลย"],"tags":["hook","body","body","body","cta"]}

Script: "มึงเคยคิดปะว่าความรู้ทั้งหมดที่เรียนมาตั้งแต่เด็กอาจจะเป็นแค่เรื่องโกหก มีทีมนักฟิสิกส์จากมหาวิทยาลัยบราวน์เสือกไปเปิดประตูบานที่ไม่ควรเปิด"
Output: {"phrases":["มึงเคยคิดปะว่าความรู้ทั้งหมดที่เรียนมาตั้งแต่เด็ก","อาจจะเป็นแค่เรื่องโกหก","มีทีมนักฟิสิกส์จากมหาวิทยาลัยบราวน์","เสือกไปเปิดประตูบานที่ไม่ควรเปิด"],"tags":["hook","hook","body","body"]}

Script: "กรมการขนส่งทางราง เผยยอดใช้ระบบรางวันแรกกว่า 1.11 ล้านคน-เที่ยว สรุปยอดสะสม 7 วันเทศกาลสงกรานต์ทะลุ 8.22 ล้านคน-เที่ยว"
Output: {"phrases":["กรมการขนส่งทางราง เผยยอดใช้ระบบรางวันแรก","กว่า 1.11 ล้านคน-เที่ยว","สรุปยอดสะสม 7 วัน","เทศกาลสงกรานต์ทะลุ 8.22 ล้านคน-เที่ยว"],"tags":["hook","body","body","body"]}

━━━ SCRIPT ━━━
${script.trim()}`;

  // ── OpenAI prompt: numbered rules, strict numeric constraints, json_object ──
  const openaiPrompt = `You are a Thai subtitle splitter for TikTok/Reels short-form video.

TASK: Split the script into subtitle phrases. Each phrase appears on screen while the speaker says those words, and is used to search for a matching B-roll video clip.

RULES — follow every rule exactly:
1. Copy every Thai word EXACTLY — do not paraphrase, reorder, or remove any words.
2. Target ${targetRange} phrases for ${durationSec ? `${durationSec.toFixed(1)}s` : "unknown duration"} of audio.
3. Each phrase must be 15–40 Thai characters. Phrases under 15 chars MUST be merged with the adjacent phrase.
4. Split ONLY at: sentence-end punctuation (. ? ! ฯ), conjunctions (แต่, และ, เพราะ, จึง), or clear pause points.
5. Never split mid-sentence to hit a character limit — the meaning must be complete.
6. Never split a date — keep Thai month name + year together as one phrase.
7. Remove English parenthetical notes like (Anyons) — they are pronunciation guides, not subtitle text.
8. Each phrase must describe something visually distinct so a matching stock video clip can be found.
9. Short exclamations under 15 chars must be merged with the preceding phrase — never left alone.

TAGGING:
- "hook" = first 1–2 phrases only (opening attention-grab)
- "body" = all main content
- "cta" = explicit call-to-action only: กดติดตาม, กดแชร์, subscribe, follow

OUTPUT: valid JSON only — no markdown, no explanation:
{"phrases":["phrase1","phrase2",...],"tags":["hook","body",...]}

Script:
${script.trim()}`;

  const prompt = useGemini ? geminiPrompt : openaiPrompt;

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
      body: JSON.stringify({ model: openAiModel, messages: [{ role: "user", content: prompt }], max_tokens: 4096, temperature: 0, response_format: { type: "json_object" } }),
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
      .replace(/\([A-Za-z][^)]*\)/g, "")  // remove English parentheticals like (Anyons)
      .replace(/["""'「」]/g, "")
      .replace(/\.{2,}/g, "")
      .replace(/\s{2,}/g, " ")
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

