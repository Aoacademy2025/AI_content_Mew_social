/**
 * Face-Safe Overlay & Caption Placement (`faceSafePlacement` / `faceBoxes`).
 *
 * Ensures subtitles, callout stickers, and titles automatically avoid covering human faces
 * while remaining strictly inside vertical social UI safe margins (TikTok / IG Reels / Shorts):
 * - Top status / search bar clearance: `top >= 12%`
 * - Bottom caption / scrubber / CTA bar clearance: `bottom <= 86%` (center `<= 82%`)
 * - Right-side engagement icon stack clearance (`x <= 0.84` when `y >= 0.42`)
 *
 * Pure & deterministic — shared across Remotion (`ShortVideoComposition`, `SubtitleOverlayComposition`),
 * Web Editor (`video-editor/_v2`), and MCP (`analyze_footage_pack`, `story-director`).
 */

import type { StoryOverlayItem } from "./story-overlays";

export interface FaceBox {
  /** Normalized horizontal left edge (0..1) in output 9:16 frame space. */
  x: number;
  /** Normalized vertical top edge (0..1) in output 9:16 frame space. */
  y: number;
  /** Normalized box width (0..1). */
  width: number;
  /** Normalized box height (0..1). */
  height: number;
  /** Optional confidence score (0..1). */
  confidence?: number;
}

export type VisionFaceZone = "upper" | "center" | "lower" | "none";

export interface AvoidScreenBand {
  /** Top edge in % of frame height (0..100). */
  top: number;
  /** Bottom edge in % of frame height (0..100). */
  bottom: number;
  /** Left edge in % of frame width (0..100). Defaults to 0. */
  left?: number;
  /** Right edge in % of frame width (0..100). Defaults to 100. */
  right?: number;
}

export interface ActiveSubtitleBand {
  startMs: number;
  endMs: number;
  /** Vertical center of the rendered subtitle (% of 1920px frame height). */
  topPercent: number;
}

export const SOCIAL_SAFE_TOP_MIN_PCT = 12;
export const SOCIAL_SAFE_TOP_MAX_PCT = 82;
export const SUBTITLE_BOTTOM_SAFE_MIN_PCT = 74;
export const SUBTITLE_BOTTOM_SAFE_MAX_PCT = 82;
export const SUBTITLE_TOP_SAFE_CANDIDATES_PCT = [17, 19, 15, 21] as const;
export const SOCIAL_RIGHT_RAIL_X_LIMIT = 0.86;
export const MAX_FACE_BOXES_PER_SHOT = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Converts a shot-level Vision AI `faceZone` tag into normalized 9:16 `FaceBox[]`.
 * Returns `undefined` when `zone` is omitted/unrecognized so callers can fall back to RGBA boxes.
 */
export function faceBoxesFromVisionZone(zone?: string | null): FaceBox[] | undefined {
  if (zone === "upper") {
    return [{ x: 0.26, y: 0.14, width: 0.48, height: 0.24, confidence: 0.92 }];
  }
  if (zone === "center") {
    return [{ x: 0.26, y: 0.28, width: 0.48, height: 0.26, confidence: 0.92 }];
  }
  if (zone === "lower") {
    return [{ x: 0.24, y: 0.62, width: 0.52, height: 0.24, confidence: 0.92 }];
  }
  if (zone === "none") {
    return [];
  }
  return undefined;
}

export function normalizeFaceBoxes(value: unknown): FaceBox[] {
  if (!Array.isArray(value)) return [];
  const out: FaceBox[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (
      !Number.isFinite(x)
      || !Number.isFinite(y)
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0.01
      || height <= 0.01
    ) {
      continue;
    }
    const nx = clamp(x, 0, 0.98);
    const ny = clamp(y, 0, 0.98);
    const nw = clamp(width, 0.02, 1 - nx);
    const nh = clamp(height, 0.02, 1 - ny);
    const conf = Number(raw.confidence);
    out.push({
      x: Number(nx.toFixed(4)),
      y: Number(ny.toFixed(4)),
      width: Number(nw.toFixed(4)),
      height: Number(nh.toFixed(4)),
      ...(Number.isFinite(conf) ? { confidence: Number(clamp(conf, 0, 1).toFixed(3)) } : {}),
    });
    if (out.length >= MAX_FACE_BOXES_PER_SHOT) break;
  }
  return out;
}

