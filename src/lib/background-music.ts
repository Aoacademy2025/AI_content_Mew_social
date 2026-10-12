// Background music edit (EP5 U7 + #2, HERO-71): change the BGM after the video exists, set its
// volume, and optionally duck it under the voice. Pure + client-safe: the web Post phase (live
// preview), the MCP set_background_music tool, the export enqueue and the Remotion burn all use
// these same definitions so the preview, the stored draft and the exported file agree.
//
// The base render bakes voice + old music into one track, so a changed music cannot be layered on
// top of it. When the user edits the music, the burn mutes the base video and re-mixes the voice
// track with the new music (SubtitleAudioMix). With no edit nothing here is used and the burn
// keeps the base audio exactly as before.

/** The edit the user chose. `track` is a library path (`/music/<f>` system, `/api/music/<f>`
 *  the user's own upload) or null for "no music". `volume` is 0..1 (UI shows 0-100 %). */
export type BackgroundMusicEdit = {
  track: string | null;
  volume: number;
  ducking: boolean;
};

export type SpeechSegment = { startMs: number; endMs: number };

/** The burn's audio when the music was edited: the base video is muted and these play instead. */
export type SubtitleAudioMix = {
  voiceFile: string;
  voiceVolume: number;
  bgmFile?: string;
  bgmVolume: number;
  ducking: boolean;
  duckSegments?: SpeechSegment[];
};

/** The base render's default music level (ShortVideo uses the same fallback). */
export const DEFAULT_BGM_VOLUME = 0.12;
/** Music level under speech, as a fraction of the chosen volume (~ -9 dB). */
export const DUCK_RATIO = 0.35;
/** Fade into / out of the ducked level. */
export const DUCK_RAMP_MS = 200;
/** Pauses shorter than this stay ducked, so the music does not pump between words. */
export const DUCK_MERGE_GAP_MS = 500;
export const MAX_DUCK_SEGMENTS = 2_000;

const TRACK_PATH = /^\/(api\/)?music\/([^/\\]+)$/;

/** A library path the app itself serves: `/music/<file>` or `/api/music/<file>`, one segment. */
export function backgroundMusicTrackFilename(track: unknown): { filename: string; kind: "system" | "user" } | null {
  if (typeof track !== "string" || track.length > 255) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(track)) return null;
  const match = TRACK_PATH.exec(track);
  if (!match) return null;
  const filename = match[2];
  if (!filename || filename === "." || filename.includes("..")) return null;
  return { filename, kind: match[1] ? "user" : "system" };
}

export function isBackgroundMusicTrackPath(track: unknown): track is string {
  return backgroundMusicTrackFilename(track) !== null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Validate a stored / submitted edit. Anything malformed → null (callers refuse or ignore). */
export function normalizeBackgroundMusicEdit(value: unknown): BackgroundMusicEdit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const track = raw.track === null ? null : isBackgroundMusicTrackPath(raw.track) ? raw.track : undefined;
  if (track === undefined) return null;
  if (typeof raw.volume !== "number" || !Number.isFinite(raw.volume)) return null;
  if (raw.ducking !== undefined && typeof raw.ducking !== "boolean") return null;
  return { track, volume: clamp01(raw.volume), ducking: raw.ducking === true };
}

/** The draft path for a library pick (the web library lists filenames + kind). Null = refused. */
export function backgroundMusicTrackPath(filename: string, kind: "system" | "user"): string | null {
  const track = kind === "user" ? `/api/music/${filename}` : `/music/${filename}`;
  return isBackgroundMusicTrackPath(track) ? track : null;
}

/** The rendered video's own music, as the panel shows it before any change. `hasMusic` is true
 *  even when the stored path is not a library path (then `edit.track` is null and only a new
 *  pick, not a volume-only change, can replace it). */
export function baseBackgroundMusicEdit(config: Record<string, unknown> | null | undefined): {
  edit: BackgroundMusicEdit;
  hasMusic: boolean;
} {
  const bgmFile = config?.bgmFile;
  const rawVolume = config?.bgmVolume;
  const volume = typeof rawVolume === "number" && Number.isFinite(rawVolume) ? clamp01(rawVolume) : DEFAULT_BGM_VOLUME;
  const hasMusic = typeof bgmFile === "string" && bgmFile.trim().length > 0;
  return {
    edit: { track: hasMusic && isBackgroundMusicTrackPath(bgmFile) ? bgmFile : null, volume, ducking: false },
    hasMusic,
  };
}

/** Where a looping music file is at video time `videoSec` (Remotion `<Audio loop>` restarts it). */
export function loopedPositionSec(videoSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec)) return videoSec;
  if (durationSec <= 0) return 0;
  return videoSec % durationSec;
}

/** Browser-playable URL for a library path. System files live in public/music but the base
 *  config stores `/music/<f>`; `/api/music/<f>` serves both kinds same-origin. */
