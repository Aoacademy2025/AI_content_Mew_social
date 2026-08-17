import { latinLetteringOnly } from "@/lib/image-prompt-script";
import {
  treatmentPromptDirection,
  type TreatmentPin,
} from "@/lib/brand-treatment-catalog";

/** Provider-neutral visual identity vocabulary for Brand Visual System V1. */
export const VISUAL_FORMAT_IDS = [
  "cinematic-realism",
  "simple-editorial-story",
  "dramatic-comic",
  "clear-infographic",
  "retro-story",
] as const;

export const LEGACY_VISUAL_FORMAT_IDS = ["stick-figure-story"] as const;
export const SUPPORTED_VISUAL_FORMAT_IDS = [
  ...VISUAL_FORMAT_IDS,
  ...LEGACY_VISUAL_FORMAT_IDS,
] as const;

export type ActiveVisualFormatId = (typeof VISUAL_FORMAT_IDS)[number];
export type VisualFormatId = (typeof SUPPORTED_VISUAL_FORMAT_IDS)[number];

export function isActiveVisualFormatId(value: string): value is ActiveVisualFormatId {
  return (VISUAL_FORMAT_IDS as readonly string[]).includes(value);
}

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
    recipeVersion: "cinematic-realism-v9",
    description: "ภาพเหมือนฉากหนัง แสงมีมิติและวัสดุสมจริง",
  },
  {
    id: "simple-editorial-story",
    label: "ภาพวาดเล่าเรื่องเรียบง่าย",
    recipeVersion: "simple-editorial-story-v11",
    description: "ภาพวาดสีเรียบเต็มฉาก เล่าเหตุและผลผ่านคน สิ่งของ และการกระทำ",
  },
  {
    id: "dramatic-comic",
    label: "คอมิกเข้มข้น",
    recipeVersion: "dramatic-comic-v9",
    description: "คอมิกเฟรมเดียว เส้นหนัก มุมกล้องและอารมณ์เข้ม",
  },
  {
    id: "clear-infographic",
    label: "อินโฟกราฟิกเข้าใจง่าย",
    recipeVersion: "clear-infographic-v9",
    description: "อธิบายด้วยรูปทรง ไอคอน และลำดับภาพโดยไม่ใช้ข้อความ",
  },
  {
    id: "retro-story",
    label: "เล่าเรื่องย้อนยุค",
    recipeVersion: "retro-story-v9",
    description: "ภาพพิมพ์บรรณาธิการกลิ่นอายยุคเก่า สีจำกัดและพื้นผิวกระดาษ",
  },
] as const;

/** Historical formats remain executable only for immutable Brand/Profile and
 * project pins. They are deliberately absent from creator-facing catalogs and
 * all new-selection schemas. */
export const LEGACY_VISUAL_FORMATS: readonly VisualFormat[] = [
  {
    id: "stick-figure-story",
    label: "ก้างปลาเล่าเรื่อง",
    recipeVersion: "stick-figure-story-v6",
    description: "ลายเส้นคนก้างปลา เล่าเหตุและผลด้วยท่าทางชัดเจน",
  },
] as const;

export const SUPPORTED_VISUAL_FORMATS: readonly VisualFormat[] = [
  ...VISUAL_FORMATS,
  ...LEGACY_VISUAL_FORMATS,
] as const;

export function visualFormatThaiLabel(id: VisualFormatId): string {
  const format = SUPPORTED_VISUAL_FORMATS.find((candidate) => candidate.id === id);
  if (!format) throw new Error("Unsupported Visual Format");
  return format.label;
}

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

export type HardSceneFacts = {
  entityTypes: string[];
  ages: string[];
  genders: string[];
  actions: string[];
  locationTypes: string[];
  timeOfDay: string | null;
  historicalPeriod: string | null;
  count: number | null;
  essentialObjects: string[];
};

export type SceneSafetyBoundary = "none" | "medical-illustration" | "real-person-context-only";

export type VisualBeat = {
  phase: VisualBeatPhase;
  subject: string;
  action: string;
  setting: string;
  emotion: string;
  emphasis: string;
  hardSceneFacts?: HardSceneFacts;
  entityRenderingDescriptions?: string[];
  sceneIntensity?: string;
  safetyBoundary?: SceneSafetyBoundary;
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
  treatmentPin?: TreatmentPin;
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
    treatment: input.treatmentPin
      ? {
          presetId: input.treatmentPin.presetId,
          version: input.treatmentPin.version,
        }
      : input.treatment.trim(),
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
  treatmentPin?: TreatmentPin;
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
const V1_FORMAT_DIRECTION: Readonly<Partial<Record<VisualFormatId, string>>> = {
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
 * v3 therefore carries it only on the flat formats.
 *
 * Its anti-text job is NOT picked up by `V3_NEGATIVE_PROMPT_TERMS`: the only
 * model this system renders on is positive-only (see that list's own note), so
 * no negative term reaches it. Removing this line from the photoreal path was
 * still correct — it caused the storytelling bug ADR 0006 fixed — but it left no
 * enforcement behind it. What keeps readable marks out of a frame is the Visual
 * Beat never making a surface that must be read the focal subject
 * (`content-preflight.server.ts`). */
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

/** V4 keeps V3's rendering grammar byte-for-byte and changes only the prompt
 * layer ordering required by ADR 0014. V3 remains frozen for pinned revisions. */
const V4_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v4": V3_FORMAT_RECIPE_DIRECTION["cinematic-realism-v3"],
  "stick-figure-story-v4": V3_FORMAT_RECIPE_DIRECTION["stick-figure-story-v3"],
  "dramatic-comic-v4": V3_FORMAT_RECIPE_DIRECTION["dramatic-comic-v3"],
  "clear-infographic-v4": V3_FORMAT_RECIPE_DIRECTION["clear-infographic-v3"],
  "retro-story-v4": V3_FORMAT_RECIPE_DIRECTION["retro-story-v3"],
};

/** Qualification benchmark fixes publish as v5 instead of mutating the frozen
 * v4 recipes. Public Z-Image showed that short medium names alone were not
 * enough to keep stick figures visually uniform or invented lettering out of
 * flat explanatory frames. */
const V5_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v5": V4_FORMAT_RECIPE_DIRECTION["cinematic-realism-v4"],
  "stick-figure-story-v5": { formatId: "stick-figure-story", direction: [
    "the entire frame uses only hand-drawn stick-figure marker rendering",
    "every person is a bare round head with a single-line torso and single-line limbs",
    "hands, faces and bodies remain simple marker symbols rather than realistic anatomy",
    "every prop, building, surface and background is drawn with bold imperfect marker strokes",
    "warm fibrous paper remains visible throughout",
    "cause and effect is communicated through pose, scale and directional composition",
    "clever editorial simplicity with flat handmade marks and simple paper shapes",
    "no photographic or realistically rendered elements appear anywhere in the frame",
    "all communication uses unlettered marker shapes unless a hard scene fact explicitly requires writing",
    FLAT_SURFACE_DIRECTION,
  ] },
  "dramatic-comic-v5": { formatId: "dramatic-comic", direction: [
    ...V3_FORMAT_RECIPE_DIRECTION["dramatic-comic-v3"].direction,
    "the single scene omits invented title blocks, captions and labels unless a hard scene fact explicitly requires writing",
  ] },
  "clear-infographic-v5": { formatId: "clear-infographic", direction: [
    "diagrammatic editorial illustration on one continuous vertical canvas",
    "clear top-to-bottom visual hierarchy",
    "whatever appears is simplified to its clearest recognizable form",
    "grouping, scale and alignment carry the explanation",
    "generous negative space and a restrained palette",
    "the idea is expressed entirely through unlettered pictograms and visual relationships unless a hard scene fact explicitly requires writing",
    FLAT_SURFACE_DIRECTION,
  ] },
  "retro-story-v5": V4_FORMAT_RECIPE_DIRECTION["retro-story-v4"],
};

/** V6 is the first recipe written from public-endpoint qualification output.
 * It uses concise affirmative descriptions: naming photography in a sentence
 * that tried to exclude it caused the positive-only model to render photos. */
const V6_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v6": V5_FORMAT_RECIPE_DIRECTION["cinematic-realism-v5"],
  /** Approved after the public-endpoint v5/v6 smoke reviews. This is a new
   * active format rather than a mutation of the frozen Stick Figure recipes. */
  "simple-editorial-story-v7": { formatId: "simple-editorial-story", direction: [
    "full-frame flat editorial story illustration",
    "one continuous illustrated narrative scene fills the canvas",
    "people, hands and objects use filled simplified shapes with clean drawn contours",
    "faces, clothing and props use a small number of expressive readable details",
    "foreground, subject and background share the same matte flat-color rendering",
    "depth is shown through overlap, scale and broad value shapes",
    "scene action and object relationships carry the meaning",
    "background surfaces use calm unlettered shapes",
    "restrained paper grain unifies the complete frame",
    FLAT_SURFACE_DIRECTION,
  ] },
  "stick-figure-story-v6": { formatId: "stick-figure-story", direction: [
    "full-frame stick-figure marker doodle on warm fibrous paper",
    "every story entity appears as a circular head joined to one straight-line torso and single-line limbs",
    "age, role and emotion are conveyed through scale, posture and simple props",
    "hands are short line ends that clearly perform the required action",
    "all objects, buildings, surfaces and backgrounds are flat marker outlines and simple paper shapes",
    "foreground, subject and background share the same sparse black-marker abstraction",
    "cause and effect is communicated through pose, scale and directional composition",
    "every informational mark is a blank doodle shape",
    FLAT_SURFACE_DIRECTION,
  ] },
  "dramatic-comic-v6": { formatId: "dramatic-comic", direction: [
    ...V3_FORMAT_RECIPE_DIRECTION["dramatic-comic-v3"].direction,
    "the top of the frame continues the illustrated environment, light, architecture and ink texture",
    "scene action and object relationships carry the full meaning",
  ] },
  "clear-infographic-v6": { formatId: "clear-infographic", direction: [
    "full-frame flat pictogram composition on one continuous vertical canvas",
    "clear top-to-bottom visual hierarchy",
    "every subject and object is simplified to a recognizable blank icon",
    "blank geometric pictograms, object silhouettes, arrows, color and spacing carry all information",
    "large calm background color fields surround the focal icons",
    "grouping, scale and alignment carry the explanation",
    "exact quantities remain visually distinct",
    "generous negative space and a restrained palette",
    FLAT_SURFACE_DIRECTION,
  ] },
  "retro-story-v6": V5_FORMAT_RECIPE_DIRECTION["retro-story-v5"],
};