/**
 * Resolves a vertical topPercent (`12..82`) for a subtitle card or horizontal banner so its
 * rendered vertical band avoids intersecting `faceBoxes` AND never places subtitles inside
 * the center portrait face zone (`24%..73%`).
 */
export function resolveFaceSafeVerticalPercent(input: {
  faceBoxes?: readonly FaceBox[] | null;
  preferredTopPercent: number;
  /** Approximate vertical height of the rendered text block (% of 1920px frame). Default 10%. */
  overlayHeightPercent?: number;
  role?: "subtitle" | "callout" | "hook";
  /** When true (e.g. a top chapter-pill, hook, or checklist is active), keep subtitles in the bottom safe band. */
  disallowTopZone?: boolean;
}): number {
  const minTop = input.role === "hook" ? 11 : SOCIAL_SAFE_TOP_MIN_PCT;
  const maxTop = input.role === "hook" ? 42 : SOCIAL_SAFE_TOP_MAX_PCT;
  const preferred = clamp(input.preferredTopPercent, minTop, maxTop);
  const boxes = input.faceBoxes ?? [];
  if (boxes.length === 0) return preferred;

  const heightPct = clamp(input.overlayHeightPercent ?? 10, 5, 28);
  const marginPct = 2.5;
  const isCenteredAnchor = input.role === "subtitle" || input.role === "hook";

  const overlapScoreAt = (anchorPct: number): number => {
    const bandTop = isCenteredAnchor ? anchorPct - heightPct * 0.5 : anchorPct;
    const bandBottom = isCenteredAnchor ? anchorPct + heightPct * 0.5 : anchorPct + heightPct;
    let totalOverlap = 0;
    for (const face of boxes) {
      // Only consider faces wide/central enough to collide with centered captions
      const faceLeft = face.x;
      const faceRight = face.x + face.width;
      if (faceRight < 0.14 || faceLeft > 0.86) continue;
      const fTop = face.y * 100 - marginPct;
      const fBottom = (face.y + face.height) * 100 + marginPct;
      const overlap = Math.max(0, Math.min(bandBottom, fBottom) - Math.max(bandTop, fTop));
      if (overlap > 0) {
        const weight = typeof face.confidence === "number" ? Math.max(0.4, face.confidence) : 1;
        totalOverlap += overlap * weight;
      }
    }
    return totalOverlap;
  };

  // Subtitles MUST stay out of the 24%..73% center face/chest action zone!
  // They belong in the Bottom Safe Zone (74%..82%) by default, jumping to the Top Safe Zone
  // (15%..21%) ONLY when a genuine low-frame close-up face blocks the bottom AND no top overlay is active.
  if (input.role === "subtitle") {
    const bottomPreferred = clamp(preferred, SUBTITLE_BOTTOM_SAFE_MIN_PCT, SUBTITLE_BOTTOM_SAFE_MAX_PCT);
    if (overlapScoreAt(bottomPreferred) <= 0.15) {
      return Math.round(bottomPreferred * 10) / 10;
    }

    const bottomCandidates = [80, 82, 78, 76, 74].filter(
      (c) => Math.abs(c - bottomPreferred) > 0.2,
    );
    let bestBottom = bottomPreferred;
    let bestBottomScore = overlapScoreAt(bottomPreferred);
    for (const candidate of bottomCandidates) {
      const score = overlapScoreAt(candidate);
      if (score <= 0.15) return candidate;
      if (score < bestBottomScore - 0.3) {
        bestBottomScore = score;
        bestBottom = candidate;
      }
    }

    if (!input.disallowTopZone && bestBottomScore > 2.0) {
      for (const topCandidate of SUBTITLE_TOP_SAFE_CANDIDATES_PCT) {
        if (overlapScoreAt(topCandidate) <= 0.15) {
          return topCandidate;
        }
      }
    }

    return Math.round(bestBottom * 10) / 10;
  }

  if (overlapScoreAt(preferred) <= 0.1) return preferred;

  const candidates: number[] = [];
  for (let delta = 3; delta <= 64; delta += 3) {
    if (input.role === "hook") {
      if (preferred - delta >= minTop) candidates.push(preferred - delta);
      if (preferred + delta <= maxTop) candidates.push(preferred + delta);
    } else {
      if (preferred + delta <= maxTop) candidates.push(preferred + delta);
      if (preferred - delta >= minTop) candidates.push(preferred - delta);
    }
  }

  let bestPos = preferred;
  let bestOverlap = overlapScoreAt(preferred);
  for (const candidate of candidates) {
    const score = overlapScoreAt(candidate);
    if (score <= 0.1) return Math.round(candidate * 10) / 10;
    if (score < bestOverlap - 0.5) {
      bestOverlap = score;
      bestPos = candidate;
    }
  }
  return Math.round(bestPos * 10) / 10;
}

