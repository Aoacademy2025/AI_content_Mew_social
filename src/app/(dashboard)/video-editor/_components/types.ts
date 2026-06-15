// ─── Pipeline types ────────────────────────────────────────────────────────

export type StepStatus = "idle" | "running" | "done" | "error" | "skip";

export interface StepState {
  keywords:       StepStatus;
  fetchStock:     StepStatus;
  tts:            StepStatus;
  transcribe:     StepStatus;
  config:         StepStatus;
  render:         StepStatus;
  burnSubtitles:  StepStatus;
  avatar:         StepStatus;
  avatarTail:     StepStatus;
  composite:      StepStatus;
}

export const DEFAULT_STEPS: StepState = {
  keywords: "idle", fetchStock: "idle", tts: "idle",
  transcribe: "idle", config: "idle", render: "idle",
  burnSubtitles: "idle",
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
  title?: string;
  query?: string;
  provider?: "pexels" | "pixabay";
  contentProfile?: string;
  selectionReason?: string;
  relevanceScore?: number;
}

export interface PipelineData {
  scenes:                 string[];
  keywords:               string[];
  keywordAlternatives:    string[][];
  keywordsPerScene:       number;
  sceneClipCounts:        number[];
  sceneDurations:         number[];
  visualDirection:        string;
  relevanceSpec?:         unknown;     // per-script LLM relevance spec → forwarded to fetch-stock for accurate b-roll
  contentProfile:         string;
  stockVideos:            StockVideo[];
  voiceUrl:               string;
  captions:               Caption[];
  sceneCaptions:          Caption[];
  words:                  { word: string; startMs: number; endMs: number }[];
  audioDurationMs:        number;
  config:                 unknown;
  renderedVideoUrl:       string;        // วิดีโอ render ล่าสุด (no-sub หรือ with-sub)
  renderedVideoNoSubUrl:  string;        // input ของ Burn Subtitles
  burnedVideoUrl:         string;        // output ของ Burn Subtitles
  galleryVideoId:         string;        // id ของ Video record ใน Gallery
  compositeUrl:           string;
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

// ─── Draft (saved to localStorage) ────────────────────────────────────────

export interface EditorDraft {
  id: string;
  name: string;
  updatedAt: number;
  script: string;
  scriptOverride?: string;
  style: {
    fontFamily: string; fontSize: number; fontWeight: number;
    color: string; accentColor: string; preset: SubPreset; effect: SubTextEffect; position: number;
    shadow?: boolean; outline?: boolean; outlineSize?: number;
  };
  renderedUrl: string;
  renderedVideoNoSubUrl?: string;
  burnedVideoUrl?: string;
  galleryVideoId?: string;
  compositeUrl?: string;

  ttsProvider: "elevenlabs" | "gemini";
  voiceId: string;
  geminiVoiceName: string;
  captions?: Caption[];
  voiceUrl?: string;
  audioDurationMs?: number;

  // Pipeline data — resume without rerunning
  keywords?: string[];
  keywordAlternatives?: string[][];
  keywordsPerScene?: number;
  sceneClipCounts?: number[];
  sceneDurations?: number[];
  scenes?: string[];
  visualDirection?: string;
  contentProfile?: string;
  stockVideos?: StockVideo[];
  config?: unknown;

  // Stock source
  stockSource?: "pexels" | "pixabay" | "both";

  // BGM
  bgmEnabled?: boolean;
  bgmFile?: string;
  bgmVolume?: number;

  // Avatar
  useAvatar?: boolean;
  avatarId?: string;
  avatarName?: string;
  avatarPreviewUrl?: string;
  avatarTiming?: "full" | "bookend" | "bookend-both";
  avatarBookendSecs?: number;
  avatarTailSecs?: number;
  avatarScale?: number;
  avatarOffsetX?: number;
  avatarOffsetY?: number;
  // ระบบเลเยอร์ composite (scale 1 = เต็มเฟรม) — draft ที่ไม่มี flag นี้เก็บค่าหน่วยเก่า (HeyGen-zoom) ห้ามนำมาใช้
  avatarLayoutV2?: boolean;
  avatarInputMode?: "generate" | "direct";
  avatarDirectUrl?: string;
  chromaSimilarity?: number;
  chromaBlend?: number;
  avatarGreenUrl?: string;
  avatarTailGreenUrl?: string;
}
