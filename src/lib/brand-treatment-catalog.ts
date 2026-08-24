import { z } from "zod";

export const GENERIC_TREATMENT_PLACEHOLDER = "ชัดเจนและเหมาะกับเนื้อหา";

export const TREATMENT_PRESET_IDS = [
  "expert-clarity",
  "practical-documentary",
  "thai-human-drama",
  "modern-business-technology",
  "premium-product-lifestyle",
  "investigative-news-crime",
  "thai-history-period-storytelling",
  "thai-supernatural-horror",
] as const;

export type TreatmentPresetId = (typeof TREATMENT_PRESET_IDS)[number];
export type TreatmentPinSource = "adaptive" | "locked" | "creator" | "repair";

export type TreatmentPreset = {
  id: TreatmentPresetId;
  internalName: string;
  thaiLabel: string;
  version: `v1.${number}.${number}`;
  /** Append-only recipes. Advancing `version` must retain older entries so
   * already-pinned projects and Scene Rerolls remain reproducible. */
  versions: readonly {
    version: `v1.${number}.${number}`;
    promptDirection: string;
  }[];
  relatedPresetIds: readonly TreatmentPresetId[];
};

export const TREATMENT_PRESETS: readonly TreatmentPreset[] = [
  {
    id: "expert-clarity",
    internalName: "Expert Clarity",
    thaiLabel: "ผู้เชี่ยวชาญอธิบายชัด",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "authoritative editorial clarity, calm evidence-led explanation, precise visual hierarchy" }],
    relatedPresetIds: ["practical-documentary", "modern-business-technology"],
  },
  {
    id: "practical-documentary",
    internalName: "Practical Documentary",
    thaiLabel: "สาธิตจากชีวิตจริง",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "grounded observational documentary storytelling, practical action, believable everyday detail" }],
    relatedPresetIds: ["expert-clarity", "thai-human-drama"],
  },
  {
    id: "thai-human-drama",
    internalName: "Thai Human Drama",
    thaiLabel: "ดราม่าชีวิตไทย",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "emotionally grounded Thai human drama, intimate stakes, expressive but believable moments" }],
    relatedPresetIds: ["practical-documentary", "thai-supernatural-horror"],
  },
  {
    id: "modern-business-technology",
    internalName: "Modern Business and Technology",
    thaiLabel: "ธุรกิจและเทคทันสมัย",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "confident contemporary business and technology storytelling, focused momentum, polished clarity" }],
    relatedPresetIds: ["expert-clarity", "premium-product-lifestyle"],
  },
  {
    id: "premium-product-lifestyle",
    internalName: "Premium Product and Lifestyle",
    thaiLabel: "โฆษณาสินค้าพรีเมียม",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "aspirational premium product and lifestyle advertising, refined restraint, tactile desirability" }],
    relatedPresetIds: ["modern-business-technology", "practical-documentary"],
  },
  {
    id: "investigative-news-crime",
    internalName: "Investigative News and Crime",
    thaiLabel: "ข่าวสืบสวนเข้มข้น",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "tense investigative journalism, contextual evidence motifs, sober high-stakes atmosphere" }],
    relatedPresetIds: ["expert-clarity", "thai-history-period-storytelling"],
  },
  {
    id: "thai-history-period-storytelling",
    internalName: "Thai History and Period Storytelling",
    thaiLabel: "ประวัติศาสตร์และตำนานไทย",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "immersive Thai historical and period storytelling, specific era detail, dignified legendary scale" }],
    relatedPresetIds: ["thai-human-drama", "investigative-news-crime"],
  },
  {
    id: "thai-supernatural-horror",
    internalName: "Thai Supernatural Horror",
    thaiLabel: "หนังผีไทย",
    version: "v1.0.0",
    versions: [{ version: "v1.0.0", promptDirection: "frightening Thai supernatural horror, nocturnal dread, escalating tension, culturally grounded atmosphere" }],
    relatedPresetIds: ["thai-human-drama", "thai-history-period-storytelling"],
  },
] as const;

const presetById = new Map(TREATMENT_PRESETS.map((preset) => [preset.id, preset]));

export const treatmentPinSchema = z.object({
  kind: z.literal("catalog"),
  presetId: z.enum(TREATMENT_PRESET_IDS),
  version: z.string().regex(/^v1\.\d+\.\d+$/),
  source: z.enum(["adaptive", "locked", "creator", "repair"]),
}).refine(
  (pin) => presetById.get(pin.presetId)?.versions.some((recipe) => recipe.version === pin.version) === true,
  { path: ["version"], message: "Unsupported Treatment Preset version" },
);

export type TreatmentPin = z.infer<typeof treatmentPinSchema>;

export function treatmentPreset(id: TreatmentPresetId): TreatmentPreset {
  const preset = presetById.get(id);
  if (!preset) throw new Error("Unsupported Treatment Preset");
  return preset;
}

export function createCatalogTreatmentPin(
  presetId: TreatmentPresetId,
  source: TreatmentPinSource,
): TreatmentPin {
  const preset = treatmentPreset(presetId);
  return { kind: "catalog", presetId, version: preset.version, source };
}

export function parseTreatmentPin(value: string | null | undefined): TreatmentPin | null {
  if (!value) return null;
  try {
    const parsed = treatmentPinSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    return catalogTreatmentPinForVersion(
      parsed.data.presetId,
      parsed.data.version,
      parsed.data.source,
    );
  } catch {
    return null;
  }
}

export function catalogTreatmentPinForVersion(
  presetId: TreatmentPresetId,
  version: string,
  source: TreatmentPinSource,
): TreatmentPin | null {
  const preset = treatmentPreset(presetId);
  const supported = preset.versions.some((candidate) => candidate.version === version);
  return supported ? treatmentPinSchema.parse({ kind: "catalog", presetId, version, source }) : null;
}

export function treatmentPresetThaiLabel(pinOrId: TreatmentPin | TreatmentPresetId): string {
  return treatmentPreset(typeof pinOrId === "string" ? pinOrId : pinOrId.presetId).thaiLabel;
}

export function treatmentPromptDirection(pin: TreatmentPin): string {
  const preset = treatmentPreset(pin.presetId);
  const recipe = preset.versions.find((candidate) => candidate.version === pin.version);
  if (!recipe) throw new Error("Unsupported Treatment Preset version");
  return recipe.promptDirection;
}

export function relatedTreatmentPresetIds(presetId: TreatmentPresetId): readonly TreatmentPresetId[] {
  return treatmentPreset(presetId).relatedPresetIds;
}

export function isGenericTreatmentPlaceholder(value: string | null | undefined): boolean {
  return value?.trim() === GENERIC_TREATMENT_PLACEHOLDER;
}