export type SafeStickerSlot = {
  topPercent: number;
  leftPercent: number;
  align: "left" | "center" | "right";
  tiltDeg: number;
};

/**
 * Corner & side-margin slots that stay strictly outside:
 * - Center portrait face zone (`30%..58%` vertical center)
 * - Right-rail TikTok engagement buttons (`x <= 0.86` when `y >= 0.40`)
 * - Bottom lower-third subtitle zone (`72%..88%`)
 */
const STICKER_CANDIDATE_SLOTS: readonly SafeStickerSlot[] = [
  { topPercent: 15.5, leftPercent: 5.5, align: "left", tiltDeg: -2.5 },
  { topPercent: 15.5, leftPercent: 50, align: "right", tiltDeg: 2.5 },
  { topPercent: 24, leftPercent: 5.5, align: "left", tiltDeg: -2 },
  { topPercent: 24, leftPercent: 50, align: "right", tiltDeg: 2 },
  { topPercent: 63, leftPercent: 5.5, align: "left", tiltDeg: -2 },
  { topPercent: 63, leftPercent: 48, align: "right", tiltDeg: 2 },
];

/**
 * Picks a face-safe, subtitle-safe, and TikTok-icon-safe slot for a floating `callout-sticker` pill.
 */
export function resolveFaceSafeStickerPosition(input: {
  faceBoxes?: readonly FaceBox[] | null;
  seedIndex?: number;
  avoidTopPercentBand?: { top: number; bottom: number } | null;
  avoidBands?: readonly AvoidScreenBand[] | null;
}): SafeStickerSlot {
  const boxes = input.faceBoxes ?? [];
  const startIdx = Math.abs(Math.floor(input.seedIndex ?? 0)) % STICKER_CANDIDATE_SLOTS.length;
  const ordered = [
    ...STICKER_CANDIDATE_SLOTS.slice(startIdx),
    ...STICKER_CANDIDATE_SLOTS.slice(0, startIdx),
  ];

  const boxWidthNorm = 0.36;
  const boxHeightNorm = 0.08;

  const allAvoidBands: AvoidScreenBand[] = [];
  if (input.avoidTopPercentBand) {
    allAvoidBands.push({
      top: input.avoidTopPercentBand.top,
      bottom: input.avoidTopPercentBand.bottom,
      left: 0,
      right: 100,
    });
  }
  if (input.avoidBands?.length) {
    for (const band of input.avoidBands) {
      allAvoidBands.push(band);
    }
  }

  let bestSlot = ordered[0]!;
  let bestPenalty = Infinity;

  for (const slot of ordered) {
    const sx1 = slot.align === "right" ? Math.max(0.42, SOCIAL_RIGHT_RAIL_X_LIMIT - boxWidthNorm) : slot.leftPercent / 100;
    const sx2 = slot.align === "right" ? SOCIAL_RIGHT_RAIL_X_LIMIT : Math.min(SOCIAL_RIGHT_RAIL_X_LIMIT, sx1 + boxWidthNorm);
    const sy1 = slot.topPercent / 100;
    const sy2 = sy1 + boxHeightNorm;

    let penalty = 0;
    for (const face of boxes) {
      const fx1 = face.x - 0.035;
      const fy1 = face.y - 0.035;
      const fx2 = face.x + face.width + 0.035;
      const fy2 = face.y + face.height + 0.035;
      const ox = Math.max(0, Math.min(sx2, fx2) - Math.max(sx1, fx1));
      const oy = Math.max(0, Math.min(sy2, fy2) - Math.max(sy1, fy1));
      if (ox > 0 && oy > 0) {
        penalty += ox * oy * 4000;
      }
    }

    for (const band of allAvoidBands) {
      const bx1 = (band.left ?? 0) / 100;
      const bx2 = (band.right ?? 100) / 100;
      const by1 = band.top / 100;
      const by2 = band.bottom / 100;
      const ox = Math.max(0, Math.min(sx2, bx2) - Math.max(sx1, bx1));
      const oy = Math.max(0, Math.min(sy2, by2) - Math.max(sy1, by1));
      if (ox > 0 && oy > 0) {
        penalty += ox * oy * 6000;
      }
    }

    if (penalty === 0) return slot;
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestSlot = slot;
    }
  }

  return bestSlot;
}

