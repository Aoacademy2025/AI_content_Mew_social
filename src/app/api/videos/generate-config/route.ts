import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import type { BrollVideo, KeywordPopupItem, ShortVideoConfig, SubtitleStylePreset, SubtitleTextEffect } from "@/remotion/types";
import { evenSplitBgVideos, cyclePoolIndices, buildMinHoldSegments } from "@/lib/broll-even-split";
import { assignBrollWindows, coverBrollTimeline } from "@/lib/broll-coverage";
import { buildKeywordPopups } from "@/lib/keyword-popups";
import { recordTelemetryEvent } from "@/lib/telemetry";

export const maxDuration = 120; // 2 min â€” 100+ captions config generation
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
        // Same clip — extend prev instead of adding duplicate
        prev.end = Math.max(prev.end, seg.end);
        continue;
      } else {
        // Different clip overlaps — push it back to start right after prev
        seg.start = prev.end;
      }
    }

    // Only add if there's enough room (after potential start adjustment above)
    if (seg.end - seg.start >= minDuration) {
      deduped.push(seg);
    }
  }

  return deduped;
}

type Cap = { text: string; startMs: number; endMs: number; tag?: "hook" | "body" | "cta" };
type StockVideo = {
  keyword: string;
  sourceIndex?: number;
  localUrl?: string;
  videoUrl: string;
  duration: number;
  title?: string;
  query?: string;
  provider?: "pexels" | "pixabay";
  contentProfile?: string;
  selectionReason?: string;
  relevanceScore?: number;
};

function normalizeCaptionTimeline(raw: Cap[], audioDurationMs: number, minFrameMs: number): Cap[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const totalMs = Math.max(0, Number(audioDurationMs));
  const minMs = Math.max(1, Math.round(minFrameMs));
  const captions = raw
    .map((c, index) => ({
      ...c,
      index,
      text: typeof c?.text === "string" ? c.text.trim() : "",
      startMs: Number.isFinite(Number(c?.startMs)) ? Number(c.startMs) : NaN,
      endMs: Number.isFinite(Number(c?.endMs)) ? Number(c.endMs) : NaN,
    }))
    .filter((c) => c.text.length > 0 && Number.isFinite(c.startMs) && Number.isFinite(c.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.index - b.index);

  if (!captions.length || totalMs <= 0) return [];

  const out: Cap[] = [];
  let cursor = 0;
  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    if (cursor >= totalMs) break;
    const nextRawStart = i < captions.length - 1
      ? Math.max(0, Math.min(Math.round(captions[i + 1].startMs), totalMs))
      : totalMs;
    let start = Math.max(0, Math.round(cap.startMs));
    const rawEnd = Math.max(start + minMs, Math.round(cap.endMs));
    start = Math.min(Math.max(start, cursor), Math.max(0, totalMs - 1));
    const endLimit = i < captions.length - 1
      ? Math.max(start + minMs, nextRawStart)
      : totalMs;
    let end = Math.min(Math.max(rawEnd, start + 1), endLimit, totalMs);
    if (end <= start) {
      end = Math.min(totalMs, start + minMs);
    }
    if (end <= start) continue;
    const { index: _index, ...cleanCap } = cap;
    void _index;
    out.push({ ...cleanCap, startMs: start, endMs: end });
    cursor = end;
  }

  return out;
}

// normalizeKeywordPopups / autoScaleSize / detectStyle moved to @/lib/keyword-popups
// (pure buildKeywordPopups) so the window-mode b-roll flag can't alter subtitles.

