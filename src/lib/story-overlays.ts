/**
 * Transparent Story Overlay System (`StoryOverlayItem`) — AI Story Director V1.
 *
 * Brings post-ready vertical vlog & event-highlight storytelling overlays directly onto
 * real footage in `ShortVideoComposition` and `SubtitleOverlayComposition` (no solid canvas
 * obscuring the real video!):
 *   1. `hero-freeze-card` — Camera shutter flash + editorial character/role card
 *      (e.g. `SONIC · DRUM MAJOR · ทีมสีชมพู` or `SKY · DRUM MAJOR · ทีมสีส้ม`)
 *   2. `chapter-pill` — Persistent corner progress pill (`ภารกิจ 1/2`, `ภารกิจ 2/2`)
 *   3. `checklist-pop` — Beat-timed sequential `✓` checklist items popping over footage
 *   4. `countdown` — Kinetic `3 · 2 · 1` launch countdown before high-energy action
 *   5. `callout-sticker` — Face-safe floating reaction/stat sticker (`เท่มาก!`, `ได้ 3 เหรียญ!`)
 *   6. `blooper-end` — Playful fake fade-to-black + record-scratch reveal + `เบื้องหลัง` tag
 */

import {
  SFX_SUBTLE_DB,
  SFX_SUBTLE_LINEAR_VOLUME,
  type TransitionSfxCue,
  type TransitionSfxKind,
} from "./transition-sfx";

export const STORY_OVERLAY_KINDS = [
  "hero-freeze-card",
  "chapter-pill",
  "checklist-pop",
  "countdown",
  "callout-sticker",
  "blooper-end",
] as const;

export type StoryOverlayKind = (typeof STORY_OVERLAY_KINDS)[number];

export function isStoryOverlayKind(value: unknown): value is StoryOverlayKind {
  return typeof value === "string" && (STORY_OVERLAY_KINDS as readonly string[]).includes(value);
}

export interface StoryChecklistItem {
  text: string;
  /** Offset in ms from the overlay's `startMs` when this check item pops in. */
  appearOffsetMs?: number;
}

export interface StoryOverlayItem {
  id?: string;
  kind: StoryOverlayKind;
  /** Timeline start in milliseconds. */
  startMs: number;
  /** Timeline end in milliseconds. */
  endMs: number;
  /** Primary display text (e.g. character name, chapter label, sticker callout, blooper label). */
  title: string;
  /** Optional secondary line (e.g. `DRUM MAJOR · ทีมสีชมพู` or `เบื้องหลังสุดฮา`). */
  subtitle?: string;
  /** Optional small eyebrow badge (e.g. `HERO INTRO`, `MISSION`, `BONUS`). */
  badge?: string;
  /** Accent hex color `#RRGGBB` (defaults to `#FFE500` or template accent). */
  accentColor?: string;
  /** Checklist items for `checklist-pop` or custom steps for `countdown`. */
  items?: StoryChecklistItem[];
  /** Corner / anchor hint (`top-left` | `top-right` | `bottom-left` | `center` | `auto`). */
  position?: "top-left" | "top-right" | "bottom-left" | "center" | "auto";
}

export const MAX_STORY_OVERLAYS = 24;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return [...trimmed].slice(0, maxChars).join("");
}

export function normalizeStoryOverlayItem(
  raw: unknown,
  totalDurationMs = 600_000,
  index = 0,
): StoryOverlayItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!isStoryOverlayKind(obj.kind)) return null;

  const maxMs = Math.max(500, totalDurationMs);
  const rawStart = Number(obj.startMs);
  const rawEnd = Number(obj.endMs);
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;

  const startMs = Math.max(0, Math.min(maxMs - 200, Math.round(rawStart)));
  const endMs = Math.max(startMs + 250, Math.min(maxMs, Math.round(rawEnd)));

  const defaultTitle =
    obj.kind === "countdown"
      ? "3 · 2 · 1"
      : obj.kind === "blooper-end"
        ? "เบื้องหลังหลังกล้อง"
        : "";
  const title = cleanText(obj.title, 56) || defaultTitle;
  if (!title && obj.kind !== "checklist-pop") return null;

  const subtitle = cleanText(obj.subtitle, 72) || undefined;
  const badge = cleanText(obj.badge, 28) || undefined;
  const accentColor =
    typeof obj.accentColor === "string" && HEX_COLOR_RE.test(obj.accentColor.trim())
      ? obj.accentColor.trim().toUpperCase()
      : undefined;

  const position =
    obj.position === "top-left"
    || obj.position === "top-right"
    || obj.position === "bottom-left"
    || obj.position === "center"
    || obj.position === "auto"
      ? obj.position
      : "auto";

  let items: StoryChecklistItem[] | undefined;
  if (Array.isArray(obj.items) && obj.items.length > 0) {
    const durMs = endMs - startMs;
    const parsedItems: StoryChecklistItem[] = [];
    for (let i = 0; i < Math.min(6, obj.items.length); i += 1) {
      const rawItem = obj.items[i];
      if (typeof rawItem === "string") {
        const t = cleanText(rawItem, 44);
        if (t) {
          parsedItems.push({
            text: t,
            appearOffsetMs: Math.round((i * Math.min(durMs * 0.72, 1800)) / Math.max(1, obj.items.length)),
          });
        }
      } else if (rawItem && typeof rawItem === "object") {
        const rec = rawItem as Record<string, unknown>;
        const t = cleanText(rec.text, 44);
        if (!t) continue;
        const off = Number(rec.appearOffsetMs);
        parsedItems.push({
          text: t,
          appearOffsetMs: Number.isFinite(off)
            ? Math.max(0, Math.min(durMs - 120, Math.round(off)))
            : Math.round((i * Math.min(durMs * 0.72, 1800)) / Math.max(1, obj.items.length)),
        });
      }
    }
    if (parsedItems.length > 0) items = parsedItems;
  }

  if (obj.kind === "checklist-pop" && (!items || items.length === 0)) {
    return null;
  }

  return {
    id: cleanText(obj.id, 40) || `story-ov-${index}-${obj.kind}-${startMs}`,
    kind: obj.kind,
    startMs,
    endMs,
    title: title || "เช็กลิสต์ภารกิจ",
    ...(subtitle ? { subtitle } : {}),
    ...(badge ? { badge } : {}),
    ...(accentColor ? { accentColor } : {}),
    ...(items ? { items } : {}),
    position,
  };
}

