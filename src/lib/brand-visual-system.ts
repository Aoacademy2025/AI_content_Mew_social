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
    recipeVersion: "cinematic-realism-v3",
    description: "ภาพเหมือนฉากหนัง แสงมีมิติและวัสดุสมจริง",
  },
  {
    id: "stick-figure-story",
    label: "ก้างปลาเล่าเรื่อง",
    recipeVersion: "stick-figure-story-v3",
    description: "ลายเส้นคนก้างปลา เล่าเหตุและผลด้วยท่าทางชัดเจน",
  },
  {
    id: "dramatic-comic",
    label: "คอมิกเข้มข้น",
    recipeVersion: "dramatic-comic-v3",
    description: "คอมิกเฟรมเดียว เส้นหนัก มุมกล้องและอารมณ์เข้ม",
  },
  {
    id: "clear-infographic",
    label: "อินโฟกราฟิกเข้าใจง่าย",
    recipeVersion: "clear-infographic-v3",
    description: "อธิบายด้วยรูปทรง ไอคอน และลำดับภาพโดยไม่ใช้ข้อความ",
  },
  {
    id: "retro-story",
    label: "เล่าเรื่องย้อนยุค",
    recipeVersion: "retro-story-v3",
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

/** Stable Brand DNA identity for cross-project retention analytics. Treatment
 * deliberately stays out: it is one-video art direction, while format,
 * compiler recipe and Brand Visual Language are the reusable Brand Look. */
export function brandLookIdentityKey(input: BrandVisualIdentityInput): string {
  const language = input.brandVisualLanguage;
  const canonical = JSON.stringify({
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion.trim(),
    brandVisualLanguage: language ? {
      palette: language.palette,
      personality: language.personality,
      peopleAndSetting: language.peopleAndSetting ?? null,
      memorableCues: language.memorableCues,
      visualNotes: language.visualNotes ?? null,
    } : null,
  });
  return `bl1-${fnv1a(canonical, 2166136261)}${fnv1a(canonical, 3339675911)}`;
}

export type CompiledBrandVisualPrompt = {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  positive: string;
  negative: string;
};

type VersionedRecipe = {
  formatId: VisualFormatId;
  direction: string;
  extraNegative?: readonly string[];
};

/** Frozen provider grammar for revisions published before the compiler-v2
 * safety boundary. Never route these versions through the v2 sanitizer: the
 * recipe version is the complete provider contract, not only an art-style
 * label. */
const V1_FORMAT_DIRECTION: Readonly<Record<VisualFormatId, string>> = {
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

/** Frozen provider grammar for revisions published against the v2 compiler.
 * ADR 0005 pins a recipe version per Brand Profile Revision, so these strings
 * are history: story-first fixes land in `V3_FORMAT_RECIPE_DIRECTION`. */
const V2_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, VersionedRecipe>> = {
  "cinematic-realism-v2": { formatId: "cinematic-realism", direction: [
    "photorealistic cinematic film still",
    "real human anatomy and believable Thai environments",
    "tactile natural materials",
    "layered foreground, midground and background",
    "35mm documentary lens language",
    "controlled filmic contrast and motivated practical lighting",
    "one nuanced human moment",
    "the entire canvas uses photographic rendering",
  ].join(", ") },
  "stick-figure-story-v2": { formatId: "stick-figure-story", direction: [
    "an expressive hand-drawn stick-figure story across the entire canvas",
    "unmistakable simple round heads and line bodies",
    "every person, object, building and background uses bold imperfect marker strokes",
    "warm fibrous paper remains visible throughout the environment",
    "visual cause and effect communicated through poses, props and directional composition",
    "clever editorial simplicity",
    "flat handmade marks and simple paper shapes",
  ].join(", ") },
  "dramatic-comic-v2": { formatId: "dramatic-comic", direction: [
    "dramatic inked comic illustration in a single uninterrupted frame",
    "dynamic foreshortening and an urgent camera angle",
    "thick varied ink contours",
    "angular shapes and controlled halftone shadows",
    "concentrated saturated accent colors",
    "a powerful full-canvas silhouette",
  ].join(", ") },
  "clear-infographic-v2": { formatId: "clear-infographic", direction: [
    "diagrammatic editorial illustration on one continuous vertical canvas",
    "clear top-to-bottom visual hierarchy",
    "simplified recognizable figures and objects",
    "geometric grouping made from circles, arrows and recognizable pictograms",
    "a visual flow or cutaway only when it clarifies the idea",
    "generous negative space and a restrained palette",
    "the idea is expressed entirely through visual relationships",
  ].join(", ") },
  "retro-story-v2": { formatId: "retro-story", direction: [
    "mid-century 1950s to 1970s flat gouache animation-cel scene",
    "subtle screenprinted color texture within the depicted environment",
    "simplified period shapes",
    "slightly misregistered ink edges",
    "limited sepia, mustard, teal and burgundy palette",
    "nostalgic visual language while keeping the depicted subject accurate",
    "the camera crops through the illustrated environment at every canvas edge",
    "large foreground floor and wall color shapes continue beyond the bottom edge and both lower corners",
    "the image is one lived-in scene rather than a displayed print or page",
  ].join(", "), extraNegative: [
    "artist credit", "printer's mark", "edition mark", "handwritten mark", "footer",
    "border", "frame", "mat", "paper margin", "print margin", "blank margin",
    "artwork reproduction", "book page", "magazine page", "poster",
  ] },
};

type V3Recipe = {
  formatId: VisualFormatId;
  /** Rendering-only direction: medium, lens, light, composition and texture.
   * A v3 recipe must never name a subject, prop or location — the Visual Beat
   * owns what is in the frame (ADR 0006). */
  direction: readonly string[];
  /** Used only when the Brand supplies no palette of its own; a brand palette
   * always wins over a format's house colors. */
  fallbackPalette?: string;
  extraNegative?: readonly string[];
};

/** Written as an anti-gibberish-text guardrail and unconditional in v1 and v2,
 * this is art direction: "solid undecorated color" is exactly what a flat
 * illustrated format wants and exactly what `cinematic-realism` must never hear,
 * since its own direction asks for photorealism and tactile natural materials.
 * v3 therefore carries it only on the flat formats; its anti-text job belongs to
 * `TEXT_FREE_NEGATIVE_PROMPT_TERMS`, which already covers every legible mark. */
const FLAT_SURFACE_DIRECTION =
  "every visible surface uses solid undecorated color and simple abstract marks";

const V3_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v3": { formatId: "cinematic-realism", direction: [
    "photorealistic cinematic film still",
    "correct anatomy and physically plausible surroundings wherever they appear",
    "tactile natural materials",
    "layered foreground, midground and background",
    "35mm documentary lens language",
    "controlled filmic contrast and motivated practical lighting",
    "the entire canvas uses photographic rendering",
  ] },
  "stick-figure-story-v3": { formatId: "stick-figure-story", direction: [
    "an expressive hand-drawn stick-figure story across the entire canvas",
    "any figure is drawn with a simple round head and a line body",
    "every drawn element uses bold imperfect marker strokes",
    "warm fibrous paper remains visible throughout",
    "cause and effect communicated through pose, scale and directional composition",
    "clever editorial simplicity",
    "flat handmade marks and simple paper shapes",
    FLAT_SURFACE_DIRECTION,
  ] },
  "dramatic-comic-v3": { formatId: "dramatic-comic", direction: [
    "dramatic inked comic illustration in a single uninterrupted frame",
    "dynamic foreshortening and an urgent camera angle",
    "thick varied ink contours",
    "angular shapes and controlled halftone shadows",
    "concentrated saturated accent colors",
    "a powerful full-canvas silhouette",
    FLAT_SURFACE_DIRECTION,
  ] },
  "clear-infographic-v3": { formatId: "clear-infographic", direction: [
    "diagrammatic editorial illustration on one continuous vertical canvas",
    "clear top-to-bottom visual hierarchy",
    "whatever appears is simplified to its clearest recognizable form",
    "grouping, scale and alignment carry the explanation",
    "generous negative space and a restrained palette",
    "the idea is expressed entirely through visual relationships",
    FLAT_SURFACE_DIRECTION,
  ] },
  "retro-story-v3": { formatId: "retro-story", direction: [
    "mid-century 1950s to 1970s flat gouache animation-cel scene",
    "subtle screenprinted color texture across the whole canvas",
    "simplified period shapes",
    "slightly misregistered ink edges",
    "nostalgic visual language while keeping the depicted subject accurate",
    "the camera crops through the illustrated space at every canvas edge",
    "large foreground color shapes continue beyond the bottom edge and both lower corners",
    "the image is one lived-in scene rather than a displayed print or page",
    FLAT_SURFACE_DIRECTION,
  ], fallbackPalette: "limited sepia, mustard, teal and burgundy palette", extraNegative: [
    "artist credit", "printer's mark", "edition mark", "handwritten mark", "footer",
    "border", "frame", "mat", "paper margin", "print margin", "blank margin",
    "artwork reproduction", "book page", "magazine page", "poster",
  ] },
};

