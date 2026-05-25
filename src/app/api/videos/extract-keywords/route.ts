import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";

export const maxDuration = 300;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

function preprocessScript(raw: string): string {
  return raw
    .replace(/\r?\n/g, " ")
    .replace(/\([A-Za-z][^)]{0,80}\)/g, "")
    .replace(/\.{3,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeSubtitleForKeyword(raw: string): string {
  return raw
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^a-zA-Z0-9฀-๿]+|[^a-zA-Z0-9฀-๿\s.,!?()"']+$/g, "")
    .trim();
}

// Word-overlap similarity: returns ratio of shared significant words
function keywordSimilarity(a: string, b: string): number {
  const sig = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wa = sig(a), wb = sig(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

function isTooSimilar(candidate: string, usedSet: Set<string>, threshold = 0.6): boolean {
  for (const used of usedSet) {
    if (keywordSimilarity(candidate, used) >= threshold) return true;
  }
  return false;
}

// Minimal validation: must be English, 2-8 words, not noise
const NOISE_RE = /^(scene|scenes|keywords?|clip|clips?|shot|shots|video|videos)\s*[:\-]?\s*\d*$/i;

function sanitizeKeyword(raw: string): string {
  const k = raw
    .replace(/[^a-zA-Z0-9\s\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!k) return "";
  if (NOISE_RE.test(k)) return "";
  if (!/[a-z]/.test(k)) return "";
  const words = k.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 8) return "";
  return k;
}

function parseKeywordAlternatives(raw: string): string[][] {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Try JSON object with keywords array
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      const arr: unknown[] = Array.isArray(parsed?.keywords) ? parsed.keywords
        : Array.isArray(parsed?.queries) ? parsed.queries
        : Array.isArray(parsed) ? parsed : [];

      if (arr.length > 0) {
        if (Array.isArray(arr[0])) {
          // [[q1,q2,q3], [q1,q2,q3], ...]
          return arr.map(group =>
            (Array.isArray(group) ? group : [group])
              .filter((k): k is string => typeof k === "string")
              .map(k => sanitizeKeyword(k))
              .filter(Boolean)
          ).filter(g => g.length > 0);
        }
        // flat array ["q1", "q2", ...]
        return arr
          .filter((k): k is string => typeof k === "string")
          .map(k => sanitizeKeyword(k))
          .filter(Boolean)
          .map(k => [k]);
      }
    } catch { /* fall through */ }
  }

  // Fallback: quoted strings
  const quoted = stripped.match(/"([^"]{3,150})"/g);
  if (quoted?.length) {
    return quoted
      .map(s => sanitizeKeyword(s.slice(1, -1)))
      .filter(Boolean)
      .map(k => [k]);
  }

  return [];
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { script, scenes, perSubtitle = false, audioDurationSec = 0 } = body ?? {};

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { geminiKey: true },
  });

  const apiKey = user?.geminiKey ? decrypt(user.geminiKey) : null;
  if (!apiKey) return NextResponse.json({ error: "Gemini key not set", missingKey: "gemini" }, { status: 400 });

  async function callLLM(prompt: string, maxTokens: number, jsonMode = true): Promise<string> {
    return await geminiGenerateText(apiKey!, prompt, maxTokens);
  }

  // ── perSubtitle mode ──────────────────────────────────────────────────────────
  if (perSubtitle) {
    const subtitleList: string[] = Array.isArray(scenes) && scenes.length > 0
      ? scenes.map((s: string) => sanitizeSubtitleForKeyword(s)).filter(Boolean)
      : (script ?? "").split(/\n+/).map((s: string) => sanitizeSubtitleForKeyword(s)).filter(Boolean);

    if (!subtitleList.length) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

    const fullScript = preprocessScript(
      typeof script === "string" && script.trim() ? script : subtitleList.join(" ")
    );

    // Step 0: Analyze script once to get visual direction for consistent B-roll tone
    let visualDirection = "";
    try {
      const analysisPrompt = `Analyze this video script and describe its visual direction in ONE concise English sentence (max 20 words).
Focus on: mood/tone, setting/environment, color palette, energy level, target emotion.
Examples:
- "Dark dramatic tech documentary — neon-lit servers, urgent energy, high-contrast monochrome city"
- "Warm motivational lifestyle — golden hour outdoors, slow motion, bright optimistic energy"
- "Educational calm explainer — clean office, moderate pace, neutral professional tone"

Script: ${fullScript.slice(0, 1500)}

Output ONLY the one-sentence visual direction, nothing else.`;
      visualDirection = (await callLLM(analysisPrompt, 80, false)).trim().replace(/^["']|["']$/g, "");
      console.log(`[extract-keywords] visualDirection: ${visualDirection}`);
    } catch (e) {
      console.warn("[extract-keywords] visualDirection analysis failed, continuing without it:", e);
    }

    const BATCH_SIZE = 15;
    const batches: string[][] = [];
    for (let i = 0; i < subtitleList.length; i += BATCH_SIZE) {
      batches.push(subtitleList.slice(i, i + BATCH_SIZE));
    }

    console.log(`[extract-keywords] perSubtitle: ${subtitleList.length} subtitles → ${batches.length} batches (Gemini)`);

    const allKeywords: string[] = [];
    const allAlternatives: string[][] = [];
    const usedKeywords = new Set<string>();

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (b > 0) await new Promise(r => setTimeout(r, 5000));

      const directionBlock = visualDirection
        ? `\n═══ VISUAL DIRECTION (apply to ALL queries) ═══\n${visualDirection}\n═══ END DIRECTION ═══\n`
        : "";

      const prompt = `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT — read this entire script first to understand the core message, tone, and theme ═══
${fullScript}
═══ END SCRIPT ═══
${directionBlock}
YOUR JOB:
For each subtitle phrase below, write exactly 3 Pexels stock video search queries that MATCH the VISUAL DIRECTION above AND the specific moment in that phrase.

Query 1 — Most specific to the phrase's exact visual moment (must match visual direction tone)
Query 2 — Broader visual that fits the script theme and visual direction
Query 3 — Generic scene fallback (1-2 words max, e.g. "technology", "city night")

CRITICAL RULES:
▸ NO real person names (Dario Amodei, Elon Musk, Sam Altman…) — Pexels has none
▸ NO brand/company names (Anthropic, Google…) — no useful results
▸ Translate people/brands into what they LOOK LIKE visually:
   CEO presenting → "executive keynote stage spotlight"
   AI startup → "developer dark office multiple screens"
   Robot/AI → "humanoid robot arm factory" or "glowing neural network animation"
▸ Every query must describe something a camera can physically film in ONE SHOT
▸ English only, 2–6 words per query
▸ Vary shot styles across the batch: aerial, close-up, wide shot, slow-motion, time-lapse
▸ Ground abstract concepts in concrete objects: "hope" → "child sunrise field", "growth" → "plant sprouting soil close-up"
▸ Keep the visual MOOD consistent with the VISUAL DIRECTION above

OUTPUT — JSON only, zero explanation:
{"keywords":[["q1","q2","q3"],["q1","q2","q3"],...]}
Return exactly ${batch.length} arrays in the same order as the phrases.

SUBTITLE PHRASES (batch ${b + 1}):
${batch.map((s, i) => `${b * BATCH_SIZE + i + 1}. ${s}`).join("\n")}`;

      const maxTokens = Math.min(4096, batch.length * 120 + 300);
      let rawAlts: string[][] = [];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 6000 * attempt));
          const text = await callLLM(prompt, maxTokens);
          console.log(`[extract-keywords] b${b} attempt${attempt}:`, text.slice(0, 120));
          rawAlts = parseKeywordAlternatives(text);
          if (rawAlts.length >= Math.floor(batch.length * 0.7)) break;
        } catch (e) {
          console.error(`[extract-keywords] b${b} attempt${attempt} error:`, e);
        }
      }

      // Pad missing entries with empty arrays (will get generic fallback below)
      while (rawAlts.length < batch.length) rawAlts.push([]);

      const batchKeywords: string[] = [];
      const batchAlts: string[][] = [];

      for (let i = 0; i < batch.length; i++) {
        const alts = rawAlts[i] ?? [];

        // Pick first valid keyword — in perSubtitle mode allow similar keywords
        // because adjacent subtitles can legitimately share visual themes
        let picked = "";
        for (const alt of alts) {
          if (alt && !usedKeywords.has(alt)) {
            picked = alt;
            break;
          }
        }

        // If all alternatives already used, use any valid one (don't fall back to unrelated)
        if (!picked && alts[0]) picked = alts[0];

        // Last resort: ask LLM gave nothing useful, use subtitle text words
        if (!picked) {
          const words = batch[i]
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3 && /^[a-z]/.test(w))
            .slice(0, 3);
          // derive from visual direction if available, otherwise use first content words
          if (words.length >= 2) {
            picked = words.join(" ");
          } else {
            const dirWords = visualDirection
              .toLowerCase()
              .replace(/[^a-z\s]/g, " ")
              .split(/\s+/)
              .filter(w => w.length > 3)
              .slice(0, 2);
            picked = dirWords.length >= 2 ? dirWords.join(" ") : dirWords[0] || words[0] || "scene";
          }
        }

        usedKeywords.add(picked);
        batchKeywords.push(picked);

        // Store alternatives, ensure first matches picked
        const cleanAlts = alts.filter(Boolean);
        if (cleanAlts[0] !== picked) cleanAlts.unshift(picked);
        batchAlts.push(cleanAlts.slice(0, 3));
      }

      allKeywords.push(...batchKeywords);
      allAlternatives.push(...batchAlts);
      console.log(`[extract-keywords] b${b}: ${batchKeywords.length}/${batch.length} keywords`);
    }

    console.log(`[extract-keywords] done: ${allKeywords.length}/${subtitleList.length}`);
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      sceneClipCounts: allKeywords.map(() => 1),
      sceneDurations: subtitleList.map(() => 3),
      keywordsPerScene: 1,
      visualDirection,
    });
  }

  // ── Normal mode (whole script → N clips) ─────────────────────────────────────
  const rawScript = Array.isArray(scenes) && scenes.length > 0 ? scenes.join(" ") : (script ?? "");
  const cleanScript = preprocessScript(rawScript);
  if (!cleanScript) return NextResponse.json({ error: "script or scenes required" }, { status: 400 });

  const sceneList: string[] = Array.isArray(scenes) && scenes.length > 0
    ? scenes : cleanScript.split(/\n+/).filter(Boolean);
  const numScenes = Math.max(1, sceneList.length);

  // คำนวณว่าต้องการกี่ keywords จาก duration
  // สูตร: duration / 3.5s ต่อ clip × buffer 1.6 → จำนวน clip ที่ต้องการ
  // keywords = max(numScenes, ceil(clipsNeeded / 6)) — แต่ละ keyword ดึงได้ ~6 clips
  const durSec = Number(audioDurationSec) > 0 ? Number(audioDurationSec) : 0;
  const CLIP_AVG_SEC = 3.5;
  const BUFFER = 1.6;
  const CLIPS_PER_KW = 6; // conservative estimate — fetch-stock will pull more
  const clipsNeeded = durSec > 0 ? Math.ceil((durSec / CLIP_AVG_SEC) * BUFFER) : numScenes;
  const keywordsNeeded = Math.max(numScenes, Math.ceil(clipsNeeded / CLIPS_PER_KW));
  // แต่ละ scene สร้างกี่ keyword (ปัดขึ้น)
  const kwPerScene = Math.max(1, Math.ceil(keywordsNeeded / numScenes));
  const totalKw = numScenes * kwPerScene;

  console.log(`[extract-keywords] dur=${durSec}s clips_needed=${clipsNeeded} keywords_needed=${keywordsNeeded} kw/scene=${kwPerScene} total=${totalKw}`);

  // Analyze script visual direction first
  let visualDirection = "";
  try {
    const analysisPrompt = `Analyze this video script and describe its visual direction in ONE concise English sentence (max 20 words).
Focus on: mood/tone, setting/environment, color palette, energy level, target emotion.
Script: ${cleanScript.slice(0, 1500)}
Output ONLY the one-sentence visual direction, nothing else.`;
    visualDirection = (await callLLM(analysisPrompt, 80, false)).trim().replace(/^["']|["']$/g, "");
    console.log(`[extract-keywords] visualDirection: ${visualDirection}`);
  } catch {}

  const directionBlock = visualDirection ? `\n═══ VISUAL DIRECTION ═══\n${visualDirection}\n═══ END DIRECTION ═══\n` : "";

  // ถ้าต้องการมากกว่า 1 keyword/scene → ส่ง prompt แบบ multi-kw/scene
  const multiKwMode = kwPerScene > 1;

  const prompt = multiKwMode
    ? `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT ═══
${cleanScript}
═══ END SCRIPT ═══
${directionBlock}
This video is ${durSec.toFixed(0)}s long. We need ${totalKw} distinct B-roll search queries total — ${kwPerScene} per scene — to fill the entire video with varied footage.

For each scene below, write EXACTLY ${kwPerScene} different Pexels search queries that cover different visual moments or angles within that scene.
Each query set should progress through the scene: wide shot → detail shot → action shot (vary the style).

RULES:
  • NEVER use real person names or brand names
    - CEO/founder → "executive keynote stage spotlight"
    - AI company → "server room glowing screens"
  • English only, 2–6 words per query
  • Make queries VISUALLY DISTINCT from each other — no two similar shots
  • Ground abstract concepts in concrete filmable objects

OUTPUT (JSON only, no explanation):
{"keywords":[["q1a","q1b",...],["q2a","q2b",...],...]}
Exactly ${numScenes} arrays, each with exactly ${kwPerScene} queries, in scene order.

SCENES:
${sceneList.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : `You are a Visual Director and B-roll Editor for short-form video (TikTok/Reels).

═══ FULL SCRIPT ═══
${cleanScript}
═══ END SCRIPT ═══
${directionBlock}
STEP 1 — Understand the script's core message, tone, and main visual theme.
STEP 2 — For each scene below, write exactly 3 Pexels stock video search queries:
  Query 1 — Most specific to the scene's exact visual moment (match visual direction tone)
  Query 2 — Broader visual that fits the script theme
  Query 3 — Generic 1-2 word fallback (e.g. "technology", "city night", "business meeting")

RULES:
  • NEVER use real person names or brand names (Pexels has none)
    - CEO/founder → "executive keynote stage spotlight"
    - AI company → "server room glowing screens"
    - Robot/AI → "humanoid robot arm factory"
  • English only, 2–6 words per query
  • Vary shot styles: aerial, close-up, wide, slow-motion, time-lapse
  • Ground abstract concepts in concrete filmable objects

OUTPUT (JSON only, no explanation):
{"keywords":[["q1","q2","q3"],["q1","q2","q3"],...]}
Exactly ${numScenes} arrays in order.

SCENES:
${sceneList.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

  try {
    const maxTokens = Math.min(8192, totalKw * 80 + 400);
    const text = await callLLM(prompt, maxTokens);
    console.log(`[extract-keywords] normal mode (kwPerScene=${kwPerScene}):`, text.slice(0, 200));

    const parsed = parseKeywordAlternatives(text);

    // Build per-scene alternatives
    // multiKwMode: parsed[i] = [kwA, kwB, kwC, ...] — all are primaries for that scene
    // normal mode: parsed[i] = [q1, q2, q3] — q1 is primary, q2/q3 are alternatives
    const allAlternatives: string[][] = [];
    const allKeywords: string[] = [];
    const usedKeywords = new Set<string>();

    if (multiKwMode) {
      // แต่ละ scene → kwPerScene keywords แยกกัน
      for (let i = 0; i < numScenes; i++) {
        const sceneAlts = (parsed[i] ?? []).filter(Boolean);
        // เติมถ้า LLM ให้มาน้อยกว่า kwPerScene
        while (sceneAlts.length < kwPerScene) {
          const fallback = sceneAlts[0] || sceneList[i].toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 3).slice(0, 2).join(" ") || "background scene";
          sceneAlts.push(fallback);
        }
        // สร้าง keyword แยกสำหรับแต่ละ slot ใน scene
        for (let j = 0; j < kwPerScene; j++) {
          let picked = sceneAlts[j] || sceneAlts[0];
          // ถ้าซ้ำมากเกินไป ใช้ตัวถัดไปจาก list ทั้งหมด
          if (isTooSimilar(picked, usedKeywords, 0.8) && sceneAlts.length > j + 1) {
            picked = sceneAlts[j + 1] || picked;
          }
          usedKeywords.add(picked);
          allKeywords.push(picked);
          // alternatives = ทุก query ของ scene นี้ (สลับลำดับให้ primary อยู่หน้า)
          const altsForSlot = [picked, ...sceneAlts.filter(a => a !== picked)].slice(0, 3);
          allAlternatives.push(altsForSlot);
        }
      }
    } else {
      for (let i = 0; i < numScenes; i++) {
        const alts = (parsed[i] ?? []).filter(Boolean);

        let picked = "";
        for (const alt of alts) {
          if (alt && !isTooSimilar(alt, usedKeywords)) { picked = alt; break; }
        }
        if (!picked && alts[0]) picked = alts[0];

        if (!picked) {
          const sceneText = sceneList[i] ?? "";
          const words = sceneText.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
            .filter(w => w.length > 3 && /^[a-z]/.test(w)).slice(0, 3);
          if (words.length >= 2) {
            picked = words.join(" ");
          } else {
            const dirWords = visualDirection.toLowerCase().replace(/[^a-z\s]/g, " ")
              .split(/\s+/).filter(w => w.length > 3).slice(0, 2);
            picked = dirWords.join(" ") || words[0] || "scene";
          }
        }

        usedKeywords.add(picked);
        allKeywords.push(picked);
        const cleanAlts = alts.filter(Boolean);
        if (cleanAlts[0] !== picked) cleanAlts.unshift(picked);
        allAlternatives.push(cleanAlts.slice(0, 3));
      }
    }

    const sceneClipCounts = multiKwMode
      ? sceneList.map(() => kwPerScene)  // แต่ละ scene ได้ kwPerScene clips
      : sceneList.map(() => 1);
    const sceneDurations = sceneList.map(s => Math.max(5, Math.ceil(s.replace(/\s/g, "").length / 3)));

    console.log(`[extract-keywords] ${allKeywords.length} keywords for ${numScenes} scenes (${kwPerScene}/scene, need ${keywordsNeeded})`);
    return NextResponse.json({
      keywords: allKeywords,
      keywordAlternatives: allAlternatives,
      scenes: sceneList,
      keywordsPerScene: kwPerScene,
      sceneClipCounts,
      sceneDurations,
      visualDirection,
    });
  } catch (e) {
    console.error("[extract-keywords] error:", e);
    return NextResponse.json({ keywords: [], keywordAlternatives: [], scenes: [], keywordsPerScene: 1, sceneClipCounts: [], sceneDurations: [] });
  }
}
