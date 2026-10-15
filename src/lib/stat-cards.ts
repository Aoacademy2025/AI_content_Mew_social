/**
 * EP5/S2 Backlog #6 — Animated Infographics / Stat Cards (`statCards: boolean`).
 *
 * Pure, deterministic detector and planner for animated numeric callout badges:
 * - Scans caption cards for salient statistics, percentages, multipliers, currency amounts,
 *   or quantified claims (e.g. `"300%"`, `"10x"`, `"฿990"`, `"3 เท่า"`, `"7 วัน"`, `"1,500 คน"`).
 * - Extracts `{ valueText, labelText }` so the Remotion & preview `StatCardOverlay` can render
 *   a sleek glassmorphic stat callout card without colliding with the opening `headlineHook`
 *   or crowding back-to-back scenes.
 */

export type StatCardItem = {
  id: string;
  valueText: string;
  labelText: string;
  startMs: number;
  endMs: number;
  accentColor?: string;
};

export type StatCaptionInput = {
  text: string;
  startMs: number;
  endMs: number;
  tag?: string;
};

export type PlanStatCardsOptions = {
  enabled?: boolean;
  /** End timestamp (ms) of an active opening `headlineHook` so stat cards never overlap it. */
  headlineHookEndMs?: number;
  /** Minimum spacing (ms) between consecutive stat cards (default 3500ms). */
  minGapMs?: number;
  /** Maximum stat cards across a short video (default 4). */
  maxCards?: number;
  /** Optional accent color for the stat number badge. */
  accentColor?: string;
};

const STAT_MATCH_RE = /([+$฿€¥]?\s*[\d\u0E50-\u0E59]+(?:[.,][\d\u0E50-\u0E59]+)*\s*(?:%|x|X|เท่า|บาท|ล้าน|แสน|หมื่น|พัน|วิ|วินาที|นาที|ชั่วโมง|วัน|เดือน|ปี|ข้อ|เทคนิค|วิธี|คน|เท่าตัว)?)/u;

const MEANINGFUL_UNIT_RE = /(?:%|x|X|เท่า|บาท|ล้าน|แสน|หมื่น|พัน|วิ|วินาที|นาที|ชั่วโมง|วัน|เดือน|ปี|ข้อ|เทคนิค|วิธี|คน|[+$฿€¥])/u;

/**
 * Extracts a `{ valueText, labelText }` callout from a caption string when it contains a salient
 * number/statistic and enough surrounding context for a concise label.
 */
export function extractStatCalloutFromText(rawText: string): { valueText: string; labelText: string } | null {
  const text = (rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const match = text.match(STAT_MATCH_RE);
  if (!match || match.index === undefined) return null;

  const valueText = match[1].replace(/\s+/g, "").trim();
  if (!valueText) return null;

  const numericDigits = valueText.replace(/[^\d\u0E50-\u0E59]/gu, "");
  const hasUnitOrSymbol = MEANINGFUL_UNIT_RE.test(valueText);
  // Ignore bare single-digit numbers unless accompanied by a unit/symbol or multi-digit figure.
  if (!hasUnitOrSymbol && numericDigits.length < 2) {
    return null;
  }

  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[1].length).trim();
  const combinedLabel = [before, after]
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/^[!?:;,\-–—·•]+|[!?:;,\-–—·•]+$/gu, "")
    .trim();

  if (combinedLabel.length < 2) return null;

  const maxLabelChars = 28;
  const labelText = combinedLabel.length > maxLabelChars
    ? `${combinedLabel.slice(0, maxLabelChars - 1).trim()}…`
    : combinedLabel;

  return {
    valueText,
    labelText,
  };
}

/**
 * Plans non-overlapping animated stat callout cards across a caption timeline.
 */
export function planStatCardsForCaptions(
  captions: readonly StatCaptionInput[],
  opts: PlanStatCardsOptions = {},
): StatCardItem[] {
  if (!opts.enabled || !Array.isArray(captions) || captions.length === 0) {
    return [];
  }

  const headlineHookEndMs = typeof opts.headlineHookEndMs === "number" && opts.headlineHookEndMs > 0
    ? opts.headlineHookEndMs
    : 0;
  const minGapMs = typeof opts.minGapMs === "number" && opts.minGapMs >= 0
    ? opts.minGapMs
    : 3_000;
  const maxCards = typeof opts.maxCards === "number" && opts.maxCards > 0
    ? Math.floor(opts.maxCards)
    : 4;

  const cards: StatCardItem[] = [];
  let lastEndMs = -Infinity;

  for (let i = 0; i < captions.length; i++) {
    if (cards.length >= maxCards) break;
    const cap = captions[i];
    if (!cap || typeof cap.text !== "string") continue;

    // Avoid overlapping the opening headline hook
    if (headlineHookEndMs > 0 && cap.startMs < headlineHookEndMs) continue;
    // Enforce spacing between consecutive stat cards
    if (cap.startMs - lastEndMs < minGapMs) continue;

    const extracted = extractStatCalloutFromText(cap.text);
    if (!extracted) continue;

    const rawDuration = cap.endMs - cap.startMs;
    if (rawDuration < 700) continue;

    const durationMs = Math.min(Math.max(rawDuration, 1200), 3200);
    const startMs = Math.max(0, Math.round(cap.startMs));
    const endMs = Math.max(startMs + 700, Math.round(Math.min(cap.endMs, startMs + durationMs)));

    cards.push({
      id: `stat-${i}-${startMs}`,
      valueText: extracted.valueText,
      labelText: extracted.labelText,
      startMs,
      endMs,
      ...(opts.accentColor ? { accentColor: opts.accentColor } : {}),
    });
    lastEndMs = endMs;
  }

  return cards;
}
