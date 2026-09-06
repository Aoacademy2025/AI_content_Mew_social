import type { Overlay, TranscriptSegment } from "@/lib/desktop/types";

export type ModelVersionDraft = {
  sequence: string[];
  overlays: Overlay[];
  headline: string;
  caption: string;
  rationale: string;
};

export type ModelSplitDraft = {
  start: number;
  end: number;
  headline: string;
  caption: string;
  reason: string;
};

export function extractJson(value: string): unknown {
  const clean = value.replace(/```(?:json)?/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseOverlay(value: unknown): Overlay | null {
  if (!isRecord(value)) return null;
  const productFootageId = asString(value.productFootageId);
  const anchor = isRecord(value.anchor) ? value.anchor : null;
  const talkingFootageId = anchor ? asString(anchor.talkingFootageId) : null;
  const segmentIndex = anchor && typeof anchor.segmentIndex === "number" && Number.isInteger(anchor.segmentIndex)
    ? anchor.segmentIndex
    : null;
  const lenSec = typeof value.lenSec === "number" && Number.isFinite(value.lenSec) ? value.lenSec : null;
  if (!productFootageId || !talkingFootageId || segmentIndex === null || lenSec === null) return null;
  return { productFootageId, anchor: { talkingFootageId, segmentIndex }, lenSec };
}

function parseVersion(value: unknown): ModelVersionDraft | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.sequence) || !value.sequence.every((id) => typeof id === "string")) return null;
  const headline = asString(value.headline);
  const caption = asString(value.caption);
  if (headline === null || caption === null) return null;
  const overlays = Array.isArray(value.overlays)
    ? value.overlays.map(parseOverlay).filter((o): o is Overlay => o !== null)
    : [];
  return {
    sequence: value.sequence,
    overlays,
    headline,
    caption,
    rationale: asString(value.rationale) ?? "",
  };
}

export function parsePlanVersionsJson(raw: string): { versions: ModelVersionDraft[] } | null {
  const parsed = extractJson(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.versions)) return null;
  const versions: ModelVersionDraft[] = [];
  for (const item of parsed.versions) {
    const v = parseVersion(item);
    if (!v) return null;
    versions.push(v);
  }
  return { versions };
}

function parseSplitItem(value: unknown): ModelSplitDraft | null {
  if (!isRecord(value)) return null;
  const start = typeof value.start === "number" && Number.isFinite(value.start) ? value.start : null;
  const end = typeof value.end === "number" && Number.isFinite(value.end) ? value.end : null;
  const headline = asString(value.headline);
  const caption = asString(value.caption);
  const reason = asString(value.reason);
  if (start === null || end === null || headline === null || caption === null || reason === null) return null;
  return { start, end, headline, caption, reason };
}

export function parsePlanSplitJson(raw: string): { segments: ModelSplitDraft[] } | null {
  const parsed = extractJson(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.segments)) return null;
  const segments: ModelSplitDraft[] = [];
  for (const item of parsed.segments) {
    const s = parseSplitItem(item);
    if (!s) return null;
    segments.push(s);
  }
  return { segments };
}

export function proposeSplitSpans(
  transcript: TranscriptSegment[],
  durationSec: number,
): { start: number; end: number }[] {
  const segs = transcript
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (segs.length === 0) return [];

  const TARGET = 30;
  const MIN = 15;
  const MAX = 60;
  const GAP = 3;
  const cap = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : segs[segs.length - 1].end;
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < segs.length) {
    const start = segs[i].start;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].end - start <= MAX && segs[j + 1].end <= cap) {
      j++;
      if (segs[j].end - start >= TARGET) break;
    }
    const end = Math.min(segs[j].end, cap);
    if (end - start >= MIN) {
      out.push({ start, end });
      const minNext = end + GAP;
      const next = segs.findIndex((s, idx) => idx > j && s.start >= minNext);
      if (next < 0) break;
      i = next;
    } else {
      i++;
    }
  }
  return out;
}