/**
 * De-conflicts Story Overlays across time so competing headers/cards/stickers never stack:
 * - `chapter-pill` trims away from `headlineHook`, `hero-freeze-card`, and `blooper-end`
 * - `callout-sticker` yields to simultaneous `hero-freeze-card`, `checklist-pop`, or `countdown`
 */
export function coordinateStoryOverlays(
  overlays: readonly StoryOverlayItem[],
  headlineHookEndMs = 0,
): StoryOverlayItem[] {
  if (!overlays.length) return [];
  const heroCards = overlays.filter((o) => o.kind === "hero-freeze-card");
  const bloopers = overlays.filter((o) => o.kind === "blooper-end");
  const heavyCards = overlays.filter(
    (o) => o.kind === "hero-freeze-card" || o.kind === "checklist-pop" || o.kind === "countdown" || o.kind === "blooper-end",
  );

  const out: StoryOverlayItem[] = [];
  for (const item of overlays) {
    let startMs = item.startMs;
    let endMs = item.endMs;

    if (item.kind === "chapter-pill") {
      if (headlineHookEndMs > 0 && startMs < headlineHookEndMs) {
        startMs = headlineHookEndMs + 60;
      }
      for (const hero of heroCards) {
        if (startMs < hero.endMs && endMs > hero.startMs) {
          if (endMs - hero.endMs >= hero.startMs - startMs) {
            startMs = Math.max(startMs, hero.endMs + 60);
          } else {
            endMs = Math.min(endMs, hero.startMs - 60);
          }
        }
      }
      for (const blp of bloopers) {
        if (startMs < blp.endMs && endMs > blp.startMs) {
          endMs = Math.min(endMs, blp.startMs - 60);
        }
      }
      if (endMs - startMs < 500) continue;
    } else if (item.kind === "callout-sticker") {
      for (const heavy of heavyCards) {
        if (startMs < heavy.endMs && endMs > heavy.startMs) {
          if (endMs - heavy.endMs >= heavy.startMs - startMs) {
            startMs = Math.max(startMs, heavy.endMs + 80);
          } else {
            endMs = Math.min(endMs, heavy.startMs - 80);
          }
        }
      }
      if (endMs - startMs < 450) continue;
    }

    out.push(startMs === item.startMs && endMs === item.endMs ? item : { ...item, startMs, endMs });
  }
  return out;
}

export interface CoordinatedSubtitlePopup<T> {
  popup: T;
  visibleStart: number;
  dur: number;
  startMs: number;
  endMs: number;
  topPercent: number;
}

/**
 * Coordinates subtitle popups with `faceBoxes`, `headlineHook`, and `storyOverlays`:
 * - Trims/yields subtitles during full-width `hero-freeze-card` spotlights so two large cards never stack
 * - Prevents subtitles from jumping to the top zone when a top overlay (`chapter-pill`, `headlineHook`, etc.) is active
 * - Emits exact `[startMs, endMs, topPercent]` bands so `StoryOverlayLayer` stickers avoid every rendered subtitle
 */
export function coordinateSubtitlePopups<
  T extends { start: number; end: number; topPercent?: number },
