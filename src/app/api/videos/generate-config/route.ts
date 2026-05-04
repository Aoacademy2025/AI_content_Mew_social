import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import type { BrollVideo, KeywordPopupItem, ShortVideoConfig, SubtitleStylePreset } from "@/remotion/types";

export const maxDuration = 60;
export const runtime = "nodejs";

function normalizeBgVideos(raw: BrollVideo[], audioDurationSec: number, fps: number): BrollVideo[] {
  const minDuration = 1 / Math.max(1, fps);
  const epsilon = 0.001;
  const normalized: BrollVideo[] = [];

  for (const seg of raw) {
    if (!seg?.src?.trim()) continue;
    let start = Number(seg.start);
    let end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    start = Math.max(0, Math.min(start, audioDurationSec));
    end = Math.min(Math.max(end, start + minDuration), audioDurationSec);
    if (end - start < minDuration) continue;

    const clipDuration = seg.clipDuration && seg.clipDuration > 0 ? Number(seg.clipDuration) : undefined;
    const clipOffset = Number.isFinite(seg.clipOffset as number) && (seg.clipOffset ?? 0) > 0 ? (seg.clipOffset as number) : 0;

    normalized.push({
      ...seg,
      src: seg.src.trim(),
      start,
      end,
      clipDuration,
      clipOffset,
    });
  }

  if (!normalized.length) return [];

  normalized.sort((a, b) => a.start - b.start);
  const deduped: BrollVideo[] = [];

  for (const seg of normalized) {
    if (!deduped.length) {
      deduped.push(seg);
      continue;
    }

    const prev = deduped[deduped.length - 1];
    if (seg.start < prev.end - epsilon) {
      if (seg.src === prev.src) {
        prev.end = Math.max(prev.end, seg.end);
      } else {
        seg.start = prev.end;
      }
    }

    if (seg.end - seg.start >= minDuration) {
      deduped.push(seg);
    }
  }

  return deduped;
}

function fillBgGaps(raw: BrollVideo[], audioDurationSec: number): BrollVideo[] {
  const EPS = 0.01;
  if (!raw.length) return [];

  raw.sort((a, b) => a.start - b.start);
  const filled: BrollVideo[] = [];
  let cursor = 0;

  for (const seg of raw) {
    const start = Math.max(0, Math.min(seg.start, audioDurationSec));
    const end = Math.min(audioDurationSec, Math.max(seg.end, start + EPS));

    if (start > cursor + EPS) {
      const filler = filled.length > 0 ? filled[filled.length - 1] : raw[0];
      filled.push({
        src: filler.src,
        start: cursor,
        end: start,
        clipOffset: 0,
        clipDuration: filler.clipDuration,
      });
    }

    const safeStart = Math.max(cursor, start);
    if (end > safeStart + EPS) {
      filled.push({ ...seg, start: safeStart, end });
      cursor = Math.max(cursor, end);
    }
  }

  if (cursor < audioDurationSec - EPS) {
    const filler = filled[filled.length - 1];
    if (filler) {
      filled.push({
        src: filler.src,
        start: cursor,
        end: audioDurationSec,
        clipOffset: 0,
        clipDuration: filler.clipDuration,
      });
    }
  }

  return filled;
}

