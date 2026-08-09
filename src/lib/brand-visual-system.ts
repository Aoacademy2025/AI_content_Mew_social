/** Provider-neutral visual identity vocabulary for Brand Visual System V1. */
export const VISUAL_FORMAT_IDS = [
  "cinematic-realism",
  "stick-figure-story",
  "dramatic-comic",
  "clear-infographic",
  "retro-story",
] as const;

export type VisualFormatId = (typeof VISUAL_FORMAT_IDS)[number];

export type VisualFormat = {
  id: VisualFormatId;
  label: string;
  recipeVersion: string;
  description: string;
};

export const VISUAL_FORMATS: readonly VisualFormat[] = [
  {
    id: "cinematic-realism",
    label: "ภาพสมจริงแบบหนัง",
    recipeVersion: "cinematic-realism-v1",
    description: "ภาพเหมือนฉากหนัง แสงมีมิติและวัสดุสมจริง",
  },
  {
    id: "stick-figure-story",
    label: "ก้างปลาเล่าเรื่อง",
    recipeVersion: "stick-figure-story-v1",
    description: "ลายเส้นคนก้างปลา เล่าเหตุและผลด้วยท่าทางชัดเจน",
  },
  {
    id: "dramatic-comic",
    label: "คอมิกเข้มข้น",
    recipeVersion: "dramatic-comic-v1",
    description: "คอมิกเฟรมเดียว เส้นหนัก มุมกล้องและอารมณ์เข้ม",
  },
  {
    id: "clear-infographic",
    label: "อินโฟกราฟิกเข้าใจง่าย",
    recipeVersion: "clear-infographic-v1",
    description: "อธิบายด้วยรูปทรง ไอคอน และลำดับภาพโดยไม่ใช้ข้อความ",
  },
  {
    id: "retro-story",
    label: "เล่าเรื่องย้อนยุค",
    recipeVersion: "retro-story-v1",
    description: "ภาพพิมพ์บรรณาธิการกลิ่นอายยุคเก่า สีจำกัดและพื้นผิวกระดาษ",
  },
] as const;

export type VisualIdentitySnapshot = {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
};

/**
 * Creator intent is authoritative: a project-scoped override wins, followed by
 * the immutable Brand Profile Revision. AI is only the default when neither
 * creator-controlled source exists.
 */
export function resolveProjectVisualIdentity(input: {
  projectLook?: VisualIdentitySnapshot | null;
  brandRevision?: VisualIdentitySnapshot | null;
  suggested: VisualIdentitySnapshot;
}): VisualIdentitySnapshot {
  return input.projectLook ?? input.brandRevision ?? input.suggested;
}

export type VisualBeatPhase = "hook" | "explain" | "close";

export type VisualBeat = {
  phase: VisualBeatPhase;
  subject: string;
  action: string;
  setting: string;
  emotion: string;
  emphasis: string;
};

export type BrandVisualLanguage = {
  palette: string[];
  personality: string;
  peopleAndSetting?: string | null;
  memorableCues: string[];
  visualNotes?: string | null;
};

export type BrandVisualIdentityInput = {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  treatment: string;
  brandVisualLanguage: BrandVisualLanguage | null;
};

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Anonymous, deterministic identity for measuring reuse of one fully resolved
 * look. This is not a security primitive; the double hash only keeps telemetry
 * compact while making accidental collisions negligible for rollout metrics. */
export function brandVisualIdentityKey(input: BrandVisualIdentityInput): string {
  const language = input.brandVisualLanguage;
  const canonical = JSON.stringify({
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion.trim(),
    treatment: input.treatment.trim(),
    brandVisualLanguage: language ? {
      palette: language.palette,
      personality: language.personality,
      peopleAndSetting: language.peopleAndSetting ?? null,
      memorableCues: language.memorableCues,
      visualNotes: language.visualNotes ?? null,
    } : null,
  });
  return `bv1-${fnv1a(canonical, 2166136261)}${fnv1a(canonical, 3339675911)}`;
}

export type CompiledBrandVisualPrompt = {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  positive: string;
  negative: string;
};