>(input: {
  popups: readonly T[];
  fps: number;
  faceSafePlacement?: boolean;
  resolveFaceBoxesAtMs?: (ms: number) => readonly FaceBox[] | undefined;
  headlineHook?: { enabled?: boolean; topPercent?: number } | null;
  hookEndFrame: number;
  storyOverlays?: readonly StoryOverlayItem[];
}): CoordinatedSubtitlePopup<T>[] {
  const {
    popups,
    fps,
    faceSafePlacement = true,
    resolveFaceBoxesAtMs,
    headlineHook,
    hookEndFrame,
    storyOverlays = [],
  } = input;

  const hookTop = headlineHook?.topPercent ?? 18;
  const heroFrameWindows = storyOverlays
    .filter((o) => o.kind === "hero-freeze-card")
    .map((o) => ({
      startFrame: Math.round((o.startMs / 1000) * fps),
      endFrame: Math.round((o.endMs / 1000) * fps),
    }));

  const out: CoordinatedSubtitlePopup<T>[] = [];

  for (const p of popups) {
    let vStart = p.start;
    let vEnd = p.end;

    // Yield to `hero-freeze-card` (which renders its own full-width spotlight title + subtitle card)
    let suppressedByHero = false;
    for (const hero of heroFrameWindows) {
      if (vStart < hero.endFrame && vEnd > hero.startFrame) {
        const beforeFrames = hero.startFrame - vStart;
        const afterFrames = vEnd - hero.endFrame;
        if (beforeFrames < 10 && afterFrames < 10) {
          suppressedByHero = true;
          break;
        }
        if (beforeFrames >= afterFrames) {
          vEnd = hero.startFrame;
        } else {
          vStart = hero.endFrame;
        }
      }
    }
    if (suppressedByHero || vEnd - vStart <= 0) continue;

    const startMs = (vStart / fps) * 1000;
    const endMs = (vEnd / fps) * 1000;
    const midPopupMs = (startMs + endMs) * 0.5;

    const hasActiveTopOverlay =
      Boolean(headlineHook?.enabled && hookEndFrame > 0 && vStart < hookEndFrame && hookTop <= 42)
      || storyOverlays.some(
        (ov) =>
          ov.endMs > startMs
          && ov.startMs < endMs
          && (ov.kind === "chapter-pill"
            || ov.kind === "blooper-end"
            || ov.kind === "checklist-pop"
            || ov.kind === "countdown"),
      );

    const shotFaces = faceSafePlacement !== false && resolveFaceBoxesAtMs
      ? resolveFaceBoxesAtMs(midPopupMs)
      : undefined;

    const subTop = shotFaces?.length
      ? resolveFaceSafeVerticalPercent({
          faceBoxes: shotFaces,
          preferredTopPercent: p.topPercent ?? 78,
          role: "subtitle",
          disallowTopZone: hasActiveTopOverlay,
        })
      : (p.topPercent ?? 72);

    const collidesWithHook = Boolean(
      headlineHook?.enabled && hookEndFrame > 0 && Math.abs(subTop - hookTop) < 28,
    );
    if (collidesWithHook) {
      vStart = Math.max(vStart, hookEndFrame);
    }
    const dur = vEnd - vStart;
    if (dur <= 0) continue;

    const adjustedPopup = subTop !== p.topPercent ? { ...p, topPercent: subTop } : p;
    out.push({
      popup: adjustedPopup,
      visibleStart: vStart,
      dur,
      startMs: (vStart / fps) * 1000,
      endMs: (vEnd / fps) * 1000,
      topPercent: subTop,
    });
  }

  return out;
}

/**
 * Lightweight, zero-dependency portrait face-region estimator over downsampled RGBA pixels
 * (e.g. 90×160 or 108×192 thumbnail decoded via `sharp`).
 *
 * Scans warm human skin-chromaticity clusters (`YCbCr` + HSV saturation + RGB portrait bounds)
 * weighted toward the upper-middle portrait framing zone (`y: 0.06..0.66`, `x: 0.08..0.92`)
 * while rejecting high-saturation red/orange/pink sports uniforms and banners!
 */