export function previewSrcForTrack(track: string | null | undefined): string | null {
  const parsed = backgroundMusicTrackFilename(track);
  return parsed ? `/api/music/${encodeURIComponent(parsed.filename)}` : null;
}

/** What the creator asked of the preview <video>'s own mute / volume controls. */
export type PreviewListenerIntent = { muted: boolean; volume: number };

function unitLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/**
 * While a music change plays beside the preview, the <video> is held muted (its baked mix still
 * has the old music), so its native mute / volume controls would do nothing. Read each
 * `volumechange` as the creator's intent instead: the hook only ever MUTES, so an unmute or a new
 * level is theirs; a re-mute at an unchanged level is the hook's own and changes nothing.
 */
export function nextPreviewListenerIntent(
  prev: PreviewListenerIntent,
  observed: PreviewListenerIntent,
): PreviewListenerIntent {
  const volume = unitLevel(observed.volume);
  if (!observed.muted || volume !== prev.volume) return { muted: false, volume };
  return { muted: prev.muted, volume };
}

/** The level (0–1) the voice and music play at for `intent`. */
export function previewListenerLevel(intent: PreviewListenerIntent): number {
  return intent.muted ? 0 : unitLevel(intent.volume);
}

type TimedSpan = { startMs?: unknown; endMs?: unknown };

function validSpans(spans: readonly TimedSpan[] | null | undefined): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  for (const span of spans ?? []) {
    const startMs = span?.startMs;
    const endMs = span?.endMs;
    if (typeof startMs !== "number" || typeof endMs !== "number") continue;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    out.push({ startMs: Math.max(0, startMs), endMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Where the voice speaks: word timing when present (tightest), else caption timing. Spans are
 *  merged across pauses shorter than `mergeGapMs` and capped at MAX_DUCK_SEGMENTS. */
export function speechSegments(
  timing: { words?: readonly TimedSpan[] | null; captions?: readonly TimedSpan[] | null },
  mergeGapMs = DUCK_MERGE_GAP_MS,
): SpeechSegment[] {
  const fromWords = validSpans(timing.words);
  const spans = fromWords.length ? fromWords : validSpans(timing.captions);
  const merged: SpeechSegment[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startMs - last.endMs < mergeGapMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged.slice(0, MAX_DUCK_SEGMENTS);
}

/** 0 = music at full volume, 1 = fully ducked. Linear ramps of `rampMs` either side of a phrase.
 *  `segments` must be sorted by start (speechSegments / normalizeAudioMix guarantee it). */
export function duckAmountAt(ms: number, segments: readonly SpeechSegment[], rampMs = DUCK_RAMP_MS): number {
  let amount = 0;
  for (const segment of segments) {
    if (segment.startMs - rampMs > ms) break;
    let value = 0;
    if (ms >= segment.startMs && ms <= segment.endMs) value = 1;
    else if (ms < segment.startMs) value = rampMs > 0 ? 1 - (segment.startMs - ms) / rampMs : 0;
    else value = rampMs > 0 ? 1 - (ms - segment.endMs) / rampMs : 0;
    if (value > amount) amount = value;
    if (amount >= 1) return 1;
  }
  return Math.max(0, amount);
}

/** The music gain at time `ms` (absolute timeline). Ducking off → constant `volume`. */
export function bgmGainAt(
  ms: number,
  mix: { volume: number; ducking: boolean; segments?: readonly SpeechSegment[] | null },
): number {
  if (!mix.ducking || !mix.segments?.length) return mix.volume;
  return mix.volume * (1 - (1 - DUCK_RATIO) * duckAmountAt(ms, mix.segments));
}

/** Validate the burn's audioMix prop (render route + composition). No voice → null: the burn
 *  must never produce a silent video, so callers fall back to the base audio. */
export function normalizeAudioMix(value: unknown): SubtitleAudioMix | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.voiceFile !== "string" || !raw.voiceFile.trim()) return null;
  const voiceVolume = typeof raw.voiceVolume === "number" && Number.isFinite(raw.voiceVolume)
    ? Math.min(2, Math.max(0, raw.voiceVolume)) : 1;
  const bgmVolume = typeof raw.bgmVolume === "number" && Number.isFinite(raw.bgmVolume)
    ? clamp01(raw.bgmVolume) : DEFAULT_BGM_VOLUME;
  const segments = Array.isArray(raw.duckSegments)
    ? validSpans(raw.duckSegments as TimedSpan[]).slice(0, MAX_DUCK_SEGMENTS) : [];
  return {
    voiceFile: raw.voiceFile,
    voiceVolume,
    ...(typeof raw.bgmFile === "string" && raw.bgmFile.trim() ? { bgmFile: raw.bgmFile } : {}),
    bgmVolume,
    ducking: raw.ducking === true,
    ...(segments.length ? { duckSegments: segments } : {}),
  };
}