type Cap = { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" };
type StockVideo = { keyword: string; localUrl?: string; videoUrl: string; duration: number };

// Auto-scale font size down for longer phrases so they fit on one line (1080px wide, 88% usable = ~950px)
// Thai chars ~= fontSize * 0.85 wide on average (Kanit/Leelawadee)
// Max chars that fit on one line at baseSize: floor(950 / (baseSize * 0.85))
function autoScaleSize(text: string, baseSize: number): number {
  const usableWidth = 950; // 1080 * 0.88
  const charWidthRatio = 0.85;
  const maxCharsOneLine = Math.floor(usableWidth / (baseSize * charWidthRatio));
  const len = text.length;
  if (len <= maxCharsOneLine) return baseSize;
  // Scale down proportionally so text fits in one line, minimum 60% of base
  const scale = Math.max(0.6, maxCharsOneLine / len);
  return Math.round(baseSize * scale);
}

function detectStyle(
  text: string,
  tag: "hook" | "body" | "cta" | undefined,
  baseSize: number,
  primaryColor: string,
  accentColor: string,
): { color: string; size: number; isHighlight: boolean } {
  const scaled = autoScaleSize(text, baseSize);
  // CTA → accent color
  if (tag === "cta") return { color: accentColor, size: scaled, isHighlight: true };
  // Hook → primary color (slightly larger)
  if (tag === "hook") return { color: primaryColor, size: Math.round(scaled * 1.05), isHighlight: false };
  // Numbers/stats → accent
  if (/[0-9๐-๙]/.test(text)) return { color: accentColor, size: Math.round(scaled * 1.1), isHighlight: true };
  // Default (body) → primary
  return { color: primaryColor, size: scaled, isHighlight: false };
}

// POST /api/videos/generate-config
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    sceneCaptions = [],
    stockVideos = [],
    voiceFile,
    audioDurationMs,
    fps = 30,
    fontFamily,
    subtitlePosition = 75,
    subtitleSize = 80,
    subtitleColor,
    subtitleAccentColor,
    subtitleStylePreset,
    subtitleFontWeight = 900,
    scenes = [],
    keywordsPerScene = 5,
    sceneClipCounts = [] as number[],
    sceneDurations = [] as number[],
  }: {
    sceneCaptions?: Cap[];
    stockVideos: StockVideo[];
    voiceFile: string;
    audioDurationMs: number;
    fps?: number;
    fontFamily?: string;
    subtitlePosition?: number;
    subtitleSize?: number;
    subtitleColor?: string;
    subtitleAccentColor?: string;
    subtitleStylePreset?: SubtitleStylePreset;
    subtitleFontWeight?: number;
    scenes?: string[];
    keywordsPerScene?: number;
    sceneClipCounts?: number[];
    sceneDurations?: number[];
  } = body ?? {};

  const primaryColor = subtitleColor ?? "#FFFFFF";
  const accentColor  = subtitleAccentColor ?? "#FFE500";

  console.log(`[config] start: ${stockVideos.length} clips, ${sceneCaptions.length} captions, ${audioDurationMs}ms`);

  if (!voiceFile) return NextResponse.json({ error: "voiceFile required" }, { status: 400 });
  if (!audioDurationMs) return NextResponse.json({ error: "audioDurationMs required" }, { status: 400 });

  const audioDurationSec = audioDurationMs / 1000;
  const durationInFrames = Math.round(audioDurationSec * fps);

  // 1. Build keywordPopups
  // Sort by startMs first so overlapping/out-of-order captions don't break alignment
  const validCaptions = sceneCaptions
    .filter(c => c.text.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  // Fill gaps: each caption ends exactly when the next one starts.
  // Also clamp endMs so it never equals startMs (minimum 1 frame = 1000/fps ms).
  const minFrameMs = Math.ceil(1000 / fps);
  const gapFilled = validCaptions.map((c, i) => {
    const nextStart = i < validCaptions.length - 1 ? validCaptions[i + 1].startMs : audioDurationMs;
    const endMs = Math.max(c.endMs, nextStart, c.startMs + minFrameMs);
    return { ...c, endMs: Math.min(endMs, audioDurationMs) };
  });

  const keywordPopups: KeywordPopupItem[] = gapFilled
    .map((c) => {
      const text = c.text.trim();
      const { color, size, isHighlight } = detectStyle(text, c.tag, subtitleSize, primaryColor, accentColor);
      const startFrame = Math.round((c.startMs / 1000) * fps);
      const endFrame   = Math.max(startFrame + 1, Math.round((c.endMs / 1000) * fps));
      return {
        text,
        start: startFrame,
        end: endFrame,
        color,
        size,
        isHighlight,
        topPercent: subtitlePosition,
        fontWeight: subtitleFontWeight,
        tag: c.tag,
      };
    });

  // 2. Build bgVideos
  //
  // Strategy depends on how many clips user selected vs audio duration:
  //
  // EVEN-SPLIT mode (when user manually picked clips):
  //   Each selected clip gets an equal slice of the total audio duration.
  //   Guarantees every clip appears exactly once, in order, filling the full video.
  //   clipOffset=0 always (play from start, <Video loop> handles short clips).
  //
  // SCENE-AWARE mode (auto / many clips):
  //   Map clips to script scenes by keyword, use adaptive cut cycling within each scene.

  const validStocks = stockVideos.filter(sv => sv.localUrl || sv.videoUrl);
  let bgVideos: BrollVideo[] = [];

  if (validStocks.length > 0) {
    const n = validStocks.length;

    // ── EVEN-SPLIT: divide total duration equally across all selected clips ──
    // Use this when clips are few (≤ scenes count × 3) — user manually curated them.
    // Each clip plays from second 0 for its slice; <Video loop> fills short clips.
    const numScenes = Math.max(1, scenes.length);
    const useEvenSplit = n <= numScenes * 4; // few clips → guaranteed equal airtime

    if (useEvenSplit) {
      const sliceSec = audioDurationSec / n;
      console.log(`[config] even-split: ${n} clips × ${sliceSec.toFixed(2)}s each`);
      for (let i = 0; i < n; i++) {
        const sv  = validStocks[i];
        const src = sv.localUrl ?? sv.videoUrl;
        bgVideos.push({
          src,
          start:       i * sliceSec,
          end:         (i + 1) * sliceSec,
          clipOffset:  0,
          clipDuration: sv.duration > 0 ? sv.duration : 10,
        });
      }
    } else {
      // ── SCENE-AWARE: map clips to scenes, adaptive cut cycling ──
      console.log(`[config] scene-aware: ${n} clips across ${numScenes} scenes`);

      // Build scene time boundaries — prefer sceneDurations from extract-keywords,
      // fallback to equal splits. Then snap each boundary to nearest caption timestamp.
      const sceneBoundaries: { startSec: number; endSec: number }[] = [];

      const hasSceneDurations = Array.isArray(sceneDurations) && sceneDurations.length === numScenes;
      if (hasSceneDurations) {
        // Use extract-keywords scene duration estimates
        let cumSec = 0;
        for (const dur of sceneDurations) {
          sceneBoundaries.push({ startSec: cumSec, endSec: cumSec + dur });
          cumSec += dur;
        }
        // Scale to actual audio duration in case estimates are off
        const estimatedTotal = sceneBoundaries[sceneBoundaries.length - 1].endSec;
        if (estimatedTotal > 0 && Math.abs(estimatedTotal - audioDurationSec) > 1) {
          const scale = audioDurationSec / estimatedTotal;
          for (const b of sceneBoundaries) { b.startSec *= scale; b.endSec *= scale; }
        }
      } else {
        // Equal splits fallback
        const dur = audioDurationSec / numScenes;
        for (let i = 0; i < numScenes; i++)
          sceneBoundaries.push({ startSec: i * dur, endSec: (i + 1) * dur });
      }

      // Snap scene boundaries to actual caption timestamps for tighter sync
      if (sceneCaptions.length > 0) {
        for (let si = 1; si < sceneBoundaries.length; si++) {
          const target = sceneBoundaries[si].startSec;
          // Find nearest caption startMs to this boundary
          let best = sceneCaptions[0];
          let bestDist = Infinity;
          for (const c of sceneCaptions) {
            const dist = Math.abs(c.startMs / 1000 - target);
            if (dist < bestDist) { bestDist = dist; best = c; }
          }
          // Only snap if within 3s of estimated boundary
          if (bestDist < 3) {
            const snapped = best.startMs / 1000;
            sceneBoundaries[si].startSec = snapped;
            sceneBoundaries[si - 1].endSec = snapped;
          }
        }
      }
      sceneBoundaries[0].startSec = 0;
      sceneBoundaries[sceneBoundaries.length - 1].endSec = audioDurationSec;
      console.log(`[config] scene boundaries:`, sceneBoundaries.map(b => `${b.startSec.toFixed(1)}-${b.endSec.toFixed(1)}s`));

      // Map clips to scenes by keyword
      // Each scene gets clips whose keywords were extracted for that scene (via sceneClipCounts offset)
      const uniqueKws = [...new Set(validStocks.map(s => s.keyword))];
      const hasSceneClipCounts = Array.isArray(sceneClipCounts) && sceneClipCounts.length === numScenes;
      const kwOffsets: { start: number; end: number }[] = [];
      if (hasSceneClipCounts) {
        let cum = 0;
        for (const cnt of sceneClipCounts) { kwOffsets.push({ start: cum, end: cum + cnt }); cum += cnt; }
      } else {
        for (let si = 0; si < numScenes; si++)
          kwOffsets.push({ start: si * keywordsPerScene, end: (si + 1) * keywordsPerScene });
      }

      // Also map by caption text: find which captions fall in each scene boundary
      // and match their text against keywords for tighter sync
      const clipsForScene: StockVideo[][] = sceneBoundaries.map((bound, si) => {
        const { start: kStart, end: kEnd } = kwOffsets[si] ?? { start: 0, end: keywordsPerScene };
        const sceneKws = new Set(uniqueKws.slice(kStart, kEnd));

        // Find captions that overlap this scene's time range
        const sceneCaps = sceneCaptions.filter(c =>
          c.startMs / 1000 >= bound.startSec - 0.5 && c.startMs / 1000 < bound.endSec + 0.5
        );

        // Also match any keyword that appears in caption text (word overlap)
        const capText = sceneCaps.map(c => c.text.toLowerCase()).join(" ");
        for (const kw of uniqueKws) {
          const kwWords = kw.toLowerCase().split(/\s+/);
          const matchCount = kwWords.filter(w => w.length > 3 && capText.includes(w)).length;
          if (matchCount >= Math.min(2, kwWords.length)) sceneKws.add(kw);
        }

        return validStocks.filter(s => sceneKws.has(s.keyword));
      });

      // ── Caption-driven cuts: 1 subtitle = 1 stock video clip ──
      // Use caption startMs/endMs directly as cut points.
      // Rotate through ALL available clips so each subtitle gets a unique clip.
      const clipNextOffset = new Map<string, number>();

      function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5); }

      if (sceneCaptions.length > 0) {
        // ── Per-subtitle mode: keywords.length ≈ captions.length, each keyword maps 1:1 to caption ──
        // Detected when sceneClipCounts are all 1 (set by per-subtitle fetch in page.tsx)
        const isPerSubtitle = Array.isArray(sceneClipCounts) &&
          sceneClipCounts.length > 0 &&
          sceneClipCounts.every(c => c === 1) &&
          validStocks.length >= Math.floor(sceneCaptions.length * 0.5);

        if (isPerSubtitle) {
          // Direct 1:1 mapping: caption[i] → stock[i % stocks.length]
          // stocks are already ordered by keyword which matches caption order
          console.log(`[config] per-subtitle mode: ${validStocks.length} clips for ${sceneCaptions.length} captions`);
          for (let ci = 0; ci < sceneCaptions.length; ci++) {
            const cap = sceneCaptions[ci];
            const capStartSec = cap.startMs / 1000;
            const capEndSec = cap.endMs / 1000;
            const dur = capEndSec - capStartSec;
            if (dur < 0.1) continue;

            const sv = validStocks[ci % validStocks.length];
            const src = sv.localUrl ?? sv.videoUrl;
            const clipDuration = sv.duration > 0 ? sv.duration : 10;
            const clipOffset = clipNextOffset.get(src) ?? 0;
            const safeOffset = clipDuration > 0 ? clipOffset % clipDuration : 0;

            bgVideos.push({ src, start: capStartSec, end: capEndSec, clipOffset: safeOffset, clipDuration });
            clipNextOffset.set(src, safeOffset + dur);
          }
        } else {
        // ── Scene-aware pool mode: group clips by scene, rotate through pool ──
        const globalPool: StockVideo[] = [];
        for (let si = 0; si < sceneBoundaries.length; si++) {
          const sceneClips = shuffle(clipsForScene[si] ?? []);
          globalPool.push(...sceneClips);
        }
        // Add any clips not yet in pool as extra fallback
        const inPool = new Set(globalPool.map(s => s.localUrl ?? s.videoUrl));
        globalPool.push(...shuffle(validStocks.filter(s => !inPool.has(s.localUrl ?? s.videoUrl))));

        let poolIdx = 0;
        const getNextClip = (): StockVideo => {
          const sv = globalPool[poolIdx % globalPool.length];
          poolIdx++;
          return sv;
        };

        for (const cap of sceneCaptions) {
          const capStartSec = cap.startMs / 1000;
          const capEndSec = cap.endMs / 1000;
          const dur = capEndSec - capStartSec;
          if (dur < 0.1) continue;
          if (!globalPool.length) continue;

          const sv = getNextClip();
          const src = sv.localUrl ?? sv.videoUrl;
          const clipDuration = sv.duration > 0 ? sv.duration : 10;
          const clipOffset = clipNextOffset.get(src) ?? 0;
          const safeOffset = clipDuration > 0 ? clipOffset % clipDuration : 0;

          bgVideos.push({ src, start: capStartSec, end: capEndSec, clipOffset: safeOffset, clipDuration });
          clipNextOffset.set(src, safeOffset + dur);
        }
        } // end scene-aware pool mode
      } else {
        // Fallback: no captions — use scene boundaries with fixed cut cycle
        const CUT_CYCLE = audioDurationSec <= 20 ? [4, 3.5, 4.5] : [3, 2.5, 3.5, 2];
        for (let si = 0; si < sceneBoundaries.length; si++) {
          const { startSec, endSec } = sceneBoundaries[si];
          if (endSec - startSec <= 0) continue;
          const sceneClips = shuffle(clipsForScene[si] ?? []);
          const otherClips = shuffle(validStocks.filter(sv => !(clipsForScene[si] ?? []).includes(sv)));
          const pool = [...sceneClips, ...otherClips];
          if (!pool.length) continue;
          let cursor = startSec, cutIdx = 0;
          while (cursor < endSec - 0.1) {
            const sv = pool.find(s => { const used = clipNextOffset.get(s.localUrl ?? s.videoUrl) ?? 0; return used < (s.duration > 0 ? s.duration : 10) - 0.5; }) ?? pool[0];
            const src = sv.localUrl ?? sv.videoUrl;
            const clipDuration = sv.duration > 0 ? sv.duration : 10;
            const cutDur = Math.min(CUT_CYCLE[cutIdx % CUT_CYCLE.length], endSec - cursor);
            if (cutDur < 0.5) break;
            const clipOffset = clipNextOffset.get(src) ?? 0;
            const safeOffset = clipDuration > 0 ? clipOffset % clipDuration : 0;
            bgVideos.push({ src, start: cursor, end: cursor + cutDur, clipOffset: safeOffset, clipDuration });
            clipNextOffset.set(src, safeOffset + cutDur);
            cursor += cutDur; cutIdx++;
          }
        }
      }
    }
  }

  // 3. Normalize and ensure coverage: clamp invalid segment times, remove zero-length,
  // merge/trim overlaps, and fill gaps with nearest clip so the timeline stays continuous.
  bgVideos = normalizeBgVideos(bgVideos, audioDurationSec, fps);
  if (!bgVideos.length && validStocks.length > 0) {
    const first = validStocks[0];
    bgVideos.push({
      src: first.localUrl ?? first.videoUrl,
      start: 0,
      end: audioDurationSec,
      clipOffset: 0,
      clipDuration: first.duration > 0 ? first.duration : 10,
    });
  }

  bgVideos = fillBgGaps(bgVideos, audioDurationSec);
  bgVideos = normalizeBgVideos(bgVideos, audioDurationSec, fps);

  const config: ShortVideoConfig = {
    bgVideos,
    keywordPopups,
    voiceFile,
    voiceVolume: 1.0,
    bgmVolume: 0.12,
    durationInFrames,
    fontFamily,
    subtitleStylePreset,
  };

  console.log(`[config] done: ${bgVideos.length} bgVideos, ${keywordPopups.length} popups`);
  return NextResponse.json({ config });
}