/** V8 keeps the accepted editorial medium byte-for-byte while hardening the
 * semantic compiler. The paid v7 recipe remains frozen and reproducible. */
const V8_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v7": V6_FORMAT_RECIPE_DIRECTION["cinematic-realism-v6"],
  "simple-editorial-story-v8": V6_FORMAT_RECIPE_DIRECTION["simple-editorial-story-v7"],
  "dramatic-comic-v7": V6_FORMAT_RECIPE_DIRECTION["dramatic-comic-v6"],
  "clear-infographic-v7": V6_FORMAT_RECIPE_DIRECTION["clear-infographic-v6"],
  "retro-story-v7": V6_FORMAT_RECIPE_DIRECTION["retro-story-v6"],
};

/** V9 removes positive-only failure-state triggers and gives infographic
 * scenes an object-only composition that does not create caption positions.
 * V7/v8 recipes remain frozen for existing project pins and paid evidence. */
const V9_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v8": V8_FORMAT_RECIPE_DIRECTION["cinematic-realism-v7"],
  "simple-editorial-story-v9": V8_FORMAT_RECIPE_DIRECTION["simple-editorial-story-v8"],
  "dramatic-comic-v8": V8_FORMAT_RECIPE_DIRECTION["dramatic-comic-v7"],
  "clear-infographic-v8": { formatId: "clear-infographic", direction: [
    "full-frame flat pictogram composition on one continuous vertical canvas",
    "only the essential subject and objects form one compact cluster in the central visual area",
    "each pictogram stands alone as one solid recognizable object shape with open space on every side",
    "wide uninterrupted background color surrounds every pictogram",
    "physical placement, object scale and restrained color show the relationships",
    "the upper third remains one uninterrupted calm background field",
    "exact quantities remain visually distinct",
    "generous negative space and a restrained palette",
    FLAT_SURFACE_DIRECTION,
  ] },
  "retro-story-v8": V8_FORMAT_RECIPE_DIRECTION["retro-story-v7"],
};

const V10_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "simple-editorial-story-v10": V9_FORMAT_RECIPE_DIRECTION["simple-editorial-story-v9"],
};

/** Additive recipe pins for the relational Hard Scene Fact revision. The
 * rendering media remain unchanged; the provider prompt compiler is versioned
 * because its composition and enforcement contract changes. */
const V11_FORMAT_RECIPE_DIRECTION: Readonly<Record<string, V3Recipe>> = {
  "cinematic-realism-v9": V9_FORMAT_RECIPE_DIRECTION["cinematic-realism-v8"],
  "simple-editorial-story-v11": V10_FORMAT_RECIPE_DIRECTION["simple-editorial-story-v10"],
  "dramatic-comic-v9": V9_FORMAT_RECIPE_DIRECTION["dramatic-comic-v8"],
  "clear-infographic-v9": V9_FORMAT_RECIPE_DIRECTION["clear-infographic-v8"],
  "retro-story-v9": V9_FORMAT_RECIPE_DIRECTION["retro-story-v8"],
};

/** Format-specific translation for the replacement style. The public
 * positive-only model treated words such as documentary and tactile product
 * advertising as rendering-medium instructions. Pin both preset identity and
 * version here so a later Treatment recipe cannot change an existing visual
 * result silently. */
const SIMPLE_EDITORIAL_TREATMENT_DIRECTION_V7: Readonly<Record<string, string>> = {
  "expert-clarity@v1.0.0": "calm authority and ordered visual hierarchy",
  "practical-documentary@v1.0.0": "grounded everyday action and direct visual sequence",
  "thai-human-drama@v1.0.0": "intimate human emotion and warm relational spacing",
  "modern-business-technology@v1.0.0": "confident momentum and clean organized composition",
  "premium-product-lifestyle@v1.0.0": "refined restraint, selective highlights and generous negative space",
  "investigative-news-crime@v1.0.0": "sober tension and evidence-led visual focus",
  "thai-history-period-storytelling@v1.0.0": "dignified period atmosphere and clearly staged historical detail",
  "thai-supernatural-horror@v1.0.0": "nocturnal dread and escalating shadow shapes",
};

function simpleEditorialTreatmentDirectionV7(pin: TreatmentPin): string {
  const direction = SIMPLE_EDITORIAL_TREATMENT_DIRECTION_V7[`${pin.presetId}@${pin.version}`];
  if (!direction) throw new Error("Unsupported Treatment Preset version for Simple Editorial Story");
  return direction;
}