export function normalizeStoryOverlays(
  value: unknown,
  totalDurationMs = 600_000,
): StoryOverlayItem[] {
  if (!Array.isArray(value)) return [];
  const out: StoryOverlayItem[] = [];
  for (let i = 0; i < value.length && out.length < MAX_STORY_OVERLAYS; i += 1) {
    const normalized = normalizeStoryOverlayItem(value[i], totalDurationMs, i);
    if (normalized) out.push(normalized);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const STORY_SFX_DURATION_BY_KIND: Record<TransitionSfxKind, number> = {
  whoosh: 0.22,
  pop: 0.12,
  shutter: 0.18,
  ding: 0.34,
  drumroll: 0.55,
  boom: 0.48,
  "record-scratch": 0.38,
};

/**
 * Deterministically plans crisp, subtle event SFX cues matching `StoryOverlayItem`s
 * (camera shutter on `hero-freeze-card`, bell ding on `checklist-pop`, countdown pops/boom,
 * record-scratch on `blooper-end`).
 */
export function planStoryOverlaySfxCues(
  overlays: readonly StoryOverlayItem[] | null | undefined,
  totalDurationSec = Infinity,
): TransitionSfxCue[] {
  if (!overlays || overlays.length === 0) return [];
  const cues: TransitionSfxCue[] = [];
  const pushCue = (timeSec: number, kind: TransitionSfxKind, gainBoost = 1.12) => {
    if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > totalDurationSec - 0.15) return;
    const volumeLinear = Number(Math.min(0.32, SFX_SUBTLE_LINEAR_VOLUME * gainBoost).toFixed(4));
    cues.push({
      timeSec: Number(timeSec.toFixed(3)),
      kind,
      durationSec: STORY_SFX_DURATION_BY_KIND[kind],
      volumeLinear,
      volumeDb: SFX_SUBTLE_DB,
    });
  };

  for (const ov of overlays) {
    const startSec = ov.startMs / 1000;
    switch (ov.kind) {
      case "hero-freeze-card":
        pushCue(startSec, "shutter", 1.35);
        pushCue(startSec + 0.14, "boom", 1.15);
        break;
      case "chapter-pill":
        pushCue(startSec, "pop", 1.0);
        break;
      case "checklist-pop": {
        const items = ov.items ?? [];
        for (let i = 0; i < items.length; i += 1) {
          const offsetSec = (items[i]!.appearOffsetMs ?? i * 450) / 1000;
          pushCue(startSec + offsetSec, "ding", 1.2);
        }
        break;
      }
      case "countdown": {
        const durSec = Math.max(0.6, (ov.endMs - ov.startMs) / 1000);
        const steps = ov.items?.length ? ov.items.length : 3;
        const stepDur = durSec / steps;
        pushCue(Math.max(0, startSec - 0.04), "drumroll", 1.15);
        for (let s = 0; s < steps; s += 1) {
          pushCue(startSec + s * stepDur, s === steps - 1 ? "boom" : "pop", 1.2);
        }
        break;
      }
      case "callout-sticker":
        pushCue(startSec, "pop", 1.1);
        break;
      case "blooper-end":
        pushCue(startSec + 0.28, "record-scratch", 1.35);
        break;
    }
  }

  cues.sort((a, b) => a.timeSec - b.timeSec);
  // Deduplicate ultra-close cues (< 90ms) while allowing intentional shutter+boom layering (140ms)
  const filtered: TransitionSfxCue[] = [];
  for (const cue of cues) {
    const prev = filtered[filtered.length - 1];
    if (prev && prev.kind === cue.kind && cue.timeSec - prev.timeSec < 0.12) continue;
    filtered.push(cue);
  }
  return filtered.slice(0, 28);
}