export function estimatePortraitFaceBoxesFromRgba(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
): FaceBox[] {
  if (width < 16 || height < 16 || rgba.length < width * height * 4) return [];

  const gridCols = 18;
  const gridRows = 32;
  const cellHits = new Float64Array(gridCols * gridRows);
  const cellTotals = new Int32Array(gridCols * gridRows);

  for (let py = 0; py < height; py += 1) {
    const ny = py / height;
    if (ny < 0.06 || ny > 0.66) continue;
    const gy = Math.min(gridRows - 1, Math.floor(ny * gridRows));
    for (let px = 0; px < width; px += 1) {
      const nx = px / width;
      if (nx < 0.08 || nx > 0.92) continue;
      const gx = Math.min(gridCols - 1, Math.floor(nx * gridCols));
      const idx = (py * width + px) * 4;
      const r = rgba[idx]!;
      const g = rgba[idx + 1]!;
      const b = rgba[idx + 2]!;

      const cellIdx = gy * gridCols + gx;
      cellTotals[cellIdx] += 1;

      // YCbCr + HSV saturation + R-G excess gating:
      // Real human skin has moderate saturation (0.12..0.58) and moderate R-G excess (10..82),
      // whereas bright red/orange/magenta sports uniforms have sat > 0.62 or R-G > 88.
      const yLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (yLuma < 45 || yLuma > 240) continue;
      const maxRgb = Math.max(r, g, b);
      const minRgb = Math.min(r, g, b);
      const sat = maxRgb > 0 ? (maxRgb - minRgb) / maxRgb : 0;
      const rgDiff = r - g;
      if (sat < 0.12 || sat > 0.58 || rgDiff < 10 || rgDiff > 82 || g < b - 12) continue;

      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const isSkin =
        r > 75
        && g > 42
        && b > 25
        && r > g
        && r > b
        && (r - minRgb) > 14
        && cb >= 80
        && cb <= 128
        && cr >= 133
        && cr <= 173;
      if (isSkin) {
        // Upper-portrait prior (heads appear in upper 10%..50% far more often than hands/legs)
        const verticalPrior = ny >= 0.10 && ny <= 0.50 ? 1.25 : 0.7;
        const centerPrior = nx >= 0.20 && nx <= 0.80 ? 1.15 : 0.85;
        cellHits[cellIdx] += verticalPrior * centerPrior;
      }
    }
  }

  // Find peak 3x4 cell window (~17% width × 12.5% height — typical vertical shot face size)
  const winW = 3;
  const winH = 4;
  let bestScore = 0;
  let bestGx = -1;
  let bestGy = -1;

  for (let gy = 1; gy <= gridRows - winH - 2; gy += 1) {
    for (let gx = 1; gx <= gridCols - winW - 1; gx += 1) {
      let score = 0;
      let count = 0;
      for (let dy = 0; dy < winH; dy += 1) {
        for (let dx = 0; dx < winW; dx += 1) {
          const c = (gy + dy) * gridCols + (gx + dx);
          score += cellHits[c]!;
          count += cellTotals[c]!;
        }
      }
      const density = count > 0 ? score / count : 0;
      if (density > bestScore) {
        bestScore = density;
        bestGx = gx;
        bestGy = gy;
      }
    }
  }

  // Require meaningful skin density (>= 0.34) so noisy background/cloth patches return []
  if (bestGx < 0 || bestGy < 0 || bestScore < 0.34) return [];

  // Expand slightly around peak cluster to cover forehead/hair/chin safely
  const rawX = Math.max(0.06, (bestGx - 0.5) / gridCols);
  const rawY = Math.max(0.06, (bestGy - 0.6) / gridRows);
  const rawW = Math.min(0.46, ((winW + 1.2) / gridCols));
  const rawH = Math.min(0.28, ((winH + 1.4) / gridRows));

  return normalizeFaceBoxes([
    {
      x: rawX,
      y: rawY,
      width: Math.min(rawW, 0.96 - rawX),
      height: Math.min(rawH, 0.92 - rawY),
      confidence: Math.min(0.95, bestScore / 0.65),
    },
  ]);
}