/** Shared text-free provider contract for the v2 and v3 compilers. These
 * entries are load-bearing for the no-legible-marks guarantee: extend only. */
const TEXT_FREE_NEGATIVE_PROMPT_TERMS: readonly string[] = [
  "text", "letters", "words", "numbers", "typography", "caption", "subtitle",
  "headline", "logo", "watermark", "signature", "brand name", "label", "signage",
  "currency symbol", "dollar sign", "baht sign", "artist initials", "corner mark", "date stamp",
  "currency glyph", "monetary icon", "symbol inside circle", "pseudo-text", "gibberish text",
  "framed notice", "wall chart", "written interface", "screen text", "document", "certificate",
  "legible writing", "comic panels", "panel borders", "collage", "split screen",
  "triptych", "storyboard", "contact sheet", "multiple camera views",
];

function artDirectionValue(value: string | null | undefined, limit = 260): string {
  return (value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

const COPY_OR_MARK_INTENT = /(?:\b(?:text|letters?|words?|numbers?|typography|captions?|subtitles?|headlines?|logos?|watermarks?|signatures?|labels?|signage|prompts?|write|spell|brand\s*name)\b|ข้อความ|ตัวอักษร|คำว่า|เขียน|อ่านได้|พาดหัว|หัวข้อ|โลโก้|ลายน้ำ|ชื่อแบรนด์|ป้าย|ตัวเลข)/iu;
const COPY_OR_MARK_INTENT_GLOBAL = /(?:\b(?:text|letters?|words?|numbers?|typography|captions?|subtitles?|headlines?|logos?|watermarks?|signatures?|labels?|signage|prompts?|write|spell|brand\s*name)\b|ข้อความ|ตัวอักษร|คำว่า|เขียน|อ่านได้|พาดหัว|หัวข้อ|โลโก้|ลายน้ำ|ชื่อแบรนด์|ป้าย|ตัวเลข)/giu;

function positiveArtDirectionValue(value: string | null | undefined, limit = 260): string {
  const normalized = artDirectionValue(value, limit);
  if (!COPY_OR_MARK_INTENT.test(normalized)) return normalized;
  return normalized
    .replace(/\btop\s+\d+\b/giu, " ")
    .replace(/\b[A-Z][A-Z0-9_-]{1,}(?:\s+[A-Z][A-Z0-9_-]{1,})*\b/g, " ")
    .replace(COPY_OR_MARK_INTENT_GLOBAL, " ")
    .replace(/\b(?:readable|legible)\b/giu, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function v1PositiveArtDirectionValue(value: string | null | undefined, limit = 260): string {
  return artDirectionValue(value, limit)
    .replace(/\b(?:text|letters?|words?|numbers?|typography|captions?|subtitles?|headlines?|logos?|watermarks?|signatures?|labels?|signage|prompts?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .trim();
}

function v1List(values: readonly string[], limit: number): string {
  return values
    .map((value) => v1PositiveArtDirectionValue(value, 100))
    .filter(Boolean)
    .slice(0, limit)
    .join(", ");
}

const V1_NEGATIVE_PROMPT = [
  "text", "letters", "words", "numbers", "typography", "caption", "subtitle",
  "headline", "logo", "watermark", "signature", "brand name", "label", "signage",
  "legible writing", "comic panels", "panel borders", "collage", "split screen",
  "triptych", "storyboard", "contact sheet", "multiple camera views",
].join(", ");

function compileBrandVisualPromptV1(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment: string;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  if (input.recipeVersion !== `${input.visualFormatId}-v1`) {
    throw new Error("Unsupported Visual Format recipe version");
  }
  const beat = input.visualBeat;
  const scene = [
    v1PositiveArtDirectionValue(beat.subject),
    v1PositiveArtDirectionValue(beat.action),
    `inside ${v1PositiveArtDirectionValue(beat.setting)}`,
    `the mood feels ${v1PositiveArtDirectionValue(beat.emotion)}`,
    `visual attention rests on ${v1PositiveArtDirectionValue(beat.emphasis)}`,
  ].join(", ");
  const brand = input.brandVisualLanguage;
  const brandDirection = brand
    ? [
        `Use the recurring palette ${v1List(brand.palette, 6)}`,
        `The recurring personality feels ${v1PositiveArtDirectionValue(brand.personality)}`,
        brand.peopleAndSetting
          ? `People and places follow ${v1PositiveArtDirectionValue(brand.peopleAndSetting)}`
          : "",
        brand.memorableCues.length
          ? `Repeat the visual cues ${v1List(brand.memorableCues, 6)}`
          : "",
        brand.visualNotes
          ? v1PositiveArtDirectionValue(brand.visualNotes, 360)
          : "",
      ].filter(Boolean).join(". ")
    : "Use the selected format's neutral house palette and balanced composition.";
  const positive = [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    V1_FORMAT_DIRECTION[input.visualFormatId],
    `For a ${v1PositiveArtDirectionValue(input.contentDomain)} story, show ${scene}`,
    `Shape the scene with a ${v1PositiveArtDirectionValue(input.treatment)} feeling`,
    brandDirection,
    "Preserve the selected visual format exactly while adapting the subject, setting, palette and mood",
    "The lower third stays calm and uncluttered with open background texture",
    "Every visible surface uses solid undecorated color and simple abstract marks",
  ].join(". ") + ".";
  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: V1_NEGATIVE_PROMPT,
  };
}

/** Visual Notes are creator intent, not provider syntax. Convert only
 * recognized material/composition qualities into a bounded compiler-owned
 * vocabulary; unknown directives and any request for copy/logos are omitted.
 * Frozen for v2 pins — the audited v3 allowlist lives in
 * `BRAND_VISUAL_NOTE_RULES`. */
function structuredVisualNotes(value: string | null | undefined): string {
  const normalized = artDirectionValue(value, 800);
  if (!normalized) return "";
  const rules: string[] = [];
  const add = (pattern: RegExp, rule: string) => {
    if (pattern.test(normalized) && !rules.includes(rule)) rules.push(rule);
  };
  add(/(?:thick|heavy|bold|หนา|หนัก)/iu, "thick confident strokes");
  add(/(?:rough|raw|imperfect|uneven|ดิบ|หยาบ|ไม่เรียบ|ไม่สมบูรณ์)/iu, "imperfect handmade edges");
  add(/(?:marker|felt[ -]?tip|ปากกา|เมจิก)/iu, "marker-like line texture");
  add(/(?:paper|fibrous|กระดาษ|เยื่อ)/iu, "tactile paper texture");
  add(/(?:cut[ -]?out|torn|collage material|ตัดปะ|ฉีก)/iu, "simple cut-paper shapes");
  add(/(?:diagonal|tilt|slant|เอียง|เฉียง)/iu, "a slightly diagonal composition");
  add(/(?:minimal|uncluttered|negative space|open space|เรียบ|โล่ง|พื้นที่ว่าง)/iu, "restrained uncluttered spacing");
  add(/(?:dynamic|energetic|momentum|กระฉับกระเฉง|มีพลัง|เคลื่อนไหว)/iu, "dynamic visual rhythm");
  add(/(?:soft|gentle|calm|นุ่ม|สงบ)/iu, "soft controlled transitions");
  add(/(?:contrast|high[ -]?contrast|คอนทราสต์|ตัดกัน)/iu, "clear value contrast");
  return rules.slice(0, 6).join(", ");
}

function list(values: readonly string[], limit: number): string {
  return values
    .map((value) => positiveArtDirectionValue(value, 100))
    .filter(Boolean)
    .slice(0, limit)
    .join(", ");
}

/** Frozen v2 compiler. Revisions pinned to a `-v2` recipe must keep compiling
 * to the exact string they were published with (ADR 0005), so nothing in this
 * function — or the helpers it calls — may change. */
function compileBrandVisualPromptV2(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment: string;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V2_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = input.visualBeat;
  const safeSubject = positiveArtDirectionValue(beat.subject);
  const safeAction = positiveArtDirectionValue(beat.action);
  const safeSetting = positiveArtDirectionValue(beat.setting);
  const safeEmotion = positiveArtDirectionValue(beat.emotion);
  const safeEmphasis = positiveArtDirectionValue(beat.emphasis);
  const scene = [
    safeSubject,
    safeAction,
    safeSetting ? `inside ${safeSetting}` : "",
    safeEmotion ? `the mood feels ${safeEmotion}` : "",
    safeEmphasis ? `visual attention rests on ${safeEmphasis}` : "",
  ].filter(Boolean).join(", ") || "one coherent subject acting in a clear setting";
  const brand = input.brandVisualLanguage;
  const safePalette = brand ? list(brand.palette, 6) : "";
  const safePersonality = brand ? positiveArtDirectionValue(brand.personality) : "";
  const safePeopleAndSetting = brand ? positiveArtDirectionValue(brand.peopleAndSetting) : "";
  const safeMemorableCues = brand ? list(brand.memorableCues, 6) : "";
  const safeVisualNotes = brand ? structuredVisualNotes(brand.visualNotes) : "";
  const brandDirection = brand
    ? [
        safePalette ? `Use the recurring palette ${safePalette}` : "",
        safePersonality ? `The recurring personality feels ${safePersonality}` : "",
        safePeopleAndSetting ? `People and places follow ${safePeopleAndSetting}` : "",
        safeMemorableCues ? `Repeat the visual cues ${safeMemorableCues}` : "",
        safeVisualNotes,
      ].filter(Boolean).join(". ")
    : "Use the selected format's neutral house palette and balanced composition.";

  const safeDomain = positiveArtDirectionValue(input.contentDomain) || "a visually led subject";
  const safeTreatment = positiveArtDirectionValue(input.treatment) || "clear and coherent";

  const positive = [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    recipe.direction,
    `For a story about ${safeDomain}, show ${scene}`,
    `Shape the scene with a ${safeTreatment} feeling`,
    brandDirection,
    "Preserve the selected visual format exactly while adapting the subject, setting, palette and mood",
    "The lower third stays calm and uncluttered with open background texture",
    "Background walls, device screens and framed areas use plain empty solid color fields",
    "Every circular motif is either an empty unmarked ring or a solid unmarked disc",
    "Every visible surface uses solid undecorated color and simple abstract marks",
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...TEXT_FREE_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
  };
}

/** Compact named-color table for the v3 palette mapper. Z-Image has no hex
 * grounding: a raw code is rendered as a colored object in the scene instead of
 * a grade, so every palette entry becomes plain color words first. */
const NAMED_COLORS: ReadonlyArray<{ name: string; rgb: readonly [number, number, number] }> = [
  { name: "black", rgb: [0, 0, 0] },
  { name: "deep charcoal", rgb: [38, 38, 42] },
  { name: "slate grey", rgb: [112, 128, 144] },
  { name: "soft grey", rgb: [176, 176, 176] },
  { name: "warm off-white", rgb: [245, 241, 232] },
  { name: "white", rgb: [255, 255, 255] },
  { name: "cream", rgb: [250, 240, 205] },
  { name: "sand", rgb: [226, 199, 152] },
  { name: "tan brown", rgb: [176, 132, 86] },
  { name: "deep brown", rgb: [92, 58, 36] },
  { name: "terracotta", rgb: [200, 98, 66] },
  { name: "burgundy", rgb: [124, 28, 52] },
  { name: "crimson red", rgb: [214, 40, 52] },
  { name: "coral", rgb: [250, 128, 96] },
  { name: "warm orange", rgb: [240, 138, 40] },
  { name: "amber", rgb: [250, 180, 40] },
  { name: "mustard", rgb: [214, 170, 54] },
  { name: "soft gold", rgb: [206, 168, 64] },
  { name: "olive green", rgb: [128, 140, 58] },
  { name: "fresh green", rgb: [54, 158, 88] },
  { name: "forest green", rgb: [28, 88, 52] },
  { name: "teal", rgb: [28, 132, 132] },
  { name: "cool sky blue", rgb: [86, 180, 233] },
  { name: "deep blue", rgb: [36, 78, 182] },
  { name: "navy", rgb: [22, 38, 84] },
  { name: "violet", rgb: [138, 92, 244] },
  { name: "magenta pink", rgb: [206, 62, 150] },
];

/** Hue words that already carry color meaning on their own. A palette entry
 * must contain at least one of these to describe a color at all. */
const COLOR_TONE_WORDS: ReadonlySet<string> = new Set([
  "black", "charcoal", "grey", "gray", "silver", "white", "off-white", "ivory", "cream",
  "beige", "sand", "tan", "brown", "bronze", "copper", "terracotta", "burgundy", "maroon",
  "crimson", "red", "coral", "orange", "amber", "mustard", "yellow", "gold", "golden",
  "olive", "lime", "green", "teal", "turquoise", "cyan", "aqua", "sky", "blue", "navy",
  "indigo", "violet", "purple", "magenta", "pink", "sepia", "monochrome",
]);

/** Words that may qualify a hue without naming anything that can be drawn as an
 * object. Together with `COLOR_TONE_WORDS` this is the complete vocabulary a
 * palette entry may contribute — anything else and the entry is dropped. */
const COLOR_QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  "deep", "dark", "light", "pale", "muted", "bright", "vivid", "warm", "cool", "soft",
  "rich", "dusty", "faded", "washed", "matte", "saturated", "desaturated", "neutral",
  "pastel", "clean", "high", "low", "mid", "off", "contrast", "high-contrast",
  "low-contrast", "carbon", "paper", "ink", "bone", "jet", "midnight", "forest",
  // Words that only ever appear inside a `NAMED_COLORS` phrase, so the
  // vocabulary stays closed over the hex mapper's own output.
  "slate", "fresh", "and",
]);

/** A hex code can sit anywhere inside an entry (`brand#38BDF8`), not only as a
 * leading whitespace-delimited token, so it is matched globally. */
const HEX_COLOR_TOKEN = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

/** The same code in every other encoding a creator can type. A literal `#` is
 * not the only way to write one: `0x38BDF8`, `rgb(56, 189, 248)`, `hsl(...)`, a
 * fullwidth `＃` (U+FF03) and a percent-encoded `%23` all reach Z-Image, which
 * paints any of them as a colored object rather than applying a grade. Matched
 * without word boundaries on the left for the same reason as `HEX_COLOR_TOKEN`:
 * the code can be glued to a word. */
const COLOR_CODE_TOKEN =
  /(?:%23|＃|0x)(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\s*\([^()]{0,64}\)/gi;

/** Cheap pre-test for the sanitizer: true when a value could carry a code in any
 * encoding. Values without one stay byte-identical to the shared cleaner. */
const COLOR_CODE_MARKER = /[#＃]|%23|0x[0-9a-fA-F]{3}|(?:rgba?|hsla?)\s*\(/i;

function hexRgb(token: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(token);
  if (!match) return null;
  const digits = match[1].length === 3
    ? match[1].split("").map((digit) => `${digit}${digit}`).join("")
    : match[1];
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

function nearestColorName(token: string): string {
  const rgb = hexRgb(token);
  if (!rgb) return "";
  let best = "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of NAMED_COLORS) {
    const distance = (rgb[0] - candidate.rgb[0]) ** 2
      + (rgb[1] - candidate.rgb[1]) ** 2
      + (rgb[2] - candidate.rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate.name;
    }
  }
  return best;
}

/** One palette entry as color words, resolved against a bounded vocabulary.
 *
 * A palette field is free text the creator controls, so it is a scene-injection
 * surface unless every word it can emit is compiler-owned: `["a large blue
 * circular motif mounted on the office wall"]` must contribute a color or
 * nothing at all, never a sentence. An entry therefore resolves only two ways —
 * a hex code anywhere inside it becomes its nearest named color, or its words
 * are all color vocabulary and pass through. Anything else contributes nothing
 * and the entry is dropped (ADR 0006). */
function paletteColorWords(entry: string): string {
  const normalized = positiveArtDirectionValue(entry, 100);
  if (!normalized) return "";

  const named: string[] = [];
  for (const code of normalized.match(HEX_COLOR_TOKEN) ?? []) {
    const name = nearestColorName(code);
    if (name) named.push(name);
  }

  const tokens = normalized
    .replace(HEX_COLOR_TOKEN, " ")
    .toLowerCase()
    .split(/\s+/)
    // Only punctuation is trimmed. A token that survives as non-vocabulary —
    // including a Thai or otherwise non-Latin word — must stay in the list so
    // it invalidates the entry instead of being silently discarded.
    .map((token) => token.replace(/^[,.;:!?()"'`]+/, "").replace(/[,.;:!?()"'`]+$/, ""))
    .filter(Boolean);
  const bounded = tokens.length > 0
    && tokens.length <= 4
    && tokens.some((token) => COLOR_TONE_WORDS.has(token))
    && tokens.every((token) => COLOR_TONE_WORDS.has(token) || COLOR_QUALIFIER_WORDS.has(token));

  if (bounded) {
    // `sky` is the only tone word that names a place before it names a color,
    // so a bare entry compiles to "The overall color grade favors sky." — bad
    // grammar and, worse, an invitation to paint a sky into the frame. Complete
    // it to the color it means; every other tone word stands alone.
    if (tokens[tokens.length - 1] === "sky") tokens.push("blue");
    return tokens.join(" ");
  }
  return named[0] ?? "";
}

/** v3-only sanitizing layer over the shared art-direction cleaner. A `-v2` pin
 * must keep compiling byte-identically (ADR 0005), so hex stripping is layered
 * on top instead of edited into `positiveArtDirectionValue`. Creator-typed
 * `treatment` and Gemini-extracted Visual Beat fields can carry a raw code just
 * like a palette entry, and Z-Image paints one as a colored object. */
function v3PositiveArtDirectionValue(value: string | null | undefined, limit = 260): string {
  const sanitized = positiveArtDirectionValue(value, limit);
  if (!COLOR_CODE_MARKER.test(sanitized)) return sanitized;
  return sanitized
    // Longest first: `%2338BDF8` must be removed whole, not reduced to `38BDF8`.
    .replace(COLOR_CODE_TOKEN, " ")
    .replace(HEX_COLOR_TOKEN, " ")
    .replace(/%23/gi, " ")
    .replace(/[#＃]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function joinWithAnd(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The only dimensions a Brand may control in v3. Everything the compiler emits
 * for a Brand is tagged with one of these, which is what keeps brand input at
 * the "how it is rendered" layer instead of the "what is in the frame" layer. */
type BrandRenderingDimension = "contrast" | "lighting" | "lens" | "composition" | "texture";

type BrandRenderingRule = {
  pattern: RegExp;
  dimension: BrandRenderingDimension;
  /** Personality and Visual Notes overlap by design (both can say "soft"), so
   * one concept may only be voiced once per dimension. */
  concept: string;
  clause: string;
};

/** Brand personality is free text, so it is matched against a bounded
 * vocabulary rather than interpolated: a personality that names a place or a
 * prop contributes nothing instead of overriding the Visual Beat. */
const BRAND_PERSONALITY_RULES: readonly BrandRenderingRule[] = [
  { pattern: /(?:bold|strong|striking|กล้า|หนักแน่น)/iu, dimension: "contrast", concept: "assertive-exposure", clause: "decisive high-contrast exposure" },
  { pattern: /(?:professional|trustworthy|reliable|มืออาชีพ|น่าเชื่อถือ|จริงจัง)/iu, dimension: "contrast", concept: "neutral-exposure", clause: "balanced neutral exposure" },
  { pattern: /(?:dramatic|intense|moody|ดราม่า|เข้มข้น)/iu, dimension: "lighting", concept: "hard-key", clause: "a strong key light with deep shadows" },
  { pattern: /(?:premium|luxury|elegant|refined|หรู|พรีเมียม|ประณีต)/iu, dimension: "lighting", concept: "low-key", clause: "controlled low-key lighting with clean falloff" },
  { pattern: /(?:warm|friendly|อบอุ่น|เป็นกันเอง)/iu, dimension: "lighting", concept: "warm-light", clause: "warm motivated lighting" },
  { pattern: /(?:cool|เย็น)/iu, dimension: "lighting", concept: "cool-light", clause: "cool restrained lighting" },
  { pattern: /(?:calm|quiet|gentle|สงบ|นุ่มนวล)/iu, dimension: "lighting", concept: "soft-light", clause: "soft even lighting" },
  { pattern: /(?:cinematic|filmic|ภาพยนตร์|หนัง)/iu, dimension: "lens", concept: "shallow-depth", clause: "a shallow cinematic depth of field" },
  { pattern: /(?:direct|straightforward|ตรงไปตรงมา|ชัดเจน)/iu, dimension: "lens", concept: "eye-level", clause: "a straightforward eye-level perspective" },
  { pattern: /(?:energetic|dynamic|playful|มีพลัง|กระฉับกระเฉง|สนุก)/iu, dimension: "composition", concept: "dynamic-framing", clause: "energetic off-centre framing" },
  { pattern: /(?:minimal|clean|simple|มินิมอล|สะอาด|เรียบง่าย)/iu, dimension: "composition", concept: "uncluttered", clause: "clean uncluttered framing" },
  { pattern: /(?:raw|gritty|rough|ดิบ|หยาบ)/iu, dimension: "texture", concept: "rough-surface", clause: "raw unpolished surface texture" },
  { pattern: /(?:handmade|handcrafted|craft|ทำมือ|งานฝีมือ)/iu, dimension: "texture", concept: "handmade", clause: "handmade material texture" },
];

/** Audited v3 allowlist for Visual Notes. The v2 rule "simple cut-paper shapes"
 * is deliberately absent: it introduced objects into the frame, which is scene
 * content and therefore the Visual Beat's job (ADR 0006). */
const BRAND_VISUAL_NOTE_RULES: readonly BrandRenderingRule[] = [
  { pattern: /(?:thick|heavy|bold|หนา|หนัก)/iu, dimension: "texture", concept: "stroke-weight", clause: "thick confident strokes" },
  { pattern: /(?:rough|raw|imperfect|uneven|ดิบ|หยาบ|ไม่เรียบ|ไม่สมบูรณ์)/iu, dimension: "texture", concept: "rough-surface", clause: "imperfect handmade edges" },
  { pattern: /(?:marker|felt[ -]?tip|ปากกา|เมจิก)/iu, dimension: "texture", concept: "marker-line", clause: "marker-like line texture" },
  { pattern: /(?:paper|fibrous|กระดาษ|เยื่อ)/iu, dimension: "texture", concept: "paper-grain", clause: "tactile paper texture" },
  { pattern: /(?:diagonal|tilt|slant|เอียง|เฉียง)/iu, dimension: "composition", concept: "diagonal", clause: "a slightly diagonal composition" },
  { pattern: /(?:minimal|uncluttered|negative space|open space|เรียบ|โล่ง|พื้นที่ว่าง)/iu, dimension: "composition", concept: "uncluttered", clause: "restrained uncluttered spacing" },
  { pattern: /(?:dynamic|energetic|momentum|กระฉับกระเฉง|มีพลัง|เคลื่อนไหว)/iu, dimension: "composition", concept: "dynamic-framing", clause: "dynamic visual rhythm" },
  { pattern: /(?:soft|gentle|calm|นุ่ม|สงบ)/iu, dimension: "lighting", concept: "soft-light", clause: "soft controlled transitions" },
  { pattern: /(?:contrast|high[ -]?contrast|คอนทราสต์|ตัดกัน)/iu, dimension: "contrast", concept: "value-contrast", clause: "clear value contrast" },
];

function matchedRenderingClauses(
  rules: readonly BrandRenderingRule[],
  value: string | null | undefined,
  limit: number,
): BrandRenderingRule[] {
  const normalized = artDirectionValue(value, 800);
  if (!normalized) return [];
  return rules.filter((rule) => rule.pattern.test(normalized)).slice(0, limit);
}

const LIGHT_DIMENSIONS: ReadonlySet<BrandRenderingDimension> = new Set(["contrast", "lighting", "lens"]);

/** One clause per dimension+concept, so a word that appears in both Personality
 * and Visual Notes cannot emit two near-duplicate clauses. First match wins. */
function uniqueConcepts(rules: readonly BrandRenderingRule[]): BrandRenderingRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.dimension}:${rule.concept}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The complete v3 Brand fragment. It is assembled from three fixed clause
 * builders — color grade, rendering character, surface and framing — so a Brand
 * can only ever change how the Visual Beat is rendered, never what it shows.
 * Every word it emits is compiler-owned: the rendering clauses come from the
 * rule tables above, and a palette entry contributes only vocabulary that
 * `paletteColorWords` recognizes as a color, never free text. */
function brandRenderingDirectionV3(brand: BrandVisualLanguage | null | undefined): {
  direction: string;
  hasPalette: boolean;
} {
  if (!brand) {
    return {
      direction: "Use the selected format's neutral house palette and balanced composition",
      hasPalette: false,
    };
  }
  const colors = uniqueValues(brand.palette.map(paletteColorWords).filter(Boolean)).slice(0, 6);
  const matched = uniqueConcepts([
    ...matchedRenderingClauses(BRAND_PERSONALITY_RULES, brand.personality, 4),
    ...matchedRenderingClauses(BRAND_VISUAL_NOTE_RULES, brand.visualNotes, 6),
  ]);
  const character = uniqueValues(
    matched.filter((rule) => LIGHT_DIMENSIONS.has(rule.dimension)).map((rule) => rule.clause),
  );
  const surface = uniqueValues(
    matched.filter((rule) => !LIGHT_DIMENSIONS.has(rule.dimension)).map((rule) => rule.clause),
  );
  const direction = [
    colors.length ? `The overall color grade favors ${joinWithAnd(colors)}` : "",
    character.length ? `The rendering character is ${joinWithAnd(character)}` : "",
    surface.length ? `Surfaces and framing carry ${joinWithAnd(surface)}` : "",
  ].filter(Boolean).join(". ");
  return { direction, hasPalette: colors.length > 0 };
}

/** Current compiler. The Visual Beat owns the scene; the Brand owns only color
 * grade, contrast, lighting, lens, composition and texture. `memorableCues` and
 * `peopleAndSetting` are intentionally ignored here — they stay on the payload
 * so pinned v1/v2 revisions keep deserializing. */
function compileBrandVisualPromptV3(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment: string;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V3_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = input.visualBeat;
  const safeSubject = v3PositiveArtDirectionValue(beat.subject);
  const safeAction = v3PositiveArtDirectionValue(beat.action);
  const safeSetting = v3PositiveArtDirectionValue(beat.setting);
  const safeEmotion = v3PositiveArtDirectionValue(beat.emotion);
  const safeEmphasis = v3PositiveArtDirectionValue(beat.emphasis);
  const scene = [
    safeSubject,
    safeAction,
    // "inside" fights an exterior beat — a wide storm establishing frame is not
    // inside its coastal town — so v3 uses a connector that reads for both.
    safeSetting ? `set in ${safeSetting}` : "",
    safeEmotion ? `the mood feels ${safeEmotion}` : "",
    safeEmphasis ? `visual attention rests on ${safeEmphasis}` : "",
  ].filter(Boolean).join(", ") || "one coherent subject acting in a clear setting";

  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");

  const safeDomain = v3PositiveArtDirectionValue(input.contentDomain) || "a visually led subject";
  const safeTreatment = v3PositiveArtDirectionValue(input.treatment) || "clear and coherent";

  const positive = [
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    formatDirection,
    `For a story about ${safeDomain}, show ${scene}`,
    `Shape the scene with a ${safeTreatment} feeling`,
    brand.direction,
    "Preserve the selected visual format exactly while keeping the described subject, action and setting",
    // Protects the burned-in Thai subtitle safe area, which every format shares.
    // The flat-surface guardrail that used to sit here is format-specific art
    // direction and now lives in `FLAT_SURFACE_DIRECTION`.
    "The lower third stays calm and uncluttered with open background texture",
  ].filter(Boolean).join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...TEXT_FREE_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
  };
}

/**
 * Compile scene meaning and creator intent into one provider-neutral image
 * instruction. Format selection is an input, never a model decision. The recipe
 * version pinned on a revision selects its frozen compiler; unpinned callers
 * get the current one.
 */
export function compileBrandVisualPrompt(input: {
  visualFormatId: VisualFormatId;
  recipeVersion?: string;
  contentDomain: string;
  treatment: string;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === input.visualFormatId);
  if (!format) throw new Error("Unsupported Visual Format");
  const recipeVersion = input.recipeVersion ?? format.recipeVersion;
  if (recipeVersion.endsWith("-v1")) {
    return compileBrandVisualPromptV1({ ...input, recipeVersion });
  }
  if (recipeVersion.endsWith("-v2")) {
    return compileBrandVisualPromptV2({ ...input, recipeVersion });
  }
  return compileBrandVisualPromptV3({ ...input, recipeVersion });
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
    "rough sky-blue empty unmarked marker rings placed around one existing object",
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
