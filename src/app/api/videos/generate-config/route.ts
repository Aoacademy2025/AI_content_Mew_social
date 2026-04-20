import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import type { BrollVideo, KeywordPopupItem, ShortVideoConfig, SubtitleStylePreset } from "@/remotion/types";

export const maxDuration = 60;
export const runtime = "nodejs";

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
  const bgVideos: BrollVideo[] = [];

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
          clipDuration: sv.duration > 0 ? sv.duration : undefined,
        });
      }
    } else {
      // ── SCENE-AWARE: map clips to scenes, adaptive cut cycling ──
      console.log(`[config] scene-aware: ${n} clips across ${numScenes} scenes`);

      // Build scene time boundaries from caption timestamps
      const sceneBoundaries: { startSec: number; endSec: number }[] = [];

      if (sceneCaptions.length > 0) {
        const totalChars = scenes.reduce((s, sc) => s + Math.max(1, sc.replace(/\s/g, "").length), 0);
        let cum = 0;
        const sceneCumChars = scenes.map(sc => { cum += Math.max(1, sc.replace(/\s/g, "").length); return cum; });
        const capCount = sceneCaptions.length;
        const sceneCapGroups: Cap[][] = Array.from({ length: numScenes }, () => []);
        for (let ci = 0; ci < capCount; ci++) {
          const charPos = ((ci + 0.5) / capCount) * totalChars;
          let si = sceneCumChars.findIndex(c => charPos <= c);
          if (si < 0) si = numScenes - 1;
          sceneCapGroups[si].push(sceneCaptions[ci]);
        }
        for (let si = 0; si < numScenes; si++) {
          const g = sceneCapGroups[si];
          if (g.length > 0) {
            sceneBoundaries.push({ startSec: g[0].startMs / 1000, endSec: g[g.length - 1].endMs / 1000 });
          } else {
            const prev = sceneBoundaries[si - 1];
            const dur = audioDurationSec / numScenes;
            const s = prev ? prev.endSec : si * dur;
            sceneBoundaries.push({ startSec: s, endSec: s + dur });
          }
        }
        for (let si = 1; si < sceneBoundaries.length; si++) {
          if (sceneBoundaries[si].startSec < sceneBoundaries[si - 1].endSec)
            sceneBoundaries[si].startSec = sceneBoundaries[si - 1].endSec;
        }
        sceneBoundaries[0].startSec = 0;
        sceneBoundaries[sceneBoundaries.length - 1].endSec = audioDurationSec;
      } else {
        const dur = audioDurationSec / numScenes;
        for (let i = 0; i < numScenes; i++)
          sceneBoundaries.push({ startSec: i * dur, endSec: (i + 1) * dur });
      }

      // Map clips to scenes by keyword
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

      const clipsForScene: StockVideo[][] = sceneBoundaries.map((_, si) => {
        const { start: kStart, end: kEnd } = kwOffsets[si] ?? { start: 0, end: keywordsPerScene };
        const sceneKws = new Set(uniqueKws.slice(kStart, kEnd));
        return validStocks.filter(s => sceneKws.has(s.keyword));
      });

      const clipNextOffset = new Map<string, number>();
      const CUT_CYCLE =
        audioDurationSec <= 10 ? [5, 4.5, 5.5] :
        audioDurationSec <= 20 ? [4, 3.5, 4.5] :
        audioDurationSec <= 40 ? [3.5, 3, 4, 3] : [3, 2.5, 3.5, 2];

      function remainingPlayable(sv: StockVideo): number {
        const src = sv.localUrl ?? sv.videoUrl;
        const used = clipNextOffset.get(src) ?? 0;
        return Math.max(0, (sv.duration > 0 ? sv.duration : 10) - used);
      }

      function buildPool(si: number): StockVideo[] {
        const shuffle = <T>(arr: T[]) => [...arr].sort(() => Math.random() - 0.5);
        const ok = (sv: StockVideo) => remainingPlayable(sv) >= 1;
        const sc = clipsForScene[si];
        const other = validStocks.filter(sv => !sc.includes(sv));
        return [
          ...shuffle(sc.filter(ok)),
          ...shuffle(other.filter(ok)),
          ...(sc.filter(ok).length === 0 && other.filter(ok).length === 0 ? shuffle(validStocks) : []),
        ];
      }

      for (let si = 0; si < sceneBoundaries.length; si++) {
        const { startSec, endSec } = sceneBoundaries[si];
        if (endSec - startSec <= 0) continue;
        let pool = buildPool(si), poolIdx = 0, cursor = startSec, cutIdx = 0;
        while (cursor < endSec - 0.1) {
          if (poolIdx >= pool.length) { pool = buildPool(si); poolIdx = 0; if (!pool.length) break; }
          const sv = pool[poolIdx++];
          const src = sv.localUrl ?? sv.videoUrl;
          const playable = remainingPlayable(sv);
          const cutDur = Math.min(CUT_CYCLE[cutIdx % CUT_CYCLE.length], endSec - cursor, Math.max(1, playable));
          if (cutDur < 0.5) continue;
          const clipOffset = clipNextOffset.get(src) ?? 0;
          bgVideos.push({ src, start: cursor, end: cursor + cutDur, clipOffset, clipDuration: sv.duration > 0 ? sv.duration : undefined });
          clipNextOffset.set(src, clipOffset + cutDur);
          cursor += cutDur; cutIdx++;
        }
      }
    }
  }

  // ── Gap-fill: ensure bgVideos covers [0, audioDurationSec] with no gaps ──
  // Sort by start time, then fill any uncovered range using the nearest clip.
  if (bgVideos.length > 0) {
    bgVideos.sort((a, b) => a.start - b.start);

    const filled: BrollVideo[] = [];
    let cursor = 0;

    for (const seg of bgVideos) {
      if (seg.start > cursor + 0.05) {
        // Gap before this segment — fill with previous clip or first clip
        const filler = filled.length > 0 ? filled[filled.length - 1] : bgVideos[0];
        filled.push({ src: filler.src, start: cursor, end: seg.start, clipOffset: 0, clipDuration: filler.clipDuration });
      }
      filled.push(seg);
      cursor = Math.max(cursor, seg.end);
    }

    // Gap at the end
    if (cursor < audioDurationSec - 0.05) {
      const filler = filled[filled.length - 1];
      filled.push({ src: filler.src, start: cursor, end: audioDurationSec, clipOffset: 0, clipDuration: filler.clipDuration });
    }

    bgVideos.length = 0;
    bgVideos.push(...filled);
  }

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
