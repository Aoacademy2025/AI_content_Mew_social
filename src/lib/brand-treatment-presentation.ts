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

export function buildVisualSummary(
  visualFormatLabel: string,
  treatmentLabel: string,
  legacyCustomTreatment = false,
): string {
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