// POST /api/videos/generate-config
export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    subtitleTextEffect,
    subtitleFontWeight = 900,
    subtitleShadow = false,
    subtitleOutline = false,
    subtitleOutlineSize = 2,
    scenes = [],
    keywordsPerScene = 5,
    sceneClipCounts = [] as number[],
    sceneDurations = [] as number[],
    minHoldSec: minHoldSecParam,
    brollWindows = [] as { startMs: number; endMs: number }[],
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
    subtitleTextEffect?: SubtitleTextEffect;
    subtitleFontWeight?: number;
    subtitleShadow?: boolean;
    subtitleOutline?: boolean;
    subtitleOutlineSize?: number;
    scenes?: string[];
    keywordsPerScene?: number;
    sceneClipCounts?: number[];
    sceneDurations?: number[];
    minHoldSec?: number;
    brollWindows?: { startMs: number; endMs: number }[];
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
  const minFrameMs = Math.max(1, Math.ceil(1000 / fps));
  const validCaptions = normalizeCaptionTimeline(
    sceneCaptions.map((c) => ({ ...c, text: c.text.trim() })),
    audioDurationMs,
    minFrameMs,
  );

  // Keep caption timing closer to real transcript timing (do not force each caption to next start).
  // - preserve native endMs where possible,
  // - prevent overlap by clipping to next caption start,
  // - keep minimum frame duration.
  const gapFilled = validCaptions.map((c, i) => {
    let endMs = Number.isFinite(c.endMs) ? c.endMs : c.startMs + minFrameMs;
    if (endMs <= c.startMs) endMs = c.startMs + minFrameMs;
    if (endMs > audioDurationMs) endMs = Math.max(c.startMs + minFrameMs, audioDurationMs);
    return { ...c, endMs };
  });

  // Close gaps between consecutive captions so subtitles never disappear mid-speech.
  // Gemini sometimes returns a caption whose endMs stops well before the next caption
  // begins (e.g. ends at 68s, next starts at 100s). Extend the earlier caption's endMs
  // to fill the gap — a subtitle staying on screen is better than a blank stretch.
  // Cap the extension so a genuine silence (no speech) doesn't get a frozen caption.
  const MAX_GAP_FILL_MS = 8000; // extend up to 8s; longer gaps are likely real silence
  for (let i = 0; i < gapFilled.length - 1; i++) {
    const gap = gapFilled[i + 1].startMs - gapFilled[i].endMs;
    if (gap > minFrameMs && gap <= MAX_GAP_FILL_MS) {
      gapFilled[i].endMs = gapFilled[i + 1].startMs - minFrameMs;
    } else if (gap > MAX_GAP_FILL_MS) {
      console.warn(`[config] large caption gap ${(gapFilled[i].endMs/1000).toFixed(1)}s→${(gapFilled[i+1].startMs/1000).toFixed(1)}s (${(gap/1000).toFixed(1)}s) — extending ${(MAX_GAP_FILL_MS/1000)}s only`);
      gapFilled[i].endMs = gapFilled[i].endMs + MAX_GAP_FILL_MS;
    }
  }

  const popupCaptions = normalizeCaptionTimeline(gapFilled, audioDurationMs, minFrameMs);

  const keywordPopups: KeywordPopupItem[] = buildKeywordPopups(popupCaptions, {
    fps,
    durationInFrames,
    subtitleSize,
    primaryColor,
    accentColor,
    subtitleStylePreset,
    subtitlePosition,
    subtitleFontWeight,
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
  let mappingRepairCount = 0;
  const brollMetadataBySrc = new Map<string, Partial<BrollVideo>>();
  for (const sv of validStocks) {
    const src = sv.localUrl ?? sv.videoUrl;
    brollMetadataBySrc.set(src, {
      keyword: sv.keyword,
      title: sv.title,
      query: sv.query,
      provider: sv.provider,
      contentProfile: sv.contentProfile,
      selectionReason: sv.selectionReason,
      relevanceScore: sv.relevanceScore,
      sourceIndex: sv.sourceIndex,
    });
  }

  if (validStocks.length > 0 && Array.isArray(brollWindows) && brollWindows.length > 0) {
    // WINDOW MODE: all semantic windows must remain represented even when the distinct
    // asset pool is capped. The coverage helper reuses/splits playable media as needed.
    const assigned = assignBrollWindows(
      brollWindows,
      validStocks.map((sv) => ({
        src: (sv.localUrl ?? sv.videoUrl) as string,
        start: 0,
        end: 0,
        sourceIndex: sv.sourceIndex,
        clipOffset: 0,
        clipDuration: sv.duration > 0 ? sv.duration : 10,
        keyword: sv.keyword,
        title: sv.title,
        query: sv.query,
        provider: sv.provider,
        contentProfile: sv.contentProfile,
        selectionReason: sv.selectionReason,
        relevanceScore: sv.relevanceScore,
      })),
      audioDurationSec,
      fps,
    );
    bgVideos.push(...assigned.segments);
    mappingRepairCount = assigned.metrics.repairedSegmentCount;
    console.log(
      `[config] window-mode: ${assigned.metrics.outputSegmentCount} segments over ` +
      `${brollWindows.length} windows, gaps=${assigned.metrics.gapCount}, ` +
      `tail=${assigned.metrics.uncoveredTailSec.toFixed(3)}s`,
    );
  } else if (validStocks.length > 0) {
    const n = validStocks.length;

    // â”€â”€ EVEN-SPLIT: divide total duration equally across all selected clips â”€â”€
    // Use this when clips are few (â‰¤ scenes count Ã— 3) â€” user manually curated them.
    // Each clip plays from second 0 for its slice; <Video loop> fills short clips.
    const numScenes = Math.max(1, scenes.length);
    const hasSceneClipCounts = Array.isArray(sceneClipCounts) && sceneClipCounts.length === numScenes;
    const totalSceneClipCounts = hasSceneClipCounts ? sceneClipCounts.reduce((a, b) => a + b, 0) : 0;
    const clipCountHint = totalSceneClipCounts > 0 ? totalSceneClipCounts : n;

    // Per-subtitle mode: every caption has exactly 1 dedicated clip (sceneClipCounts all = 1).
    // Must be detected BEFORE useEvenSplit â€” otherwise even-split fires and ignores caption timestamps.
    // Use gapFilled.length (sorted, non-empty captions) as the reference count.
    // Per-subtitle: every caption has exactly 1 dedicated clip.
    // Require at least 70% clips vs captions â€” clips can be fewer if some subtitles had no match.
    // Per-subtitle: sceneClipCounts all=1, count matches captions (allow ±2 tolerance for normalize/filter drift)
    const isPerSubtitleTop = Array.isArray(sceneClipCounts) &&
      sceneClipCounts.length > 0 &&
      sceneClipCounts.every(c => c === 1) &&
      Math.abs(sceneClipCounts.length - gapFilled.length) <= 2 &&
      gapFilled.length > 0 &&
      n > 0;

    const useEvenSplit = !isPerSubtitleTop && clipCountHint <= numScenes * 4; // few clips â†’ guaranteed equal airtime

    if (isPerSubtitleTop) {
      // Per-subtitle mode: each caption gets a clip, cycling through the pool so the
      // background changes on EVERY caption and every clip is used. (The old "merge short
      // subtitles into a neighbour" scheme collapsed dense word-modes: 80+ captions all
      // under the 1.5s threshold chained back to pool[0] = one frozen clip — prod logs
      // showed `per-subtitle-top: 1 clips for 81 captions (ratio=1%)`. Cycling can't collapse.)
      const pool = validStocks.slice(0, n);

      // MIN-HOLD cadence (env STOCK_MIN_HOLD_SEC > 0, default 0 = legacy): hold each
      // clip ≥N seconds spanning several captions instead of cutting on every caption
      // — fixes the "b-roll strobes ~1×/sec in dense word-modes" feel. buildMinHoldSegments
      // guarantees no segment outlives its clip (no freeze) and returns null when the
      // env is unset, in which case we keep the exact legacy 1-clip-per-caption path.
      // Cadence: hold each clip ≥minHoldSec across several captions instead of cutting on
      // every caption. The editor sends minHoldSec only for AI-gen / auto-mix (the small,
      // cost-capped pool from B1) so normal video stock keeps the legacy 1-clip-per-caption
      // path. STOCK_MIN_HOLD_SEC stays a global override; 0/unset = legacy. buildMinHoldSegments
      // is freeze-safe (see verify-broll-min-hold.ts).
      const minHoldSec = Math.max(0, Math.min(8,
        Number(minHoldSecParam) || Number(process.env.STOCK_MIN_HOLD_SEC) || 0,
      ));
      const heldSegments = buildMinHoldSegments(
        gapFilled.map((c) => ({ startSec: c.startMs / 1000, endSec: c.endMs / 1000 })),
        pool.map((sv) => ({ src: (sv.localUrl ?? sv.videoUrl) as string, duration: sv.duration > 0 ? sv.duration : 10 })),
        minHoldSec,
      );
      if (heldSegments) {
        bgVideos.push(...heldSegments);
        const avgHold = heldSegments.length
          ? heldSegments.reduce((a, s) => a + (s.end - s.start), 0) / heldSegments.length
          : 0;
        console.log(`[config] per-subtitle-top MIN_HOLD=${minHoldSec}s: ${heldSegments.length} clips across ${gapFilled.length} captions (avg ${avgHold.toFixed(2)}s/clip)`);
      } else {
        const assignedPool = cyclePoolIndices(gapFilled.length, pool.length);

        console.log(`[config] per-subtitle-top: cycling ${pool.length} clips across ${gapFilled.length} captions`);

        const clipOffsetMap = new Map<string, number>();
        for (let ci = 0; ci < gapFilled.length; ci++) {
          const cap = gapFilled[ci];
          const capStartSec = cap.startMs / 1000;
          const capEndSec   = cap.endMs   / 1000;
          const dur = capEndSec - capStartSec;
          if (dur < 0.1) continue;

          const poolIdx = Math.max(0, Math.min(assignedPool[ci] ?? 0, pool.length - 1));
          const sv = pool[poolIdx];
          const src = sv.localUrl ?? sv.videoUrl;
          const clipDuration = sv.duration > 0 ? sv.duration : 10;

          // If the previous bgVideo uses the same clip src, just extend it
          const last = bgVideos[bgVideos.length - 1];
          if (last && last.src === src) {
            last.end = capEndSec;
            continue;
          }

          const offset = clipOffsetMap.get(src) ?? 0;
          const safeOffset = clipDuration > 0 ? offset % clipDuration : 0;
          bgVideos.push({ src, start: capStartSec, end: capEndSec, clipOffset: safeOffset, clipDuration });
          clipOffsetMap.set(src, safeOffset + dur);
        }
        console.log(`[config] per-subtitle-top: ${bgVideos.length} clips for ${gapFilled.length} captions (ratio=${(bgVideos.length/Math.max(1,gapFilled.length)*100).toFixed(0)}%)`);
      }
    } else if (useEvenSplit) {
      const splitCount = Math.max(1, Math.min(n, clipCountHint));
      const sliceSec = audioDurationSec / splitCount;
      console.log(`[config] even-split: ${splitCount} clips × ${sliceSec.toFixed(2)}s each`);
      for (let i = 0; i < splitCount; i++) {
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
      // â”€â”€ SCENE-AWARE: map clips to scenes, adaptive cut cycling â”€â”€
      console.log(`[config] scene-aware: ${n} clips across ${numScenes} scenes`);

      // Build scene time boundaries â€” prefer sceneDurations from extract-keywords,
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

      // â”€â”€ Caption-driven cuts: 1 subtitle = 1 stock video clip â”€â”€
      // Use caption startMs/endMs directly as cut points.
      // Rotate through ALL available clips so each subtitle gets a unique clip.
      const clipNextOffset = new Map<string, number>();

      function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5); }

      if (sceneCaptions.length > 0) {
        // â”€â”€ Per-subtitle mode: keywords.length â‰ˆ captions.length, each keyword maps 1:1 to caption â”€â”€
        // Detected when sceneClipCounts are all 1 (set by per-subtitle fetch in page.tsx)
        const isPerSubtitle = Array.isArray(sceneClipCounts) &&
          sceneClipCounts.length > 0 &&
          sceneClipCounts.every(c => c === 1) &&
          Math.abs(sceneClipCounts.length - gapFilled.length) <= 2 &&
          gapFilled.length > 0 &&
          validStocks.length > 0;

        if (isPerSubtitle) {
          // Direct 1:1 mapping: caption[i] â†’ stock[i % stocks.length]
          // stocks are already ordered by keyword which matches caption order
          console.log(`[config] per-subtitle mode: ${validStocks.length} clips for ${sceneCaptions.length} captions`);
          const clipNextOff = new Map<string, number>();
          for (let ci = 0; ci < sceneCaptions.length; ci++) {
            const cap = sceneCaptions[ci];
            const capStartSec = cap.startMs / 1000;
            const capEndSec = cap.endMs / 1000;
            const dur = capEndSec - capStartSec;
            if (dur < 0.1) continue;

            // cycle through all clips — avoid repeating the same clip back-to-back
            const sv = validStocks[ci % validStocks.length];
            const src = sv.localUrl ?? sv.videoUrl;
            const clipDuration = sv.duration > 0 ? sv.duration : 10;
            // Advance clipOffset so repeated clips play from where they left off
            const clipOffset = clipNextOff.get(src) ?? 0;
            const safeOffset = clipDuration > 0 ? clipOffset % clipDuration : 0;
            bgVideos.push({ src, start: capStartSec, end: capEndSec, clipOffset: safeOffset, clipDuration });
            clipNextOff.set(src, safeOffset + dur);
          }
        } else {
        // Scene-aware pool mode: group clips by scene and cut by scene/segment count.
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

        for (let si = 0; si < sceneBoundaries.length; si++) {
          const { startSec, endSec } = sceneBoundaries[si];
          if (endSec - startSec <= 0.001) continue;
          if (!globalPool.length) continue;

          const targetCount = Math.max(1, hasSceneClipCounts && Number.isFinite(sceneClipCounts[si]) ? sceneClipCounts[si] : 1);
          const sceneCaps = sceneCaptions
            .filter(c => c.startMs / 1000 >= startSec - 0.5 && c.startMs / 1000 < endSec + 0.5)
            .map(c => ({ start: c.startMs / 1000, end: c.endMs / 1000 }));

          if (sceneCaps.length === 0) {
            const sceneDur = endSec - startSec;
            const cutDur = sceneDur / targetCount;
            for (let segment = 0; segment < targetCount; segment++) {
              const cutStart = startSec + segment * cutDur;
              const cutEnd = Math.min(endSec, cutStart + cutDur);
              if (cutEnd - cutStart < 0.1) continue;

              const sv = getNextClip();
              const src = sv.localUrl ?? sv.videoUrl;
              const clipDuration = sv.duration > 0 ? sv.duration : 10;
              const clipOffset = clipNextOffset.get(src) ?? 0;
              const safeOffset = clipDuration > 0 ? clipOffset % clipDuration : 0;
              bgVideos.push({ src, start: cutStart, end: cutEnd, clipOffset: safeOffset, clipDuration });
              clipNextOffset.set(src, safeOffset + (cutEnd - cutStart));
            }
            continue;
          }

          const buckets: { start: number; end: number }[][] = Array.from({ length: targetCount }, () => []);
          for (let ci = 0; ci < sceneCaps.length; ci++) {
            const bucket = Math.min(Math.floor((ci * targetCount) / sceneCaps.length), targetCount - 1);
            buckets[bucket].push(sceneCaps[ci]);
          }
          for (const bucket of buckets) {
            if (!bucket.length) continue;
            const cutStart = bucket[0].start;
            const cutEnd = bucket[bucket.length - 1].end;
            if (cutEnd - cutStart < 0.1) continue;
            const sv = getNextClip();
            const src = sv.localUrl ?? sv.videoUrl;
            const clipDuration = sv.duration > 0 ? sv.duration : 10;
            const clipOffset = clipNextOffset.get(src) ?? 0;
            const safeOffset = clipDuration > 0 ? clipOffset % clipDuration : 0;
            bgVideos.push({ src, start: cutStart, end: cutEnd, clipOffset: safeOffset, clipDuration });
            clipNextOffset.set(src, safeOffset + (cutEnd - cutStart));
          }
        }
        } // end scene-aware pool mode
      } else {
        // Fallback: no captions â€” use scene boundaries with fixed cut cycle
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

  // 3. Normalize and enforce coverage. Never stretch an individual media segment beyond
  // its playable duration: the coverage helper fills gaps and splits/reuses source media.
  bgVideos = normalizeBgVideos(bgVideos, audioDurationSec, fps);
  if (validStocks.length === 0) {
    return NextResponse.json({ error: "à¹„à¸¡à¹ˆà¸¡à¸µ stock video â€” à¸à¸£à¸¸à¸“à¸² fetch stock à¸à¹ˆà¸­à¸™ generate config", retryable: false }, { status: 400 });
  }
  if (!bgVideos.length && validStocks.length > 0) {
    // Safety net: the scene / per-subtitle mapping produced ZERO segments (e.g. caption
    // timing collapsed for dense subtitle modes). The old fallback froze ONE clip over the
    // whole video — which looks like "b-roll never loaded". Even-split ALL fetched clips so
    // the background still changes and every clip is used, instead of a single frozen frame.
    console.warn(`[config] main mapping produced 0 bgVideos — even-split fallback across ${validStocks.length} clips`);
    bgVideos.push(...evenSplitBgVideos(validStocks, audioDurationSec));
  }

  bgVideos = bgVideos.map((seg) => ({
    ...seg,
    ...(brollMetadataBySrc.get(seg.src) ?? {}),
  }));

  const coverage = coverBrollTimeline(bgVideos, bgVideos, audioDurationSec, fps);
  const coverageTelemetryProperties = {
    requestedWindowCount: Array.isArray(brollWindows) ? brollWindows.length : 0,
    availableAssetCount: validStocks.length,
    distinctAssetCount: new Set(validStocks.map((stock) => stock.localUrl ?? stock.videoUrl)).size,
    coverageSegmentCount: coverage.metrics.outputSegmentCount,
    coverageGapCount: coverage.metrics.gapCount,
    coverageRepairCount: mappingRepairCount + coverage.metrics.repairedSegmentCount,
    coverageRatio: coverage.metrics.coverageRatio,
    uncoveredTailSec: coverage.metrics.uncoveredTailSec,
    coverageRejected: !coverage.complete,
  };
  if (!coverage.complete) {
    await recordTelemetryEvent(authUser.id, {
      name: "broll_config_coverage",
      category: "error",
      source: "server",
      step: "config",
      status: "error",
      properties: coverageTelemetryProperties,
    }).catch(() => {});
    console.error(
      `[config] b-roll coverage rejected: gaps=${coverage.metrics.gapCount}, ` +
      `tail=${coverage.metrics.uncoveredTailSec.toFixed(3)}s, ` +
      `assets=${coverage.metrics.availableAssetCount}`,
    );
    return NextResponse.json(
      {
        error: "B-roll coverage ไม่ครบ — กรุณาลองค้นหา stock แล้วสร้าง config ใหม่",
        retryable: true,
      },
      { status: 422 },
    );
  }
  bgVideos = coverage.segments;
  await recordTelemetryEvent(authUser.id, {
    name: "broll_config_coverage",
    category: "performance",
    source: "server",
    step: "config",
    status: "done",
    properties: coverageTelemetryProperties,
  }).catch(() => {});

  console.log(`[config] final bgVideos (${bgVideos.length}):`);
  bgVideos.forEach((v, i) => console.log(`  [${i}] ${v.start.toFixed(2)}s–${v.end.toFixed(2)}s dur=${( v.end-v.start).toFixed(2)}s src=${v.src.split("/").pop()}`));

  const config: ShortVideoConfig = {
    bgVideos,
    keywordPopups,
    voiceFile,
    voiceVolume: 1.0,
    bgmVolume: 0.12, // match the web video-editor default (was 0.28 = too loud); web overrides with its own state anyway
    durationInFrames,
    fontFamily,
    subtitleStylePreset,
    subtitleTextEffect,
    subtitleAccentColor,
    subtitleShadow,
    subtitleOutline,
    subtitleOutlineSize,
    // Ken Burns motion on b-roll — env-gated (STOCK_KEN_BURNS=1, default off). Set in
    // the config so the render AND the editor preview (both read ShortVideoConfig) match.
    kenBurns: process.env.STOCK_KEN_BURNS === "1",
  };

  console.log(`[config] done: ${bgVideos.length} bgVideos, ${keywordPopups.length} popups, kenBurns=${config.kenBurns}`);
  return NextResponse.json({ config });
}
