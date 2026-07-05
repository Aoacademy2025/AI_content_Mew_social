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

// "kie-image" = สร้างภาพด้วย AI แล้วแปลงเป็นวิดีโอผ่าน kie.ai — admin-only
// "auto-mix" = วิดีโอ Pexels/Pixabay เป็นหลัก ถ้า keyword ไหนหา clip ดีไม่ได้ fallback เป็นภาพ
//   (Unsplash -> kie.ai AI image) แล้วทำ Ken Burns — admin-only (ทดลอง)
export type StockSource = "pexels" | "pixabay" | "both" | "kie-image" | "auto-mix";

// โมเดล text-to-image ของ kie.ai ที่เลือกได้ — ขนาดภาพ fix ที่ 9:16 เสมอ
export type KieImageModel =
  | "nano-banana-pro" | "nano-banana-2" | "gpt-image-2-text-to-image"
  | "seedream/5-lite-text-to-image" | "seedream/4.5-text-to-image"
  | "flux-2/pro-text-to-image" | "grok-imagine/text-to-image" | "qwen2/text-to-image";
export const KIE_IMAGE_MODEL_OPTIONS: { value: KieImageModel; label: string }[] = [
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "gpt-image-2-text-to-image", label: "GPT Image 2" },
  { value: "seedream/5-lite-text-to-image", label: "Seedream 5 Lite" },
  { value: "seedream/4.5-text-to-image", label: "Seedream 4.5" },
  { value: "flux-2/pro-text-to-image", label: "Flux 2 Pro" },
  { value: "grok-imagine/text-to-image", label: "Grok Imagine" },
  { value: "qwen2/text-to-image", label: "Qwen2" },
];

// แหล่งที่มาของ B-roll ที่ Auto Mix เลือกใช้ได้ — เลือกได้หลายตัว
// - "video" = หาวิดีโอจริง (Pexels/Pixabay) — ถ้าปิด Auto Mix จะข้าม video ไปใช้ภาพล้วน
// - ที่เหลือ = provider ภาพ fallback (ทำ Ken Burns), ลำดับลองตาม keyword-aware routing ฝั่ง server
// รายการนี้แค่ "เปิด/ปิด" ตัวไหนให้อยู่ในการพิจารณา — ไม่ใช่ลำดับ
export type AutoMixImageProvider = "video" | "unsplash" | "pexels-photo" | "pixabay-photo" | "wikimedia" | "flickr" | "nasa" | "met" | "kie-ai";
export const AUTO_MIX_PROVIDER_OPTIONS: { value: AutoMixImageProvider; label: string; needsKey?: "unsplash" | "flickr" | "kie" }[] = [
  { value: "video", label: "วิดีโอจริง (Pexels/Pixabay)" },
  { value: "unsplash", label: "Unsplash", needsKey: "unsplash" },
  { value: "pexels-photo", label: "Pexels Photo" },
  { value: "pixabay-photo", label: "Pixabay Photo" },
  { value: "wikimedia", label: "Wikimedia Commons" },
  { value: "flickr", label: "Flickr CC", needsKey: "flickr" },
  { value: "nasa", label: "NASA Image" },
  { value: "met", label: "The Met Museum" },
  { value: "kie-ai", label: "kie.ai (AI generate)", needsKey: "kie" },
];
export const DEFAULT_AUTO_MIX_PROVIDERS: AutoMixImageProvider[] = AUTO_MIX_PROVIDER_OPTIONS.map(o => o.value);

export interface StockVideo {
  keyword:   string;
  localUrl?: string;
  videoUrl:  string;
  duration:  number;
  pexelsId:  number;
  // ภาพต้นทาง (kie.ai AI Image + Ken Burns) — ใช้แสดง preview ระหว่าง generate
  imageUrl?:      string;
  imageLocalUrl?: string;
  // Metadata สำหรับ license/attribution ของ asset (auto-mix: pexels/pixabay/unsplash/kie-ai/wikimedia/flickr/nasa/met)
  assetMeta?: {
    provider: "pexels" | "pixabay" | "unsplash" | "kie-ai" | "wikimedia" | "flickr" | "nasa" | "met";
    assetId: string;
    downloadUrl?: string;
    creator?: string;
    license?: string;
    sourcePage?: string;
  };
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
  brollWindows?:          import("@/lib/broll-windows").BrollWindow[];  // window-mode b-roll (flag-gated)
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

  ttsProvider: "elevenlabs" | "gemini" | "omnivoice";
  voiceId: string;
  geminiVoiceName: string;
  omniVoiceId?: string;
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
  stockSource?: StockSource;
  // โมเดล text-to-image ของ kie.ai (เมื่อ stockSource === "kie-image")
  kieModel?: KieImageModel;
  // ผู้ให้บริการภาพ fallback ที่เปิดใช้สำหรับ Auto Mix (undefined = ทุกตัว)
  autoMixProviders?: AutoMixImageProvider[];
  // จำนวนคลิป B-roll (0/undefined = Auto)
  targetClipCount?: number;

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