const FORMAT_DIRECTION: Record<VisualFormatId, string> = {
  "cinematic-realism": [
    "photorealistic cinematic film still",
    "real human anatomy and believable Thai environments",
    "tactile natural materials",
    "layered foreground, midground and background",
    "35mm documentary lens language",
    "controlled filmic contrast and motivated practical lighting",
    "one nuanced human moment",
    "the entire canvas uses photographic rendering",
  ].join(", "),
  "stick-figure-story": [
    "an expressive hand-drawn stick-figure story across the entire canvas",
    "unmistakable simple round heads and line bodies",
    "every person, object, building and background uses bold imperfect marker strokes",
    "warm fibrous paper remains visible throughout the environment",
    "visual cause and effect communicated through poses, props and directional composition",
    "clever editorial simplicity",
    "flat handmade marks and simple paper shapes",
  ].join(", "),
  "dramatic-comic": [
    "dramatic inked comic illustration in a single uninterrupted frame",
    "dynamic foreshortening and an urgent camera angle",
    "thick varied ink contours",
    "angular shapes and controlled halftone shadows",
    "concentrated saturated accent colors",
    "a powerful full-canvas silhouette",
  ].join(", "),
  "clear-infographic": [
    "diagrammatic editorial illustration on one continuous vertical canvas",
    "clear top-to-bottom visual hierarchy",
    "simplified recognizable figures and objects",
    "geometric grouping made from circles, arrows and recognizable pictograms",
    "a visual flow or cutaway only when it clarifies the idea",
    "generous negative space and a restrained palette",
    "the idea is expressed entirely through visual relationships",
  ].join(", "),
  "retro-story": [
    "mid-century 1950s to 1970s editorial book illustration",
    "hand-printed screenprint and woodcut texture",
    "simplified period shapes",
    "slightly misregistered ink edges",
    "limited sepia, mustard, teal and burgundy palette on archival paper",
    "nostalgic visual language while keeping the depicted subject accurate",
  ].join(", "),
};