/* ── Negative prompt, one list per recipe generation ───────────────────────
 * Applies to both lists below. It is NOT enforcement.
 * `CompiledBrandVisualPrompt.negative` is delivered only by a provider route
 * with a negative-prompt channel, and the one this system renders on has none:
 * every Brand Visual frame goes through `generateHeroImageForVideo`, which is
 * pinned to `z-image-turbo`, and that model is `negativePromptDelivery:
 * "ignored"` (`ai-image-policy.ts`) on both its public endpoint — which accepts
 * the field and returns byte-identical images
 * (`artifacts/runpod-negative-prompt-probe-2026-08-10/`) — and its custom
 * workflow, which zeroes the negative conditioning. So these terms are computed
 * on every call and, today, reach nothing.
 *
 * They are kept rather than deleted because the list is the honest statement of
 * what a Brand Visual frame must not contain, and it becomes live the moment a
 * revision compiles for an engine that consumes a negative prompt. Extend only —
 * but never cite it as the reason something cannot appear in an image. */

/** Frozen negative prompt for the `-v2` compiler. Duplicated from what v3 now
 * uses rather than shared with it, because ADR 0005 pins a recipe version per
 * Brand Profile Revision and a `-v2` pin must keep compiling to the exact
 * provider input it was published with. It is the pre-ADR-0007 list, and it
 * contradicts ADR 0007 on purpose: it records the absolute "text-free" contract
 * that v2 was published under, not the policy in force. Never edit it — a change
 * here is a silent look change on every pinned `-v2` revision. */
const TEXT_FREE_NEGATIVE_PROMPT_TERMS: readonly string[] = [
  "text", "letters", "words", "numbers", "typography", "caption", "subtitle",
  "headline", "logo", "watermark", "signature", "brand name", "label", "signage",
  "currency symbol", "dollar sign", "baht sign", "artist initials", "corner mark", "date stamp",
  "currency glyph", "monetary icon", "symbol inside circle", "pseudo-text", "gibberish text",
  "framed notice", "wall chart", "written interface", "screen text", "document", "certificate",
  "legible writing", "comic panels", "panel borders", "collage", "split screen",
  "triptych", "storyboard", "contact sheet", "multiple camera views",
];

/** Current negative prompt, aligned with ADR 0007. Three families earn a place,
 * and nothing else does:
 *
 *  1. a mark that impersonates a layer that is deterministically ours — caption,
 *     subtitle, headline, logo, watermark, signature, brand name — plus the
 *     overlay artifacts of the same shape (artist initials, corner mark, date
 *     stamp), none of which is ever part of a depicted object;
 *  2. a frame that is not one frame;
 *  3. script the model cannot spell. ADR 0007 decided Thai: the model renders
 *     authentic-looking Thai that spells nothing, which a Thai viewer reads as
 *     broken. `Chinese writing` and `Japanese writing` follow the same failure
 *     mode and match `ai-image-policy.ts`, but ADR 0007 speaks only about Thai
 *     and English, so that pair is a conservative default, not a decided policy.
 *     `pseudo-text` and `gibberish text` name the failure itself and stay.
 *
 * Dropped against the frozen v2 list, each because ADR 0007 now says the
 * opposite: `text`, `letters`, `words`, `numbers`, `typography`, `label`,
 * `signage`, `legible writing`, `screen text` and `written interface` — English
 * is allowed, including full sentences, and a screen may show plausible English
 * UI; every currency term (`currency symbol`, `dollar sign`, `baht sign`,
 * `currency glyph`, `monetary icon`, `symbol inside circle`) — a denomination on
 * a banknote, a coin face and a price tag are part of the object; and
 * `framed notice`, `wall chart`, `document`, `certificate` — those name objects,
 * and once the text on them is permitted the only thing left in the term is a
 * ban on scene content, which per ADR 0006 the Visual Beat owns and a rendering
 * recipe does not. */
