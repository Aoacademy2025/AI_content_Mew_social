import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
  video_files: PexelsVideoFile[];
}

// Search Pexels for portrait videos ≥ minDuration seconds
async function searchPexels(query: string, apiKey: string, minDuration = 3, perPage = 15): Promise<PexelsVideo[]> {
  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    size: "medium",
    per_page: String(perPage),
    min_duration: String(minDuration),
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
  // Prefer HD portrait (height > width)
  const portrait = files.filter(f => f.height > f.width);
  const hd = portrait.find(f => f.quality === "hd") ?? portrait[0];
  if (hd) return hd;
  // Fallback: any hd
  return files.find(f => f.quality === "hd") ?? files[0] ?? null;
}

// Download video directly (no ffmpeg crop — Remotion handles cropping at render time)
function downloadAndCrop(url: string, outPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`Downloaded file too small: ${buf.length} bytes`);
      fs.writeFileSync(outPath, buf);
      return resolve();
    } catch (e) {
      reject(e);
    }
  });
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

// POST /api/videos/fetch-stock
// Body: { keywords: string[], download?: boolean, totalDurationSec?: number }
// Returns: { results: { keyword, videoUrl, localPath?, duration, pexelsId }[] }
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    keywords,
    download = false,
    totalDurationSec = 0,
    overrideClipCount = 0,
    stockSource = "both",  // "pexels" | "pixabay" | "both"
  }: { keywords: string[]; download?: boolean; totalDurationSec?: number; overrideClipCount?: number; stockSource?: string } = body ?? {};

  const usePexels  = stockSource === "pexels"  || stockSource === "both";
  const usePixabay = stockSource === "pixabay" || stockSource === "both";

  if (!keywords?.length) return NextResponse.json({ error: "keywords required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { pixabayKey: true, pexelsKey: true } });
  const pexelsKey = user?.pexelsKey ? Buffer.from(user.pexelsKey, "base64").toString("utf-8") : null;
  const pixabayKey = user?.pixabayKey ? Buffer.from(user.pixabayKey, "base64").toString("utf-8") : null;

  if (usePexels && !pexelsKey) return NextResponse.json({ error: "Pexels API key ยังไม่ได้ตั้งค่า — ไปที่ Settings > API Keys", missingKey: "pexels" }, { status: 400 });
  if (usePixabay && !pixabayKey) return NextResponse.json({ error: "Pixabay API key ยังไม่ได้ตั้งค่า — ไปที่ Settings", missingKey: "pixabay" }, { status: 400 });

  // Adaptive cut duration: short scripts get longer cuts (fewer clips), long scripts get snappier cuts
  // ≤10s → avg 5s/cut, 20s → 4s, 30s → 3.5s, 60s+ → 2.5s
  function avgCutSec(dur: number): number {
    if (dur <= 10) return 5;
    if (dur <= 20) return 4;
    if (dur <= 40) return 3.5;
    return 2.5;
  }

  const avgCut = avgCutSec(totalDurationSec);
  const BUFFER = 1.3;
  const autoClipsNeeded = totalDurationSec > 0
    ? Math.max(2, Math.ceil((totalDurationSec / avgCut) * BUFFER))
    : keywords.length;
  // User override wins; otherwise use adaptive auto calculation
  const totalClipsNeeded = overrideClipCount > 0 ? overrideClipCount : autoClipsNeeded;

  // Cap total clips to avoid VPS timeout
  const cappedClipsNeeded = Math.min(totalClipsNeeded, 15);
  const clipsPerKeyword = 1;

  console.log(`[fetch-stock] duration=${totalDurationSec}s avgCut=${avgCut}s need=${totalClipsNeeded} clips${overrideClipCount > 0 ? " (manual)" : " (auto)"}, ${clipsPerKeyword}/keyword over ${keywords.length} keywords`);

  const rendersDir = path.join(process.cwd(), "stocks");
  fs.mkdirSync(rendersDir, { recursive: true });

  const results: {
    keyword: string;
    pexelsId: number;
    duration: number;
    videoUrl: string;
    localPath?: string;
    localUrl?: string;
  }[] = [];

  // Track used video IDs globally — no duplicates across all keywords
  const usedIds = new Set<number>();

  // Concurrency helper
  async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length > 0) { const item = queue.shift()!; await fn(item); }
    });
    await Promise.all(workers);
  }

  type FoundVideo = { keyword: string; id: number; duration: number; link: string };

  // Search phase: query selected sources (Pexels / Pixabay / Both) simultaneously per keyword
  // then merge and pick up to clipsPerKeyword unique clips
  const srcLabel = usePexels && usePixabay ? "Pexels+Pixabay" : usePexels ? "Pexels" : "Pixabay";
  console.log(`[fetch-stock] source=${srcLabel}`);

  const searchResults = await Promise.all(
    keywords.map(async (keyword): Promise<FoundVideo[]> => {
      try {
        console.log(`[fetch-stock] searching "${keyword}" (want ${clipsPerKeyword}) from ${srcLabel}`);
        const perPage = Math.min(30, clipsPerKeyword * 3);
        const shortQuery = keyword.split(" ").slice(0, 2).join(" ");

        // Fire only selected sources in parallel
        const [pexelsRaw, pixabayRaw] = await Promise.allSettled([
          usePexels
            ? searchPexels(keyword, pexelsKey!, 3, perPage)
                .then(r => r.length ? r : shortQuery !== keyword ? searchPexels(shortQuery, pexelsKey!, 3, perPage) : r)
            : Promise.resolve([] as PexelsVideo[]),
          usePixabay && pixabayKey
            ? searchPixabay(keyword, pixabayKey)
                .catch(() => [] as { id: number; duration: number; videoUrl: string }[])
            : Promise.resolve([] as { id: number; duration: number; videoUrl: string }[]),
        ]);

        const pexelsVideos = pexelsRaw.status === "fulfilled" ? pexelsRaw.value : [];
        const pixabayVideos = pixabayRaw.status === "fulfilled" ? pixabayRaw.value : [];

        // Convert both to FoundVideo candidates (interleave for variety)
        const candidates: FoundVideo[] = [];

        const pexelsCandidates: FoundVideo[] = [];
        for (const v of pexelsVideos) {
          if (usedIds.has(v.id)) continue;
          const file = pickBestFile(v);
          if (!file) continue;
          pexelsCandidates.push({ keyword, id: v.id, duration: v.duration, link: file.link });
        }

        const pixabayCandidates: FoundVideo[] = [];
        for (const pv of pixabayVideos) {
          if (usedIds.has(pv.id + 9_000_000)) continue; // offset to avoid ID collision with Pexels
          pixabayCandidates.push({ keyword, id: pv.id + 9_000_000, duration: pv.duration, link: pv.videoUrl });
        }

        // Interleave: Pexels, Pixabay, Pexels, Pixabay... for variety
        const maxLen = Math.max(pexelsCandidates.length, pixabayCandidates.length);
        for (let i = 0; i < maxLen; i++) {
          if (pexelsCandidates[i]) candidates.push(pexelsCandidates[i]);
          if (pixabayCandidates[i]) candidates.push(pixabayCandidates[i]);
        }

        // Pick up to clipsPerKeyword, marking IDs as used
        const picked: FoundVideo[] = [];
        for (const c of candidates) {
          if (picked.length >= clipsPerKeyword) break;
          if (usedIds.has(c.id)) continue;
          usedIds.add(c.id);
          picked.push(c);
        }

        console.log(`[fetch-stock] "${keyword}": pexels=${pexelsCandidates.length} pixabay=${pixabayCandidates.length} picked=${picked.length}`);
        return picked;
      } catch (err) {
        console.error(`[fetch-stock] error for "${keyword}":`, err);
        return [];
      }
    })
  );

  const found = searchResults.flat();
  console.log(`[fetch-stock] found ${found.length} clips total`);

  if (!found.length) return NextResponse.json({ results: [] });

  // Download phase: max 1 concurrent to avoid VPS timeout
  await withConcurrency(found, 1, async ({ keyword, id, duration, link }) => {
    if (download) {
      const ts = Date.now() + Math.random();
      const slug = keyword.replace(/[^a-z0-9]/gi, "-").slice(0, 20).toLowerCase();
      const outFile = `stock-${slug}-${Math.round(ts)}.mp4`;
      const outPath = path.join(rendersDir, outFile);
      console.log(`[fetch-stock] downloading: ${outFile}`);
      await downloadAndCrop(link, outPath);
      const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      if (fileSize < 1000) return;
      results.push({ keyword, pexelsId: id, duration, videoUrl: link, localPath: outPath, localUrl: `/api/stocks/${outFile}` });
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
