import {
  TREATMENT_PRESETS,
  relatedTreatmentPresetIds,
  type TreatmentPresetId,
} from "@/lib/brand-treatment-catalog";

export type TreatmentChoice = {
  id: TreatmentPresetId;
  label: string;
  role: "recommended" | "alternative" | "catalog";
};

export function buildTreatmentChoiceGroups(
  primary: TreatmentPresetId,
  ranked: readonly TreatmentPresetId[],
): { featured: TreatmentChoice[]; all: TreatmentChoice[] } {
  const orderedIds = [...new Set([
    primary,
    ...ranked,
    ...relatedTreatmentPresetIds(primary),
  ])].slice(0, 3);
  const featured = orderedIds.map((id, index) => ({
    id,
    label: TREATMENT_PRESETS.find((preset) => preset.id === id)!.thaiLabel,
    role: index === 0 ? "recommended" as const : "alternative" as const,
  }));
  const all = TREATMENT_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.thaiLabel,
    role: orderedIds.includes(preset.id) ? featured[orderedIds.indexOf(preset.id)]!.role : "catalog" as const,
  }));
  return { featured, all };
}

/** One line for "what does this clip look like". When the look came from a
 * ready-made style, that style's own Thai name IS the answer — spelling out the
 * image format and the narrative style underneath it would only repeat, in
 * system vocabulary, what the style already says in the creator's. The suffix
 * answers the question the creator asks next: is this clip's own choice, or the
 * brand's — i.e. would changing it here affect every other clip. */
export function buildVisualSummary(
  visualFormatLabel: string,
  treatmentLabel: string,
  legacyCustomTreatment = false,
  stylePack?: { thaiLabel: string; source: "project" | "brand" } | null,
): string {
  if (stylePack) {
    return `${stylePack.thaiLabel} · ${stylePack.source === "project" ? "จากคลิปนี้" : "จากแบรนด์"}`;
  }
  const compactFormatLabel = visualFormatLabel === "ภาพสมจริงแบบหนัง"
    ? "คนสมจริง"
    : visualFormatLabel;
  return `${compactFormatLabel} · ${legacyCustomTreatment ? "ใช้แนวที่ตั้งไว้เดิม" : treatmentLabel}`;
}

export function lookChangeConfirmation(existingImageCount: number, creditsPerImage: number) {
  return {
    code: "LOOK_CHANGE_CONFIRMATION_REQUIRED" as const,
    existingImageCount,
    quotedCredits: existingImageCount * creditsPerImage,
    options: [{ id: "regenerate-all" as const, label: "สร้างทุกภาพใหม่ให้เป็นแนวเดียวกัน" }],
  };
}
