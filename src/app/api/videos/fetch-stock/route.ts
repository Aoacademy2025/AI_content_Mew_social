import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import path from "path";
import fs from "fs";

export const maxDuration = 600;
export const runtime = "nodejs";

interface PexelsVideoFile {
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

interface PexelsVideo {
  id: number;
  duration: number;
  width: number;
  height: number;
  url: string;   // e.g. https://www.pexels.com/video/woman-cooking-soup-1234567/
  video_files: PexelsVideoFile[];
}

// Extract human-readable slug from Pexels video URL
// "https://www.pexels.com/video/woman-cooking-soup-1234567/" → "woman cooking soup"
function slugToTitle(url: string): string {
  try {
    const slug = new URL(url).pathname.replace(/^\/video\//, "").replace(/\/$/, "");
    // Remove trailing numeric ID
    return slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

// Search Pexels for portrait videos ≥ minDuration seconds
async function searchPexels(query: string, apiKey: string, minDuration = 3, perPage = 15, page = 1): Promise<PexelsVideo[]> {
  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    size: "medium",
    per_page: String(perPage),
    min_duration: String(minDuration),
    page: String(page),
  });

  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  });

  if (!res.ok) throw new Error(`Pexels search failed: ${res.status}`);
  const data = await res.json();
  return (data.videos ?? []) as PexelsVideo[];
}

// Pick best video file: prefer HD portrait, fallback to any
function pickBestFile(video: PexelsVideo): PexelsVideoFile | null {
  const files = video.video_files.filter(f => f.file_type === "video/mp4");
  const portrait = files.filter(f => f.height > f.width);
  const hd = portrait.find(f => f.quality === "hd") ?? portrait[0];
  if (hd) return hd;
  return files.find(f => f.quality === "hd") ?? files[0] ?? null;
}

function safeUnlink(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function isValidMp4Path(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const size = fs.statSync(filePath).size;
    return size > 1_500; // ignore empty/truncated files
  } catch {
    return false;
  }
}

async function downloadAndCrop(url: string, outPath: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const attemptDelayMs = 1200;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmp = `${outPath}.part`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);

      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 1_500) {
        throw new Error(`Downloaded file too small: ${data.length} bytes`);
      }

      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, outPath);

      if (!isValidMp4Path(outPath)) {
        throw new Error(`Downloaded file failed validation (${outPath})`);
      }

      return;
    } catch (err) {
      safeUnlink(tmp);
      safeUnlink(outPath);
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, attemptDelayMs * attempt));
      console.warn(`[fetch-stock] download retry ${attempt + 1}/${MAX_ATTEMPTS}: ${url}`);
    }
  }

  throw new Error(`Download failed after ${MAX_ATTEMPTS} attempts`);
}