function artDirectionValue(value: string | null | undefined, limit = 260): string {
  return (value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function positiveArtDirectionValue(value: string | null | undefined, limit = 260): string {
  return artDirectionValue(value, limit)
    .replace(/\b(?:text|letters?|words?|numbers?|typography|captions?|subtitles?|headlines?|logos?|watermarks?|signatures?|labels?|signage|prompts?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .trim();
}

function list(values: readonly string[], limit: number): string {
  return values
    .map((value) => positiveArtDirectionValue(value, 100))
    .filter(Boolean)
    .slice(0, limit)
    .join(", ");
}

/**
 * Compile scene meaning and creator intent into one provider-neutral image
 * instruction. Format selection is an input, never a model decision. Brand
 * rules may adapt people, objects, color and mood, but cannot replace the
 * selected format recipe.
 */
export function compileBrandVisualPrompt(input: {
  visualFormatId: VisualFormatId;
  contentDomain: string;
  treatment: string;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === input.visualFormatId);
  if (!format) throw new Error("Unsupported Visual Format");

  const beat = input.visualBeat;
  const scene = [
    positiveArtDirectionValue(beat.subject),
    positiveArtDirectionValue(beat.action),
    `inside ${positiveArtDirectionValue(beat.setting)}`,
    `the mood feels ${positiveArtDirectionValue(beat.emotion)}`,
    `visual attention rests on ${positiveArtDirectionValue(beat.emphasis)}`,
  ].join(", ");
  const brand = input.brandVisualLanguage;
  const brandDirection = brand
    ? [
        `Use the recurring palette ${list(brand.palette, 6)}`,
        `The recurring personality feels ${positiveArtDirectionValue(brand.personality)}`,
        brand.peopleAndSetting
          ? `People and places follow ${positiveArtDirectionValue(brand.peopleAndSetting)}`
          : "",
        brand.memorableCues.length
          ? `Repeat the visual cues ${list(brand.memorableCues, 6)}`
          : "",
        brand.visualNotes
          ? positiveArtDirectionValue(brand.visualNotes, 360)
          : "",
      ].filter(Boolean).join(". ")
    : "Use the selected format's neutral house palette and balanced composition.";

  const positive = [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    FORMAT_DIRECTION[input.visualFormatId],
    `For a ${positiveArtDirectionValue(input.contentDomain)} story, show ${scene}`,
    `Shape the scene with a ${positiveArtDirectionValue(input.treatment)} feeling`,
    brandDirection,
    "Preserve the selected visual format exactly while adapting the subject, setting, palette and mood",
    "The lower third stays calm and uncluttered with open background texture",
    "Every visible surface uses solid undecorated color and simple abstract marks",
  ].join(". ") + ".";

  return {
    visualFormatId: format.id,
    recipeVersion: format.recipeVersion,
    positive,
    negative: [
      "text", "letters", "words", "numbers", "typography", "caption", "subtitle",
      "headline", "logo", "watermark", "signature", "brand name", "label", "signage",
      "legible writing", "comic panels", "panel borders", "collage", "split screen",
      "triptych", "storyboard", "contact sheet", "multiple camera views",
    ].join(", "),
  };
}

export const BRAND_VISUAL_BENCHMARK_SCENES: ReadonlyArray<{
  id: VisualBeatPhase;
  contentDomain: string;
  treatment: string;
  visualBeat: VisualBeat;
  seed: number;
}> = [
  {
    id: "hook",
    contentDomain: "mysterious Thai history",
    treatment: "mysterious, suspenseful and curiosity-driving with a precise focal reveal",
    seed: 202608091,
    visualBeat: {
      phase: "hook",
      subject: "a Thai woman archaeologist, a sealed stone doorway and one newly uncovered relic",
      action: "the archaeologist reaches toward a narrow opening as a beam of light reveals the relic",
      setting: "an ancient Ayutthaya temple chamber at night",
      emotion: "curiosity mixed with danger",
      emphasis: "the discovery hidden behind the doorway",
    },
  },
  {
    id: "explain",
    contentDomain: "preventive medicine",
    treatment: "professional, calm and explanatory with an immediately readable cause-and-effect flow",
    seed: 202608092,
    visualBeat: {
      phase: "explain",
      subject: "a Thai woman physician, a heart model and three colored health-state circles",
      action: "the physician holds the heart model while the three circles arc around it and a water glass rests nearby",
      setting: "a clean modern Thai clinic consultation room in daylight",
      emotion: "trustworthy professional clarity",
      emphasis: "the direct relationship between a simple daily habit and heart health",
    },
  },
  {
    id: "close",
    contentDomain: "personal finance and online commerce",
    treatment: "bright, optimistic and action-oriented with confident forward energy",
    seed: 202608093,
    visualBeat: {
      phase: "close",
      subject: "a Thai online shop owner, one plain kraft parcel and simple gold discs",
      action: "the owner presents the parcel toward the viewer while the gold discs form one rising arc around it",
      setting: "a bright compact home-business studio",
      emotion: "optimistic momentum and confident invitation",
      emphasis: "confident action that turns one small product into growing sales and savings",
    },
  },
] as const;

export const MEWSOCIAL_BENCHMARK_VISUAL_LANGUAGE: BrandVisualLanguage = {
  palette: [
    "high-contrast carbon black",
    "warm paper white",
    "vivid sky blue #38BDF8 used only as a sharp accent",
  ],
  personality: "bold, raw, energetic and direct",
  peopleAndSetting: "simple expressive stick figures grounded in recognizable Thai contexts",
  memorableCues: [
    "rough sky-blue marker circles that isolate one key object",
    "rough sky-blue marker arrows that drive the eye toward the action",
  ],
  visualNotes: [
    "Use thick imperfect black marker lines and tactile torn-paper cutout edges",
    "tilt the main composition slightly for momentum",
    "keep the lower third calm and mostly warm white",
  ].join(". "),
};

export type BrandVisualBenchmarkCase = {
  id: string;
  benchmark: "visual-format" | "brand-differentiation";
  sceneId: VisualBeatPhase;
  variant: "neutral" | "mewsocial" | "control";
  visualFormatId: VisualFormatId;
  seed: number;
  compiled: CompiledBrandVisualPrompt;
};

/** Fixed Product Brief matrix. The same three scene meanings and seeds are
 * reused across formats/brand variants so style—not subject choice—is compared. */
export function buildBrandVisualBenchmarkCases(): BrandVisualBenchmarkCase[] {
  const visualFormats = VISUAL_FORMATS.flatMap((format) => (
    BRAND_VISUAL_BENCHMARK_SCENES.map((scene) => ({
      id: `visual-format__${format.id}__${scene.id}`,
      benchmark: "visual-format" as const,
      sceneId: scene.id,
      variant: "neutral" as const,
      visualFormatId: format.id,
      seed: scene.seed,
      compiled: compileBrandVisualPrompt({
        visualFormatId: format.id,
        contentDomain: scene.contentDomain,
        treatment: scene.treatment,
        visualBeat: scene.visualBeat,
      }),
    }))
  ));

  const brandDifferentiation = (["mewsocial", "control"] as const).flatMap((variant) => (
    BRAND_VISUAL_BENCHMARK_SCENES.map((scene) => ({
      id: `brand-differentiation__${variant}__${scene.id}`,
      benchmark: "brand-differentiation" as const,
      sceneId: scene.id,
      variant,
      visualFormatId: "stick-figure-story" as const,
      seed: scene.seed,
      compiled: compileBrandVisualPrompt({
        visualFormatId: "stick-figure-story",
        contentDomain: scene.contentDomain,
        treatment: scene.treatment,
        visualBeat: scene.visualBeat,
        brandVisualLanguage: variant === "mewsocial"
          ? MEWSOCIAL_BENCHMARK_VISUAL_LANGUAGE
          : null,
      }),
    }))
  ));

  return [...visualFormats, ...brandDifferentiation];
}