const V3_NEGATIVE_PROMPT_TERMS: readonly string[] = [
  "caption", "subtitle", "headline", "logo", "watermark", "signature", "brand name",
  "artist initials", "corner mark", "date stamp", "pseudo-text", "gibberish text",
  "Thai writing", "Chinese writing", "Japanese writing",
  "comic panels", "panel borders", "collage", "split screen",
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
  const formatDirection = V1_FORMAT_DIRECTION[input.visualFormatId];
  if (input.recipeVersion !== `${input.visualFormatId}-v1` || !formatDirection) {
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
    formatDirection,
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

/** A field left with no letter after cleaning contributes nothing rather than a
 * fragment of stray punctuation, which a diffusion encoder would still try to
 * render. Its clause then falls back to the compiler's own English default. */
const LATIN_LETTER_MARKER = /\p{Script=Latin}/u;

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

/** Terms v3 removes from every field before it becomes a prompt. Each one names
 * a layer the renderer owns deterministically — the subtitle track, the headline
 * hook, the brand mark — so a diffusion model synthesizing its own version of it
 * is always a defect, whatever the beat says (ADR 0007).
 *
 * Words that merely describe writing a scene genuinely contains — `sign`,
 * `words`, `letters`, `numbers`, `label` — are deliberately absent. The shared
 * `positiveArtDirectionValue` still strips those, along with any run of capitals,
 * which is why the beat `the words "OPEN LATE" against the closing street`
 * compiled to `the " " against the closing street`. That was correct while a
 * surface which must be read could never be a beat's focal subject; under
 * ADR 0007 and analyzer `-v5` it can, so v3 stops scrubbing what the story asked
 * for and scrubs only what the story may never own. */
const V3_RESERVED_LAYER_TERMS =
  /\b(?:captions?|subtitles?|headlines?|watermarks?|logos?|signatures?|typography|brand\s*names?)\b/giu;

/** v3-only cleaner. A `-v1`/`-v2` pin must keep compiling byte-identically
 * (ADR 0005), so this is a separate path rather than an edit to the shared
 * cleaner. It does three things the shared one does not:
 *
 * 1. Drops non-Latin writing. Every field reaching here is contracted to be
 *    English — the content-preflight prompt asks for it explicitly — so Thai in
 *    a beat is a defect, and a Thai `treatment` is text a Latin-trained encoder
 *    cannot act on but can still echo back as glyphs. A positive-only route has
 *    no other enforcement channel.
 * 2. Strips color codes. Creator-typed `treatment` and Gemini-extracted beat
 *    fields can carry a raw code just like a palette entry, and Z-Image paints
 *    one as a colored object rather than applying it as a grade.
 * 3. Keeps the scene's own lettering instead of scrubbing it (see above). */
function v3PositiveArtDirectionValue(value: string | null | undefined, limit = 260): string {
  const cleaned = latinLetteringOnly(artDirectionValue(value, limit))
    .replace(V3_RESERVED_LAYER_TERMS, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  const sanitized = LATIN_LETTER_MARKER.test(cleaned) ? cleaned : "";
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
    // No `-v4` for this change. A recipe version pins what a pinned revision
    // re-renders, and this edit touches only the negative string — which reaches
    // nothing on the single engine those revisions actually run on (every Brand
    // Visual render goes through `generateHeroImageForVideo`, pinned to
    // `z-image-turbo`, `negativePromptDelivery: "ignored"` on both routes). A
    // pinned `-v3` revision therefore re-renders byte-identically, which is the
    // guarantee ADR 0005 makes; freezing a `-v4` would instead leave every
    // already-pinned revision compiling a list that contradicts ADR 0007.
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
  };
}

function v4FactList(label: string, values: readonly string[] | undefined): string {
  const safeValues = (values ?? [])
    .map((value) => v3PositiveArtDirectionValue(value, 180))
    .filter(Boolean);
  return safeValues.length ? `${label} ${joinWithAnd(safeValues)}` : "";
}

function hardSceneFactsDirection(facts: HardSceneFacts | undefined): string {
  if (!facts) return "the explicitly described subject, action, setting and time";
  return [
    v4FactList("entity type", facts.entityTypes),
    v4FactList("age", facts.ages),
    v4FactList("gender", facts.genders),
    v4FactList("required action", facts.actions),
    v4FactList("location type", facts.locationTypes),
    facts.timeOfDay ? `time of day ${v3PositiveArtDirectionValue(facts.timeOfDay, 80)}` : "",
    facts.historicalPeriod
      ? `historical period ${v3PositiveArtDirectionValue(facts.historicalPeriod, 160)}`
      : "",
    facts.count !== null && facts.count !== undefined ? `exact count ${facts.count}` : "",
    v4FactList("essential object", facts.essentialObjects),
  ].filter(Boolean).join("; ");
}

function hardSceneFactsEnforcementDirection(facts: HardSceneFacts | undefined): string {
  if (!facts) return "render the explicitly described subject, action, setting and time literally";
  const entityTypes = facts.entityTypes
    .map((value) => v3PositiveArtDirectionValue(value, 180))
    .filter(Boolean);
  const essentialObjects = facts.essentialObjects
    .map((value) => v3PositiveArtDirectionValue(value, 180))
    .filter(Boolean);
  return [
    "render every listed entity, action, location, time and historical period literally and visibly",
    facts.count !== null && facts.count !== undefined
      ? `the complete frame contains exactly ${facts.count} ${facts.count === 1 ? "instance" : "instances"} of the listed counted story entity type, including foreground and background appearances`
      : "",
    essentialObjects.length
      ? `each stated essential object and quantity is clearly visible: ${joinWithAnd(essentialObjects)}`
      : "",
    entityTypes.some((value) => /\b(?:empty|unoccupied)\b/i.test(value))
      ? "every entity described as empty remains visibly unoccupied"
      : "",
    "flexible art direction and supporting scenery preserve these constraints without substitution or duplication",
  ].filter(Boolean).join("; ");
}

function hardSceneFactsEnforcementDirectionV6(facts: HardSceneFacts | undefined): string {
  if (!facts) return "render the explicitly described subject, action, setting and time literally";
  const entityTypes = facts.entityTypes
    .map((value) => v3PositiveArtDirectionValue(value, 180))
    .filter(Boolean);
  const essentialObjects = facts.essentialObjects
    .map((value) => v3PositiveArtDirectionValue(value, 180))
    .filter(Boolean);
  const countedEntity = entityTypes.length === 1 ? entityTypes[0] : "primary story entities";
  return [
    "render every listed entity, action, location, time and historical period literally and visibly",
    facts.count !== null && facts.count !== undefined
      ? `exactly ${facts.count} ${countedEntity} ${facts.count === 1 ? "appears" : "appear"} in the complete frame, counting foreground and background`
      : "",
    essentialObjects.length
      ? `each stated essential object and quantity is clearly visible: ${joinWithAnd(essentialObjects)}`
      : "",
    entityTypes.some((value) => /\b(?:empty|unoccupied)\b/i.test(value))
      ? "the empty chair is visibly unoccupied and the investigative room is carried by objects"
      : "",
    "supporting scenery preserves these exact facts",
  ].filter(Boolean).join("; ");
}

function safetyBoundaryDirection(boundary: SceneSafetyBoundary | undefined): string {
  if (boundary === "medical-illustration") {
    return [
      "This frame is an illustrative editorial concept for general understanding",
      "clinically exact dosage, test readings, treatment sequences and authoritative anatomy remain in verified deterministic copy outside the generated pixels",
    ].join("; ");
  }
  if (boundary === "real-person-context-only") {
    return [
      "Use non-identifying contextual imagery such as an unoccupied location, evidence motifs and unidentifiable fictional silhouettes",
      "the frame establishes investigative context without presenting an identifiable person's conduct as visual evidence",
    ].join("; ");
  }
  return "ordinary narrative illustration";
}

function safetyBoundaryDirectionV6(
  boundary: SceneSafetyBoundary | undefined,
  facts: HardSceneFacts | undefined,
): string {
  if (
    boundary === "real-person-context-only"
    && (facts?.entityTypes ?? []).some((value) => /\b(?:empty|unoccupied)\b/i.test(value))
  ) {
    return [
      "Use non-identifying contextual imagery",
      "the investigative context is carried entirely by the unoccupied room and evidence objects",
      "the frame establishes context without presenting an identifiable person's conduct as visual evidence",
    ].join("; ");
  }
  return safetyBoundaryDirection(boundary);
}

function entityRenderingDescriptionsV6(beat: VisualBeat, visualFormatId: VisualFormatId): string {
  const descriptions = (beat.entityRenderingDescriptions ?? [])
    .map((description) => v3PositiveArtDirectionValue(description, 500))
    .filter(Boolean);
  if (!descriptions.length) return "none required for this scene";
  if (visualFormatId === "stick-figure-story") {
    return descriptions
      .map((description) => `a circular-head line-body figure representing ${description}`)
      .join("; ");
  }
  return descriptions.join("; ");
}

function letteringSafeVisualValueV8(value: string | null | undefined, limit = 260): string {
  return v3PositiveArtDirectionValue(value, limit)
    .replace(
      /\bthree unlabeled workflow cards\b/giu,
      "exactly three blank solid-color workflow tiles distinguished by color and simple object silhouettes",
    )
    .replace(
      /\b(?:a |the )?timeline\b/giu,
      "an unlettered horizontal sequence of solid circular markers",
    )
    .replace(
      /\bpublic[- ]record shapes\b/giu,
      "blank evidence tiles using simple object silhouettes",
    )
    .replace(
      /\bpublic records?\b/giu,
      "blank evidence tiles using simple object silhouettes",
    )
    .replace(
      /\brecords?\b/giu,
      "blank evidence tiles using simple object silhouettes",
    )
    .replace(
      /\b(?:a |an |the )?abstract inventory dashboard\b/giu,
      "exactly three blank solid-color workflow tiles arranged left to right",
    )
    .replace(
      /\b(?:a |the )?simple habit checklist shape\b/giu,
      "a row of blank solid-color habit tokens with one token selected by hand",
    );
}

function v8FactList(label: string, values: readonly string[] | undefined): string {
  const safeValues = (values ?? [])
    .map((value) => letteringSafeVisualValueV8(value, 180))
    .filter(Boolean);
  return safeValues.length ? `${label} ${joinWithAnd(safeValues)}` : "";
}

function hardSceneFactsDirectionV8(facts: HardSceneFacts | undefined): string {
  if (!facts) return "the explicitly described subject, action, setting and time";
  return [
    v8FactList("entity type", facts.entityTypes),
    v8FactList("age", facts.ages),
    v8FactList("gender", facts.genders),
    v8FactList("required action", facts.actions),
    v8FactList("location type", facts.locationTypes),
    facts.timeOfDay ? `time of day ${letteringSafeVisualValueV8(facts.timeOfDay, 80)}` : "",
    facts.historicalPeriod
      ? `historical period ${letteringSafeVisualValueV8(facts.historicalPeriod, 160)}`
      : "",
    facts.count !== null && facts.count !== undefined ? `exact count ${facts.count}` : "",
    v8FactList("essential object", facts.essentialObjects),
  ].filter(Boolean).join("; ");
}

function hardSceneFactsEnforcementDirectionV8(facts: HardSceneFacts | undefined): string {
  if (!facts) return "render the explicitly described subject, action, setting and time literally";
  const entityTypes = facts.entityTypes
    .map((value) => letteringSafeVisualValueV8(value, 180))
    .filter(Boolean);
  const essentialObjects = facts.essentialObjects
    .map((value) => letteringSafeVisualValueV8(value, 180))
    .filter(Boolean);
  const countedEntity = entityTypes.length === 1 ? entityTypes[0] : "primary story entities";
  return [
    "render every listed entity, action, location, time and historical period literally and visibly",
    facts.count !== null && facts.count !== undefined
      ? `exactly ${facts.count} ${countedEntity} ${facts.count === 1 ? "appears" : "appear"} in the complete frame, counting foreground and background`
      : "",
    essentialObjects.length
      ? `each stated essential object and quantity is clearly visible: ${joinWithAnd(essentialObjects)}`
      : "",
    entityTypes.some((value) => /\b(?:empty|unoccupied)\b/i.test(value))
      ? "the empty chair is visibly unoccupied and the investigative room is carried by objects"
      : "",
    "supporting scenery preserves these exact facts",
  ].filter(Boolean).join("; ");
}

function countSafeFlexibleSceneDirectionV8(beat: VisualBeat): string {
  const facts = beat.hardSceneFacts;
  if (facts?.count !== null && facts?.count !== undefined && facts.entityTypes.length > 0) {
    const entityTypes = facts.entityTypes
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    const actions = facts.actions
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    const locations = facts.locationTypes
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    const essentialObjects = facts.essentialObjects
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    return [
      `the complete visible counted set is exactly ${facts.count} ${joinWithAnd(entityTypes)}`,
      actions.length ? `performing ${joinWithAnd(actions)}` : "",
      locations.length ? `at ${joinWithAnd(locations)}` : "",
      facts.timeOfDay ? `during ${letteringSafeVisualValueV8(facts.timeOfDay, 80)}` : "",
      facts.historicalPeriod
        ? `in the ${letteringSafeVisualValueV8(facts.historicalPeriod, 160)}`
        : "",
      essentialObjects.length ? `with ${joinWithAnd(essentialObjects)}` : "",
      beat.emotion ? `expressing ${letteringSafeVisualValueV8(beat.emotion)}` : "",
      "a sparse composition centers this complete counted set through architecture, landscape, light and ordinary inanimate setting details",
    ].filter(Boolean).join(", ");
  }
  return [
    letteringSafeVisualValueV8(beat.subject),
    letteringSafeVisualValueV8(beat.action),
    beat.setting ? `set in ${letteringSafeVisualValueV8(beat.setting)}` : "",
    beat.emotion ? `the mood feels ${letteringSafeVisualValueV8(beat.emotion)}` : "",
    beat.emphasis ? `visual attention rests on ${letteringSafeVisualValueV8(beat.emphasis)}` : "",
  ].filter(Boolean).join(", ") || "one coherent subject acting in a clear setting";
}

function countSafeFlexibleSceneDirectionV11(beat: VisualBeat): string {
  const facts = beat.hardSceneFacts;
  if (facts?.count !== null && facts?.count !== undefined && facts.entityTypes.length > 0) {
    const entityTypes = facts.entityTypes
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    const actions = facts.actions
      .map((value) => letteringSafeVisualValueV8(value, 240))
      .filter(Boolean);
    const locations = facts.locationTypes
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    const essentialObjects = facts.essentialObjects
      .map((value) => letteringSafeVisualValueV8(value, 180))
      .filter(Boolean);
    const countedEntity = joinWithAnd(entityTypes);
    return [
      `one compact story group contains the complete visible counted set of exactly ${facts.count} ${countedEntity}`,
      `all foreground, midground and background appearances of ${countedEntity} belong to this same closed counted set`,
      actions.length ? `performing ${joinWithAnd(actions)}` : "",
      locations.length ? `at ${joinWithAnd(locations)}` : "",
      facts.timeOfDay ? `during ${letteringSafeVisualValueV8(facts.timeOfDay, 80)}` : "",
      facts.historicalPeriod
        ? `in the ${letteringSafeVisualValueV8(facts.historicalPeriod, 160)}`
        : "",
      essentialObjects.length ? `with ${joinWithAnd(essentialObjects)}` : "",
      beat.emotion ? `expressing ${letteringSafeVisualValueV8(beat.emotion)}` : "",
      "all remaining image areas continue the stated location through open negative space, broad material surfaces and light with silhouettes clearly different from the counted entities and essential objects",
    ].filter(Boolean).join(", ");
  }
  return countSafeFlexibleSceneDirectionV8(beat);
}

function hardSceneFactsEnforcementDirectionV11(facts: HardSceneFacts | undefined): string {
  if (!facts) return hardSceneFactsEnforcementDirectionV8(facts);
  const entityTypes = facts.entityTypes
    .map((value) => letteringSafeVisualValueV8(value, 180))
    .filter(Boolean);
  const essentialObjects = facts.essentialObjects
    .map((value) => letteringSafeVisualValueV8(value, 180))
    .filter(Boolean);
  const countedEntity = entityTypes.length === 1 ? entityTypes[0] : "primary story entities";
  return [
    "render every listed entity, action, location, time and historical period literally and visibly",
    facts.count !== null && facts.count !== undefined
      ? `exactly ${facts.count} ${countedEntity} ${facts.count === 1 ? "appears" : "appear"} in the complete frame, counting foreground and background`
      : "",
    facts.count !== null && facts.count !== undefined
      ? `all visible instances of ${countedEntity} form one closed set of exactly ${facts.count} across foreground, midground and background`
      : "",
    essentialObjects.length
      ? `each stated essential object and quantity is clearly visible: ${joinWithAnd(essentialObjects)}`
      : "",
    essentialObjects.length
      ? `the complete visible essential-object arrangement matches these stated quantities and relationships: ${joinWithAnd(essentialObjects)}`
      : "",
    facts.actions.length
      ? "the visible action connects every stated actor, source object, target object, contact point and destination in one frozen moment"
      : "",
    entityTypes.some((value) => /\b(?:empty|unoccupied)\b/i.test(value))
      ? "the empty chair is visibly unoccupied and the investigative room is carried by objects; the visibly empty chair remains a fully shown inanimate object with its seat and surrounding opening unobstructed"
      : "",
    "supporting scenery consists of open setting surfaces and preserves this closed cast and object arrangement",
  ].filter(Boolean).join("; ");
}

function positiveOnlyVisualValueV9(value: string | null | undefined, limit = 260): string {
  return letteringSafeVisualValueV8(value, limit)
    .replace(
      /\bchecks? that the repaired tap has stopped dripping\b/giu,
      "checks the dry and motionless repaired tap above a dry sink basin",
    )
    .replace(
      /\bthe repaired tap has stopped dripping\b/giu,
      "the repaired tap is dry and motionless above a dry sink basin",
    )
    .replace(
      /(?<!matte )\bdry repaired tap\b/giu,
      "dry and motionless repaired tap above a dry sink basin",
    );
}

function positiveOnlyVisualBeatV9(beat: VisualBeat): VisualBeat {
  const facts = beat.hardSceneFacts;
  return {
    ...beat,
    subject: positiveOnlyVisualValueV9(beat.subject),
    action: positiveOnlyVisualValueV9(beat.action),
    setting: positiveOnlyVisualValueV9(beat.setting),
    emotion: positiveOnlyVisualValueV9(beat.emotion),
    emphasis: positiveOnlyVisualValueV9(beat.emphasis),
    hardSceneFacts: facts ? {
      ...facts,
      entityTypes: facts.entityTypes.map((value) => positiveOnlyVisualValueV9(value, 180)),
      ages: facts.ages.map((value) => positiveOnlyVisualValueV9(value, 80)),
      genders: facts.genders.map((value) => positiveOnlyVisualValueV9(value, 80)),
      actions: facts.actions.map((value) => positiveOnlyVisualValueV9(value, 180)),
      locationTypes: facts.locationTypes.map((value) => positiveOnlyVisualValueV9(value, 180)),
      timeOfDay: facts.timeOfDay ? positiveOnlyVisualValueV9(facts.timeOfDay, 80) : null,
      historicalPeriod: facts.historicalPeriod
        ? positiveOnlyVisualValueV9(facts.historicalPeriod, 160)
        : null,
      essentialObjects: facts.essentialObjects.map((value) => positiveOnlyVisualValueV9(value, 180)),
    } : undefined,
  };
}

function completedResultVisualValueV10(value: string | null | undefined, limit = 260): string {
  return positiveOnlyVisualValueV9(value, limit)
    .replace(
      /\bchecks the dry and motionless repaired tap above a dry sink basin\b/giu,
      "stands upright beside the completed kitchen sink with both hands relaxed at their sides",
    )
    .replace(
      /\bdry and motionless repaired tap above a dry sink basin\b/giu,
      "matte dry repaired tap above a matte dry sink basin",
    );
}

function completedResultVisualBeatV10(beat: VisualBeat): VisualBeat {
  const facts = beat.hardSceneFacts;
  return {
    ...beat,
    subject: completedResultVisualValueV10(beat.subject),
    action: completedResultVisualValueV10(beat.action),
    setting: completedResultVisualValueV10(beat.setting),
    emotion: completedResultVisualValueV10(beat.emotion),
    emphasis: completedResultVisualValueV10(beat.emphasis),
    hardSceneFacts: facts ? {
      ...facts,
      entityTypes: facts.entityTypes.map((value) => completedResultVisualValueV10(value, 180)),
      ages: facts.ages.map((value) => completedResultVisualValueV10(value, 80)),
      genders: facts.genders.map((value) => completedResultVisualValueV10(value, 80)),
      actions: facts.actions.map((value) => completedResultVisualValueV10(value, 180)),
      locationTypes: facts.locationTypes.map((value) => completedResultVisualValueV10(value, 180)),
      timeOfDay: facts.timeOfDay ? completedResultVisualValueV10(facts.timeOfDay, 80) : null,
      historicalPeriod: facts.historicalPeriod
        ? completedResultVisualValueV10(facts.historicalPeriod, 160)
        : null,
      essentialObjects: facts.essentialObjects
        .map((value) => completedResultVisualValueV10(value, 180)),
    } : undefined,
  };
}

/** Current video compiler. Hard Scene Facts and unambiguous entity rendering
 * descriptions lead the positive-only prompt. Treatment, format and Brand
 * grammar may enrich only the flexible layers that follow. */
function compileBrandVisualPromptV4(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V4_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = input.visualBeat;
  const scene = [
    v3PositiveArtDirectionValue(beat.subject),
    v3PositiveArtDirectionValue(beat.action),
    beat.setting ? `set in ${v3PositiveArtDirectionValue(beat.setting)}` : "",
    beat.emotion ? `the mood feels ${v3PositiveArtDirectionValue(beat.emotion)}` : "",
    beat.emphasis ? `visual attention rests on ${v3PositiveArtDirectionValue(beat.emphasis)}` : "",
  ].filter(Boolean).join(", ") || "one coherent subject acting in a clear setting";
  const entityDescriptions = (beat.entityRenderingDescriptions ?? [])
    .map((description) => v3PositiveArtDirectionValue(description, 500))
    .filter(Boolean)
    .join("; ") || "none required for this scene";
  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");
  const pinnedTreatmentDirection = input.treatmentPin
    ? treatmentPromptDirection(input.treatmentPin)
    : v3PositiveArtDirectionValue(input.treatment) || "neutral editorial storytelling";
  const sceneIntensity = v3PositiveArtDirectionValue(beat.sceneIntensity) || "balanced";
  const safeDomain = v3PositiveArtDirectionValue(input.contentDomain) || "a visually led subject";

  const positive = [
    `Hard scene facts: ${hardSceneFactsDirection(beat.hardSceneFacts)}`,
    `Entity rendering descriptions: ${entityDescriptions}`,
    `Safety boundary: ${safetyBoundaryDirection(beat.safetyBoundary)}`,
    `Flexible scene direction: for a story about ${safeDomain}, show ${scene}`,
    `Treatment direction: ${pinnedTreatmentDirection}; scene intensity ${sceneIntensity}`,
    `Visual format direction: ${formatDirection}`,
    `Brand rendering direction: ${brand.direction}`,
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "Preserve every hard scene fact while adapting only camera, composition, lighting, color, texture and non-essential supporting detail",
    "The lower third stays calm and uncluttered with open background texture",
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
    ...(input.treatmentPin ? { treatmentPin: input.treatmentPin } : {}),
  };
}

/** Current qualification-hardened compiler. V4 remains byte-stable for
 * already-pinned projects; V5 repeats the immutable facts after art direction
 * because the positive-only public model sometimes lost counts and essential
 * objects over a long prompt. */
function compileBrandVisualPromptV5(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V5_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = input.visualBeat;
  const scene = [
    v3PositiveArtDirectionValue(beat.subject),
    v3PositiveArtDirectionValue(beat.action),
    beat.setting ? `set in ${v3PositiveArtDirectionValue(beat.setting)}` : "",
    beat.emotion ? `the mood feels ${v3PositiveArtDirectionValue(beat.emotion)}` : "",
    beat.emphasis ? `visual attention rests on ${v3PositiveArtDirectionValue(beat.emphasis)}` : "",
  ].filter(Boolean).join(", ") || "one coherent subject acting in a clear setting";
  const entityDescriptions = (beat.entityRenderingDescriptions ?? [])
    .map((description) => v3PositiveArtDirectionValue(description, 500))
    .filter(Boolean)
    .join("; ") || "none required for this scene";
  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");
  const pinnedTreatmentDirection = input.treatmentPin
    ? treatmentPromptDirection(input.treatmentPin)
    : v3PositiveArtDirectionValue(input.treatment) || "neutral editorial storytelling";
  const sceneIntensity = v3PositiveArtDirectionValue(beat.sceneIntensity) || "balanced";
  const safeDomain = v3PositiveArtDirectionValue(input.contentDomain) || "a visually led subject";

  const positive = [
    `Hard scene facts: ${hardSceneFactsDirection(beat.hardSceneFacts)}`,
    `Entity rendering descriptions: ${entityDescriptions}`,
    `Safety boundary: ${safetyBoundaryDirection(beat.safetyBoundary)}`,
    `Flexible scene direction: for a story about ${safeDomain}, show ${scene}`,
    `Treatment direction: ${pinnedTreatmentDirection}; scene intensity ${sceneIntensity}`,
    `Visual format direction: ${formatDirection}`,
    `Brand rendering direction: ${brand.direction}`,
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "Preserve every hard scene fact while adapting only camera, composition, lighting, color, texture and non-essential supporting detail",
    "The lower third stays calm and uncluttered with open background texture",
    `Final hard-fact check: ${hardSceneFactsEnforcementDirection(beat.hardSceneFacts)}`,
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
    ...(input.treatmentPin ? { treatmentPin: input.treatmentPin } : {}),
  };
}

/** Public-model-hardened compiler produced from the failed v5 smoke review.
 * It places the medium contract before flexible direction, translates human
 * entity descriptions into the selected abstract medium and names an
 * unambiguous counted entity whenever the Hard Scene Facts provide one type. */
function compileBrandVisualPromptV6(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V6_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = input.visualBeat;
  const scene = [
    v3PositiveArtDirectionValue(beat.subject),
    v3PositiveArtDirectionValue(beat.action),
    beat.setting ? `set in ${v3PositiveArtDirectionValue(beat.setting)}` : "",
    beat.emotion ? `the mood feels ${v3PositiveArtDirectionValue(beat.emotion)}` : "",
    beat.emphasis ? `visual attention rests on ${v3PositiveArtDirectionValue(beat.emphasis)}` : "",
  ].filter(Boolean).join(", ") || "one coherent subject acting in a clear setting";
  const entityDescriptions = entityRenderingDescriptionsV6(beat, input.visualFormatId);
  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");
  const pinnedTreatmentDirection = input.treatmentPin
    ? input.visualFormatId === "simple-editorial-story"
      ? simpleEditorialTreatmentDirectionV7(input.treatmentPin)
      : treatmentPromptDirection(input.treatmentPin)
    : input.visualFormatId === "simple-editorial-story"
      ? "clear narrative emphasis and balanced visual pacing"
      : v3PositiveArtDirectionValue(input.treatment) || "neutral editorial storytelling";
  const sceneIntensity = v3PositiveArtDirectionValue(beat.sceneIntensity) || "balanced";
  const safeDomain = v3PositiveArtDirectionValue(input.contentDomain) || "a visually led subject";

  const positive = [
    `Hard scene facts: ${hardSceneFactsDirection(beat.hardSceneFacts)}`,
    `Entity rendering descriptions: ${entityDescriptions}`,
    `Visual format direction: ${formatDirection}`,
    `Safety boundary: ${safetyBoundaryDirectionV6(beat.safetyBoundary, beat.hardSceneFacts)}`,
    `Flexible scene direction: for a story about ${safeDomain}, show ${scene}`,
    `Treatment direction: ${pinnedTreatmentDirection}; scene intensity ${sceneIntensity}`,
    `Brand rendering direction: ${brand.direction}`,
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "Preserve every hard scene fact while adapting only camera, composition, lighting, color, texture and non-essential supporting detail",
    "The lower third stays calm and uncluttered with open background texture",
    `Final hard-fact check: ${hardSceneFactsEnforcementDirectionV6(beat.hardSceneFacts)}`,
    `Final visual-format check: ${formatDirection}`,
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
    ...(input.treatmentPin ? { treatmentPin: input.treatmentPin } : {}),
  };
}

/** Current compiler. It derives exact-count compositions from Hard Scene Facts
 * alone, so later flexible language cannot imply duplicates. */
function compileBrandVisualPromptV8(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V8_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = input.visualBeat;
  const scene = countSafeFlexibleSceneDirectionV8(beat);
  const entityDescriptions = entityRenderingDescriptionsV6(beat, input.visualFormatId);
  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");
  const pinnedTreatmentDirection = input.treatmentPin
    ? input.visualFormatId === "simple-editorial-story"
      ? simpleEditorialTreatmentDirectionV7(input.treatmentPin)
      : treatmentPromptDirection(input.treatmentPin)
    : input.visualFormatId === "simple-editorial-story"
      ? "clear narrative emphasis and balanced visual pacing"
      : v3PositiveArtDirectionValue(input.treatment) || "neutral editorial storytelling";
  const sceneIntensity = v3PositiveArtDirectionValue(beat.sceneIntensity) || "balanced";
  const hasExactCount = beat.hardSceneFacts?.count !== null
    && beat.hardSceneFacts?.count !== undefined;
  const safeDomain = letteringSafeVisualValueV8(input.contentDomain) || "a visually led subject";

  const positive = [
    `Hard scene facts: ${hardSceneFactsDirectionV8(beat.hardSceneFacts)}`,
    `Entity rendering descriptions: ${entityDescriptions}`,
    `Visual format direction: ${formatDirection}`,
    `Safety boundary: ${safetyBoundaryDirectionV6(beat.safetyBoundary, beat.hardSceneFacts)}`,
    hasExactCount
      ? `Count-safe flexible scene direction: ${scene}`
      : `Flexible scene direction: for a story about ${safeDomain}, show ${scene}`,
    "Lettering-safe visual plan: blank solid-color shapes, simple object silhouettes, spacing and physical action carry all information throughout the frame",
    `Treatment direction: ${pinnedTreatmentDirection}; scene intensity ${sceneIntensity}`,
    `Brand rendering direction: ${brand.direction}`,
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "Preserve every hard scene fact while adapting only camera, composition, lighting, color, texture and non-essential supporting detail",
    "The lower third stays calm and uncluttered with open background texture",
    `Final hard-fact check: ${hardSceneFactsEnforcementDirectionV8(beat.hardSceneFacts)}`,
    `Final visual-format check: ${formatDirection}`,
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
    ...(input.treatmentPin ? { treatmentPin: input.treatmentPin } : {}),
  };
}

/** Current positive-only compiler. It keeps V8's count and lettering rules,
 * translates completed failure states into affirmative visible outcomes, and
 * uses the caption-free Clear Infographic composition published in V9. */
function compileBrandVisualPromptV9(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V9_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = positiveOnlyVisualBeatV9(input.visualBeat);
  const scene = countSafeFlexibleSceneDirectionV8(beat);
  const entityDescriptions = entityRenderingDescriptionsV6(beat, input.visualFormatId);
  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");
  const pinnedTreatmentDirection = input.treatmentPin
    ? input.visualFormatId === "simple-editorial-story"
      ? simpleEditorialTreatmentDirectionV7(input.treatmentPin)
      : treatmentPromptDirection(input.treatmentPin)
    : input.visualFormatId === "simple-editorial-story"
      ? "clear narrative emphasis and balanced visual pacing"
      : v3PositiveArtDirectionValue(input.treatment) || "neutral editorial storytelling";
  const sceneIntensity = v3PositiveArtDirectionValue(beat.sceneIntensity) || "balanced";
  const hasExactCount = beat.hardSceneFacts?.count !== null
    && beat.hardSceneFacts?.count !== undefined;
  const safeDomain = positiveOnlyVisualValueV9(input.contentDomain) || "a visually led subject";

  const positive = [
    `Hard scene facts: ${hardSceneFactsDirectionV8(beat.hardSceneFacts)}`,
    `Entity rendering descriptions: ${entityDescriptions}`,
    `Visual format direction: ${formatDirection}`,
    `Safety boundary: ${safetyBoundaryDirectionV6(beat.safetyBoundary, beat.hardSceneFacts)}`,
    hasExactCount
      ? `Count-safe flexible scene direction: ${scene}`
      : `Flexible scene direction: for a story about ${safeDomain}, show ${scene}`,
    "Lettering-safe visual plan: blank solid-color shapes, simple object silhouettes, spacing and physical action carry all information throughout the frame",
    `Treatment direction: ${pinnedTreatmentDirection}; scene intensity ${sceneIntensity}`,
    `Brand rendering direction: ${brand.direction}`,
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "Preserve every hard scene fact while adapting only camera, composition, lighting, color, texture and non-essential supporting detail",
    "The lower third stays calm and uncluttered with open background texture",
    `Final hard-fact check: ${hardSceneFactsEnforcementDirectionV8(beat.hardSceneFacts)}`,
    `Final visual-format check: ${formatDirection}`,
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
    ...(input.treatmentPin ? { treatmentPin: input.treatmentPin } : {}),
  };
}

/** Simple Editorial v10 stages a completed result after verification. The
 * provider sees relaxed hands and matte dry surfaces instead of an interaction
 * with the faucet, while v9 remains byte-stable for its paid evidence. */
function compileBrandVisualPromptV10(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V10_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }
  const compiled = compileBrandVisualPromptV9({
    ...input,
    recipeVersion: "simple-editorial-story-v9",
    visualBeat: completedResultVisualBeatV10(input.visualBeat),
  });
  return { ...compiled, recipeVersion: input.recipeVersion };
}

/** Relational Hard Scene Fact recipe generation. It preserves the accepted
 * rendering media while closing counted casts across the entire frame. */
function compileBrandVisualPromptV11(input: {
  visualFormatId: VisualFormatId;
  recipeVersion: string;
  contentDomain: string;
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const recipe = V11_FORMAT_RECIPE_DIRECTION[input.recipeVersion];
  if (!recipe || recipe.formatId !== input.visualFormatId) {
    throw new Error("Unsupported Visual Format recipe version");
  }

  const beat = completedResultVisualBeatV10(input.visualBeat);
  const scene = countSafeFlexibleSceneDirectionV11(beat);
  const entityDescriptions = entityRenderingDescriptionsV6(beat, input.visualFormatId);
  const brand = brandRenderingDirectionV3(input.brandVisualLanguage);
  const formatDirection = [
    ...recipe.direction,
    ...(recipe.fallbackPalette && !brand.hasPalette ? [recipe.fallbackPalette] : []),
  ].join(", ");
  const pinnedTreatmentDirection = input.treatmentPin
    ? input.visualFormatId === "simple-editorial-story"
      ? simpleEditorialTreatmentDirectionV7(input.treatmentPin)
      : treatmentPromptDirection(input.treatmentPin)
    : input.visualFormatId === "simple-editorial-story"
      ? "clear narrative emphasis and balanced visual pacing"
      : v3PositiveArtDirectionValue(input.treatment) || "neutral editorial storytelling";
  const sceneIntensity = v3PositiveArtDirectionValue(beat.sceneIntensity) || "balanced";
  const hasExactCount = beat.hardSceneFacts?.count !== null
    && beat.hardSceneFacts?.count !== undefined;
  const safeDomain = positiveOnlyVisualValueV9(input.contentDomain) || "a visually led subject";

  const positive = [
    `Hard scene facts: ${hardSceneFactsDirectionV8(beat.hardSceneFacts)}`,
    `Entity rendering descriptions: ${entityDescriptions}`,
    `Visual format direction: ${formatDirection}`,
    `Safety boundary: ${safetyBoundaryDirectionV6(beat.safetyBoundary, beat.hardSceneFacts)}`,
    hasExactCount
      ? `Count-safe flexible scene direction: ${scene}`
      : `Flexible scene direction: for a story about ${safeDomain}, show ${scene}`,
    "Lettering-safe visual plan: every wall, garment, object and background surface presents one continuous visually plain material texture; physical action, simple object silhouettes, spacing and light carry all information throughout the frame",
    `Treatment direction: ${pinnedTreatmentDirection}; scene intensity ${sceneIntensity}`,
    `Brand rendering direction: ${brand.direction}`,
    "A vertical edge-to-edge composition from a single viewpoint fills the frame",
    "All people and objects share the same ground plane in one frozen moment",
    "Preserve every hard scene fact while adapting only camera, composition, lighting, color, texture and non-essential supporting detail",
    "The lower third stays calm and uncluttered with open background texture",
    `Final hard-fact check: ${hardSceneFactsEnforcementDirectionV11(beat.hardSceneFacts)}`,
    `Final visual-format check: ${formatDirection}`,
  ].join(". ") + ".";

  return {
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    positive,
    negative: [
      ...V3_NEGATIVE_PROMPT_TERMS,
      ...(recipe.extraNegative ?? []),
    ].join(", "),
    ...(input.treatmentPin ? { treatmentPin: input.treatmentPin } : {}),
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
  treatment?: string;
  treatmentPin?: TreatmentPin;
  visualBeat: VisualBeat;
  brandVisualLanguage?: BrandVisualLanguage | null;
}): CompiledBrandVisualPrompt {
  const format = SUPPORTED_VISUAL_FORMATS.find((candidate) => candidate.id === input.visualFormatId);
  if (!format) throw new Error("Unsupported Visual Format");
  const recipeVersion = input.recipeVersion ?? format.recipeVersion;
  let compiled: CompiledBrandVisualPrompt;
  if (recipeVersion.endsWith("-v1")) {
    compiled = compileBrandVisualPromptV1({ ...input, treatment: input.treatment ?? "", recipeVersion });
  } else if (recipeVersion.endsWith("-v2")) {
    compiled = compileBrandVisualPromptV2({ ...input, treatment: input.treatment ?? "", recipeVersion });
  } else if (recipeVersion.endsWith("-v3")) {
    compiled = compileBrandVisualPromptV3({ ...input, treatment: input.treatment ?? "", recipeVersion });
  } else if (recipeVersion.endsWith("-v4")) {
    compiled = compileBrandVisualPromptV4({ ...input, recipeVersion });
  } else if (recipeVersion.endsWith("-v5")) {
    compiled = compileBrandVisualPromptV5({ ...input, recipeVersion });
  } else if (V11_FORMAT_RECIPE_DIRECTION[recipeVersion]) {
    compiled = compileBrandVisualPromptV11({ ...input, recipeVersion });
  } else if (V10_FORMAT_RECIPE_DIRECTION[recipeVersion]) {
    compiled = compileBrandVisualPromptV10({ ...input, recipeVersion });
  } else if (V9_FORMAT_RECIPE_DIRECTION[recipeVersion]) {
    compiled = compileBrandVisualPromptV9({ ...input, recipeVersion });
  } else if (V8_FORMAT_RECIPE_DIRECTION[recipeVersion]) {
    compiled = compileBrandVisualPromptV8({ ...input, recipeVersion });
  } else {
    compiled = compileBrandVisualPromptV6({ ...input, recipeVersion });
  }
  // A targeted repair may preserve a historical format recipe while replacing
  // only the proven placeholder. Keep the immutable treatment metadata on the
  // compiled result without rewriting the frozen recipe implementation.
  return input.treatmentPin && !compiled.treatmentPin
    ? { ...compiled, treatmentPin: input.treatmentPin }
    : compiled;
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
  peopleAndSetting: "simple editorial figures grounded in recognizable Thai contexts",
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
      visualFormatId: "simple-editorial-story" as const,
      seed: scene.seed,
      compiled: compileBrandVisualPrompt({
        visualFormatId: "simple-editorial-story",
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