// Search Pixabay for portrait videos
async function searchPixabay(query: string, pixabayKey: string, minDuration = 5): Promise<{ id: number; duration: number; videoUrl: string }[]> {
  const params = new URLSearchParams({
    key: pixabayKey,
    q: query,
    video_type: "film",
    orientation: "vertical",
    per_page: "15",
    min_duration: String(minDuration),
  });
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`);
  if (!res.ok) throw new Error(`Pixabay search failed: ${res.status}`);
  const data = await res.json();
  return (data.hits ?? []).map((h: { id: number; duration: number; videos: { medium?: { url: string }; large?: { url: string } } }) => ({
    id: h.id,
    duration: h.duration,
    videoUrl: h.videos?.large?.url ?? h.videos?.medium?.url ?? "",
  })).filter((v: { videoUrl: string }) => v.videoUrl);
}

// LLM rank: given subtitle texts and candidate titles per keyword,
// return the best-matching candidate index for each keyword.
// Single batched call — returns number[] same length as keywords.
async function llmRankCandidates(
  keywords: string[],
  subtitleTexts: string[],
  candidateTitles: string[][], // [kwIdx][candidateIdx] = title
  llmKey: string,
  useGemini: boolean,
  visualDirection?: string,
): Promise<number[]> {
  // Build compact prompt — one line per keyword
  const lines = keywords.map((kw, ki) => {
    const sub = subtitleTexts[ki] ?? kw;
    const titles = candidateTitles[ki].map((t, i) => `${i}:${t || "untitled"}`).join("|");
    return `${ki}. subtitle="${sub}" candidates=[${titles}]`;
  });

  const directionLine = visualDirection
    ? `\nVIDEO DIRECTION: ${visualDirection}\nPrioritize candidates that match this overall visual tone/theme.\n`
    : "";

  const prompt = `You are a B-roll video editor. For each subtitle, pick the candidate video index (0-based) that BEST matches the subtitle's visual content AND the overall video direction.
${directionLine}
RULES:
- Output ONLY a JSON array of integers, one per subtitle, same order
- Pick the index whose title most literally matches what is described in the subtitle
- Prefer candidates that fit the VIDEO DIRECTION tone (mood, setting, energy)
- Prefer concrete, specific matches over generic ones
- If no candidate fits well, pick index 0

${lines.join("\n")}

OUTPUT (JSON array of ${keywords.length} integers):`;

  try {
    let text = "[]";
    if (useGemini) {
      text = await geminiGenerateText(llmKey, prompt, 512, 0);
    } else {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${llmKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 512,
          temperature: 0,
        }),
      });
      if (r.ok) { const d = await r.json(); text = d.choices?.[0]?.message?.content ?? "[]"; }
    }

    // Try bare array first, then extract from object like {"indices":[...]} or {"result":[...]}
    let parsed: unknown[] = [];
    const arrMatch = text.match(/\[[\d,\s]+\]/);
    if (arrMatch) {
      parsed = JSON.parse(arrMatch[0]);
    } else {
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        const obj = JSON.parse(objMatch[0]);
        const arr = Array.isArray(obj) ? obj : Object.values(obj).find(v => Array.isArray(v));
        if (Array.isArray(arr)) parsed = arr;
      }
    }

    if (parsed.length !== keywords.length) {
      console.warn(`[fetch-stock] LLM ranking length mismatch: got ${parsed.length}, expected ${keywords.length} — using longest-duration fallback`);
      return keywords.map(() => 0);
    }

    return parsed.map((v, i) => {
      const n = typeof v === "number" ? v : parseInt(String(v), 10);
      const maxIdx = (candidateTitles[i]?.length ?? 1) - 1;
      return isNaN(n) ? 0 : Math.max(0, Math.min(n, maxIdx));
    });
  } catch {
    return keywords.map(() => 0);
  }
}

// POST /api/videos/fetch-stock
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    keywords,
    keywordAlternatives,
    download = false,
    totalDurationSec = 0,
    overrideClipCount = 0,
    stockSource = "both",
    subtitleTexts,
    perSubtitleMode: perSubtitleFlag = false,
    preferredLLM,
    fullScript,
    visualDirection,
  }: {
    keywords: string[];
    keywordAlternatives?: string[][];
    download?: boolean;
    totalDurationSec?: number;
    overrideClipCount?: number;
    stockSource?: string;
    subtitleTexts?: string[];
    perSubtitleMode?: boolean;
    preferredLLM?: string;
    fullScript?: string;
    visualDirection?: string;
  } = body ?? {};

  const usePexels = stockSource === "pexels" || stockSource === "both";
  const usePixabay = stockSource === "pixabay" || stockSource === "both";

  if (!keywords?.length) return NextResponse.json({ error: "keywords required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { pixabayKey: true, pexelsKey: true, geminiKey: true, openaiKey: true, ttsProvider: true },
  });
  const pexelsKey = user?.pexelsKey ? Buffer.from(user.pexelsKey, "base64").toString("utf-8") : null;
  const pixabayKey = user?.pixabayKey ? Buffer.from(user.pixabayKey, "base64").toString("utf-8") : null;

  const canUsePexels = usePexels && !!pexelsKey;
  const canUsePixabay = usePixabay && !!pixabayKey;

  if (!canUsePexels && !canUsePixabay) {
    const needPexels = usePexels;
    const needPixabay = usePixabay;
    if (needPexels && needPixabay) {
      return NextResponse.json(
        { error: "No usable stock source configured. Add Pexels or Pixabay key in Settings > API Keys", missingKey: stockSource === "both" ? "pexels" : (needPexels ? "pexels" : "pixabay") },
        { status: 400 },
      );
    }
    if (needPexels) return NextResponse.json({ error: "Pexels API key ยังไม่ได้ตั้งค่า — ไปที่ Settings > API Keys", missingKey: "pexels" }, { status: 400 });
    return NextResponse.json({ error: "Pixabay API key ยังไม่ได้ตั้งค่า — ไปที่ Settings", missingKey: "pixabay" }, { status: 400 });
  }

  if (usePexels && !canUsePexels) {
    console.log("[fetch-stock] Pexels requested but key missing; continuing with Pixabay only");
  }
  if (usePixabay && !canUsePixabay) {
    console.log("[fetch-stock] Pixabay requested but key missing; continuing with Pexels only");
  }

  // Resolve LLM key for ranking — respects preferredLLM from client
  let llmKey: string | null = null;
  let useGemini = false;
  const wantGemini = preferredLLM === "gemini";
  const wantOpenAI = preferredLLM === "openai";
  if (wantGemini && user?.geminiKey) { llmKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
  else if (wantOpenAI && user?.openaiKey) { llmKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }
  else if (user?.geminiKey) { llmKey = Buffer.from(user.geminiKey, "base64").toString("utf-8"); useGemini = true; }
  else if (user?.openaiKey) { llmKey = Buffer.from(user.openaiKey, "base64").toString("utf-8"); }

  function avgCutSec(dur: number): number {
    if (dur <= 10) return 5;
    if (dur <= 20) return 4;
    if (dur <= 40) return 3.5;
    return 2.5;
  }
  void avgCutSec; // used for future adaptive logic

  const BUFFER = 1.4;
  const autoClipsNeeded = totalDurationSec > 0
    ? Math.max(2, Math.ceil((totalDurationSec / 2.0) * BUFFER))
    : keywords.length;
  const totalClipsNeeded = overrideClipCount > 0 ? overrideClipCount : autoClipsNeeded;
  const cappedClipsNeeded = Math.min(totalClipsNeeded, overrideClipCount > 0 ? 500 : 400);
  const clipsPerKeyword = keywords.length > 0
    ? Math.min(10, Math.max(1, Math.ceil(cappedClipsNeeded / keywords.length)))
    : 1;

  console.log(`[fetch-stock] duration=${totalDurationSec}s need=${totalClipsNeeded} clips${overrideClipCount > 0 ? " (manual)" : " (auto)"}, ${clipsPerKeyword}/keyword over ${keywords.length} keywords`);

  const rendersDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(rendersDir, { recursive: true });

  const userId = (session.user as { id: string }).id;
  const userPrefix = `stock-${userId}-`;

  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(rendersDir)) {
      if (!f.startsWith(userPrefix) || !f.endsWith(".mp4")) continue;
      const fp = path.join(rendersDir, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_AGE_MS) fs.unlinkSync(fp);
    }
  } catch {}

  const results: {
    keyword: string;
    pexelsId: number;
    duration: number;
    videoUrl: string;
    localPath?: string;
    localUrl?: string;
  }[] = [];

  const usedIds = new Set<number>();

  async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length > 0) { const item = queue.shift()!; await fn(item); }
    });
    await Promise.all(workers);
  }

  type FoundVideo = { keyword: string; id: number; duration: number; link: string };
  // Extended candidate that keeps Pexels URL slug for LLM ranking
  type CandidateVideo = FoundVideo & { title: string };

  const srcLabel = canUsePexels && canUsePixabay ? "Pexels+Pixabay" : canUsePexels ? "Pexels" : "Pixabay";
  console.log(`[fetch-stock] source=${srcLabel}`);

  // perSubtitleMode: explicit flag (survives retry with subset) OR clip count exactly matches keyword count
  const isPerSubtitleMode = perSubtitleFlag || (overrideClipCount > 0 && overrideClipCount === keywords.length);
  const basePerPage = isPerSubtitleMode ? 25 : Math.min(30, clipsPerKeyword * 3);

  // ── Search phase — try keyword alternatives in order until candidates found ──
  const candidatesByKeyword: CandidateVideo[][] = await Promise.all(
    keywords.map(async (keyword, ki): Promise<CandidateVideo[]> => {
      // Build list of queries to try: alternatives first, then broad fallbacks
      const alts = keywordAlternatives?.[ki] ?? [];
      const queriesToTry = [
        ...alts.filter(Boolean),
        keyword,
        keyword.split(" ").slice(0, 2).join(" "),
        keyword.split(" ")[0],
      ].filter((q, idx, arr) => q && arr.indexOf(q) === idx); // deduplicate

      try {
        for (const query of queriesToTry) {
          console.log(`[fetch-stock] searching "${query}" (perPage=${basePerPage}) from ${srcLabel}`);

          const [pexelsRaw, pixabayRaw] = await Promise.allSettled([
            canUsePexels
              ? searchPexels(query, pexelsKey!, 3, basePerPage)
              : Promise.resolve([] as PexelsVideo[]),
            canUsePixabay
              ? searchPixabay(query, pixabayKey).catch(() => [] as { id: number; duration: number; videoUrl: string }[])
              : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
          ]);

          const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
          const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];

          const candidates: CandidateVideo[] = [];
          for (const v of pexelsVideos) {
            const file = pickBestFile(v);
            if (!file) continue;
            const title = slugToTitle(v.url ?? "");
            candidates.push({ keyword, id: v.id, duration: v.duration, link: file.link, title });
          }
          for (const pv of pixabayVideos) {
            candidates.push({ keyword, id: pv.id + 9_000_000, duration: pv.duration, link: pv.videoUrl, title: query });
          }

          if (candidates.length > 0) {
            console.log(`[fetch-stock] "${query}": ${candidates.length} candidates (used alt ${queriesToTry.indexOf(query) + 1}/${queriesToTry.length})`);
            return candidates;
          }
        }

        // Last resort: try page 2 of the first query for fresh IDs
        if (canUsePexels && queriesToTry[0]) {
          try {
            const page2 = await searchPexels(queriesToTry[0], pexelsKey!, 3, basePerPage, 2);
            const candidates: CandidateVideo[] = [];
            for (const v of page2) {
              const file = pickBestFile(v);
              if (!file) continue;
              candidates.push({ keyword, id: v.id, duration: v.duration, link: file.link, title: slugToTitle(v.url ?? "") });
            }
            if (candidates.length > 0) {
              console.log(`[fetch-stock] "${keyword}": ${candidates.length} candidates from page 2`);
              return candidates;
            }
          } catch {}
        }
        console.warn(`[fetch-stock] "${keyword}": no candidates found after ${queriesToTry.length} queries + page2`);
        return [];
      } catch (err) {
        console.error(`[fetch-stock] error for "${keyword}":`, err);
        return [];
      }
    })
  );

  // ── LLM ranking phase (per-subtitle mode only, 1 batched call) ──
  let bestIdxByKeyword: number[] = keywords.map(() => 0);

  if (isPerSubtitleMode && llmKey && subtitleTexts?.length === keywords.length) {
    const candidateTitles = candidatesByKeyword.map(cs => cs.map(c => c.title));
    const hasAnyCandidates = candidateTitles.some(t => t.length > 0);
    if (hasAnyCandidates) {
      console.log(`[fetch-stock] LLM ranking ${keywords.length} keywords in 1 call`);
      try {
        bestIdxByKeyword = await llmRankCandidates(keywords, subtitleTexts, candidateTitles, llmKey, useGemini, visualDirection);
        console.log(`[fetch-stock] LLM picked indices:`, bestIdxByKeyword);
      } catch (e) {
        console.error(`[fetch-stock] LLM ranking failed, falling back to best-duration pick:`, e);
        // Fallback: pick candidate with longest duration (more content = better match than index 0)
        bestIdxByKeyword = candidatesByKeyword.map(cs => {
          let best = 0;
          for (let i = 1; i < cs.length; i++) { if (cs[i].duration > cs[best].duration) best = i; }
          return best;
        });
      }
    }
  } else if (isPerSubtitleMode) {
    // No LLM key or subtitle texts mismatch — pick longest-duration candidate instead of index 0
    bestIdxByKeyword = candidatesByKeyword.map(cs => {
      let best = 0;
      for (let i = 1; i < cs.length; i++) { if (cs[i].duration > cs[best].duration) best = i; }
      return best;
    });
    if (!llmKey) console.warn(`[fetch-stock] no LLM key — using longest-duration fallback`);
  }

  // ── Pick phase — apply LLM choice first, then fill remaining slots, dedup globally ──
  const found: FoundVideo[] = [];

  for (let ki = 0; ki < keywords.length; ki++) {
    const candidates = candidatesByKeyword[ki];
    if (!candidates.length) continue;

    if (isPerSubtitleMode) {
      // Per-subtitle: pick LLM-chosen index first, skip if already used, then try others
      const rawPreferred = bestIdxByKeyword[ki] ?? 0;
      const preferred = Math.max(0, Math.min(rawPreferred, candidates.length - 1));
      const ordered = [
        preferred,
        ...candidates.map((_, i) => i).filter(i => i !== preferred),
      ];
      let picked = false;
      for (const idx of ordered) {
        const c = candidates[idx];
        if (!c || usedIds.has(c.id)) continue;
        usedIds.add(c.id);
        found.push({ keyword: c.keyword, id: c.id, duration: c.duration, link: c.link });
        picked = true;
        break; // 1 clip per subtitle
      }
      if (!picked) {
        const kw = keywords[ki];
        // Build progressively broader fallback queries
        const words = kw.split(" ");
        const broadFallbacks = [
          words.slice(0, 2).join(" "),          // first 2 words
          words[0],                              // first word only
          words[words.length - 1],              // last word (often the noun)
          "people city street",                 // generic human activity
          "nature landscape aerial",            // generic nature
          "technology abstract dark",           // generic tech
        ].filter((q, i, a) => q && q !== kw && a.indexOf(q) === i);

        for (const fbQuery of broadFallbacks) {
          if (picked) break;
          try {
            const [fbPexels, fbPixabay] = await Promise.all([
              canUsePexels ? searchPexels(fbQuery, pexelsKey!, 3, 30) : Promise.resolve([] as PexelsVideo[]),
              canUsePixabay ? searchPixabay(fbQuery, pixabayKey!) : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
            ]);
            // Try page 2 of Pexels for more variety if page 1 all used
            const fbPexels2 = canUsePexels && fbPexels.every(v => usedIds.has(v.id))
              ? await searchPexels(fbQuery, pexelsKey!, 3, 30).catch(() => [] as PexelsVideo[])
              : [];
            const allPexels = [...fbPexels, ...fbPexels2];
            for (const v of allPexels) {
              const file = pickBestFile(v);
              if (!file || usedIds.has(v.id)) continue;
              usedIds.add(v.id);
              found.push({ keyword: kw, id: v.id, duration: v.duration, link: file.link });
              picked = true;
              break;
            }
            if (!picked) {
              for (const pv of fbPixabay) {
                if (usedIds.has(pv.id + 9_000_000)) continue;
                usedIds.add(pv.id + 9_000_000);
                found.push({ keyword: kw, id: pv.id + 9_000_000, duration: pv.duration, link: pv.videoUrl });
                picked = true;
                break;
              }
            }
          } catch { /* ignore, try next fallback */ }
        }
        if (!picked) console.warn(`[fetch-stock] "${kw}": no unique clip found after all fallbacks`);
      }
    } else {
      // Normal mode: pick up to clipsPerKeyword, interleave Pexels+Pixabay
      let picked = 0;
      for (const c of candidates) {
        if (picked >= clipsPerKeyword) break;
        if (usedIds.has(c.id)) continue;
        usedIds.add(c.id);
        found.push({ keyword: c.keyword, id: c.id, duration: c.duration, link: c.link });
        picked++;
      }
    }
  }

  console.log(`[fetch-stock] found ${found.length} clips total`);
  if (!found.length) return NextResponse.json({ results: [] });

  // ── Download phase ──
  await withConcurrency(found, 5, async ({ keyword, id, duration, link }) => {
    if (download) {
      const outFile = `${userPrefix}${id}.mp4`;
      const outPath = path.join(rendersDir, outFile);
      if (isValidMp4Path(outPath)) {
        console.log(`[fetch-stock] cache hit: ${outFile}`);
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
        return;
      }
      console.log(`[fetch-stock] downloading: ${outFile}`);
      try {
        await downloadAndCrop(link, outPath);
        if (!isValidMp4Path(outPath)) return;
        results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
      } catch (e) {
        console.error(`[fetch-stock] failed to download ${outFile}:`, e);
      }
    } else {
      results.push({ keyword, pexelsId: id, duration, videoUrl: link });
    }
  });

  console.log(`[fetch-stock] downloaded ${results.length} clips`);
  return NextResponse.json({ results });
}

// DELETE /api/videos/fetch-stock — no-op, files are kept
export async function DELETE() {
  return NextResponse.json({ deleted: 0 });
}
