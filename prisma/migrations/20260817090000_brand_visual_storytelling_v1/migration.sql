-- Brand Visual storytelling V1 extends the existing preflight additively.
-- Nullable/defaulted columns keep every pre-V1 row readable while new analyzer
-- versions write the closed catalog and one structured visual plan.
ALTER TABLE "ContentPreflight" ADD COLUMN "dominantNarrativeMode" TEXT;
ALTER TABLE "ContentPreflight" ADD COLUMN "suggestedTreatmentPresetId" TEXT;
ALTER TABLE "ContentPreflight" ADD COLUMN "suggestedTreatmentPresetVersion" TEXT;
ALTER TABLE "ContentPreflight" ADD COLUMN "rankedTreatmentPresetIdsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ContentPreflight" ADD COLUMN "treatmentRecommendationRationale" TEXT;
ALTER TABLE "ContentPreflight" ADD COLUMN "storyEntitiesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ContentPreflight" ADD COLUMN "formatRecommendationJson" TEXT;

ALTER TABLE "EditorProject" ADD COLUMN "treatmentPresetId" TEXT;
ALTER TABLE "EditorProject" ADD COLUMN "treatmentPresetVersion" TEXT;
ALTER TABLE "EditorProject" ADD COLUMN "treatmentPinSource" TEXT;
ALTER TABLE "EditorProject" ADD COLUMN "treatmentPinnedAt" DATETIME;
CREATE INDEX "EditorProject_treatmentPresetId_treatmentPresetVersion_idx"
  ON "EditorProject"("treatmentPresetId", "treatmentPresetVersion");
