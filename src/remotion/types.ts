export type SceneEffect =
  | "zoom-in" | "zoom-out"
  | "pan-left" | "pan-right" | "pan-up" | "pan-down"
  | "ken-burns" | "ken-burns-2" | "ken-burns-3"
  | "diagonal-tl" | "diagonal-br"
  | "fade-in" | "pulse";

export interface SceneData {
  imageUrl: string | null;
  caption: string;     // Thai text from mapping
  time: string;        // e.g. "0-15" or "15-30"
  sceneTitle: string;
  effect?: SceneEffect;
}

/** Whisper segment — precise start/end in seconds */
export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface VideoCompositionProps {
  scenes: SceneData[];
  audioUrl?: string | null;
  /** If provided, overrides scene.mapping timing with Whisper-accurate timestamps */
  captionSegments?: CaptionSegment[] | null;
  /** Hide scene title label (used when rendering BG video for HeyGen) */
  hideTitle?: boolean;
  fps?: number;
}

// ── Short Video types ──────────────────────────────────────────────────────

export interface BrollVideo {
  src: string;         // absolute URL or /renders/xxx.mp4
  start: number;       // timeline position: seconds from video start
  end: number;         // timeline position: seconds from video start
  clipOffset?: number; // where inside the source clip to start playing (seconds, default 0)
  clipDuration?: number; // actual source clip duration in seconds (for Loop)
}

export type SubtitleStylePreset =
  | "stroke"       // classic thick black stroke (default)
  | "box"          // semi-transparent dark box behind text
  | "box-rounded"  // rounded pill box
  | "glow"         // color glow, no stroke
  | "outline-only" // thin clean outline, no fill shadow;

export interface KeywordPopupItem {
  text: string;
  start: number;       // frame number
  end: number;         // frame number
  color: string;       // #FFFFFF | #FFD700 | #FF4444
  size: number;        // 85 | 95 | 110
  isHighlight: boolean;
  topPercent?: number; // default 38
  stylePreset?: SubtitleStylePreset;
  fontWeight?: number; // 300–900, default 900
  tag?: "hook" | "body" | "cta";
}

export interface SubtitleOverlayConfig {
  videoUrl: string;
  keywordPopups: KeywordPopupItem[];
  durationInFrames: number;
  fontFamily?: string;
}

export interface ShortVideoConfig {
  bgVideos: BrollVideo[];
  keywordPopups: KeywordPopupItem[];
  voiceFile: string;
  voiceVolume: number;
  bgmFile?: string;
  bgmVolume?: number;
  flashFrames?: number[];
  durationInFrames: number;
  fontFamily?: string;
  subtitleStylePreset?: SubtitleStylePreset;
}

/** Parse "0-15" or "15-30" → { startSec, durationSec } */
export function parseTime(time: string): { startSec: number; durationSec: number } {
  const parts = time.split("-").map((s) => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { startSec: parts[0], durationSec: parts[1] - parts[0] };
  }
  const single = parseInt(time, 10);
  return { startSec: 0, durationSec: isNaN(single) ? 15 : single };
}
