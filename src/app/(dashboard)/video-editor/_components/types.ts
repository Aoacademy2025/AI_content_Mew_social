// ─── Pipeline types (shared with video-creator) ────────────────────────────

export type StepStatus = "idle" | "running" | "done" | "error" | "skip";

export interface StepState {
  keywords:    StepStatus;
  fetchStock:  StepStatus;
  tts:         StepStatus;
  transcribe:  StepStatus;
  config:      StepStatus;
  render:      StepStatus;
  avatar:      StepStatus;
  avatarTail:  StepStatus;
  composite:   StepStatus;
}

export const DEFAULT_STEPS: StepState = {
  keywords: "idle", fetchStock: "idle", tts: "idle",
  transcribe: "idle", config: "idle", render: "idle",
  avatar: "idle", avatarTail: "idle", composite: "idle",
};

export interface Caption {
  text:    string;
  startMs: number;
  endMs:   number;
  tag?:    "hook" | "body" | "cta";
}

export interface StockVideo {
  keyword:   string;
  localUrl?: string;
  videoUrl:  string;
  duration:  number;
  pexelsId:  number;
}

export interface PipelineData {
  scenes:              string[];
  keywords:            string[];
  keywordAlternatives: string[][];
  keywordsPerScene:    number;
  sceneClipCounts:     number[];
  sceneDurations:      number[];
  visualDirection:     string;
  stockVideos:         StockVideo[];
  voiceUrl:            string;
  captions:            Caption[];
  sceneCaptions:       Caption[];
  words:               { word: string; startMs: number; endMs: number }[];
  audioDurationMs:     number;
  config:              unknown;
  renderedVideoUrl:    string;
  compositeUrl:        string;
}

// ─── Subtitle style ────────────────────────────────────────────────────────

export type SubPreset =
  | "stroke" | "plain" | "shadow" | "box" | "box-rounded" | "glow" | "outline-only"
  | "karaoke" | "typewriter" | "bold-shadow" | "karaoke-box" | "pop-outline"
  | "neon-green" | "neon-red" | "neon-blue"
  | "pastel" | "classic-yellow" | "hormozi" | "beast"
  | "box-white" | "box-yellow" | "retro" | "sharp-outline" | "news";

export type SubTextEffect =
  | "pop" | "bounce" | "fade" | "quick" | "glow-pulse"
  | "slide" | "flip" | "highlight" | "karaoke" | "typewriter";

export interface SubtitleStyle {
  fontFamily:  string;
  fontSize:    number;
  fontWeight:  number;
  color:       string;
  accentColor: string;
  preset:      SubPreset;
  effect:      SubTextEffect;
  position:    number; // 0–100, vertical %
  shadow:      boolean;
  outline:     boolean;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily:  "'Kanit', sans-serif",
  fontSize:    80,
  fontWeight:  900,
  color:       "#FFFFFF",
  accentColor: "#FFE500",
  preset:      "stroke",
  effect:      "pop",
  position:    68,
  shadow:      true,
  outline:     false,
};

// ─── Timeline clip ─────────────────────────────────────────────────────────

export type TrackType = "subtitle" | "broll" | "voice" | "music";

export interface TimelineClip {
  id:        string;
  track:     TrackType;
  startMs:   number;
  endMs:     number;
  label:     string;
  captionIdx?: number; // for subtitle clips
  tag?:      "hook" | "body" | "cta";
  src?:      string;
}

// ─── Draft (saved to localStorage) ────────────────────────────────────────

export interface EditorDraft {
  id:        string;
  name:      string;
  updatedAt: number;
  script:    string;
  stepsDone: (keyof StepState)[];
  pipeline:  Partial<PipelineData>;
  style:     SubtitleStyle;
  clips:     TimelineClip[];
  // voice settings
  ttsProvider:     "elevenlabs" | "gemini";
  voiceId:         string;
  geminiVoiceName: string;
  // avatar
  useAvatar:  boolean;
  avatarId:   string;
  // render output
  renderedUrl: string;
}

export const DRAFT_STORAGE_KEY = "ve_drafts_v1";
