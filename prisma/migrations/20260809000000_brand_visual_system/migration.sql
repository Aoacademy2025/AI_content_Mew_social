-- Brand Visual System V1 is deliberately additive. Existing BrandProfile,
-- EditorProject and AiGenerationJob rows remain byte-for-byte intact while
-- the new revision, preflight and entitlement records start empty.
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;

ALTER TABLE "BrandProfile" ADD COLUMN "activeRevisionNumber" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BrandProfile" ADD COLUMN "frozenAt" DATETIME;
ALTER TABLE "BrandProfile" ADD COLUMN "lastUsedAt" DATETIME;
CREATE INDEX "BrandProfile_userId_frozenAt_updatedAt_idx"
  ON "BrandProfile"("userId", "frozenAt", "updatedAt");

CREATE TABLE "BrandProfileDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "brandProfileId" TEXT NOT NULL,
  "baseRevisionNumber" INTEGER NOT NULL DEFAULT 0,
  "payloadJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "BrandProfileDraft_brandProfileId_fkey"
    FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BrandProfileDraft_brandProfileId_key"
  ON "BrandProfileDraft"("brandProfileId");

CREATE TABLE "BrandProfileRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "brandProfileId" TEXT NOT NULL,
  "sourceVideoJobId" TEXT,
  "sourcePreflightId" TEXT,
  "version" INTEGER NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "visualRecipeJson" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandProfileRevision_brandProfileId_fkey"
    FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BrandProfileRevision_brandProfileId_createdAt_idx"
  ON "BrandProfileRevision"("brandProfileId", "createdAt");
CREATE UNIQUE INDEX "BrandProfileRevision_brandProfileId_version_key"
  ON "BrandProfileRevision"("brandProfileId", "version");
CREATE UNIQUE INDEX "BrandProfileRevision_sourceVideoJobId_key"
  ON "BrandProfileRevision"("sourceVideoJobId");
CREATE UNIQUE INDEX "BrandProfileRevision_sourcePreflightId_key"
  ON "BrandProfileRevision"("sourcePreflightId");

ALTER TABLE "EditorProject" ADD COLUMN "brandProfileRevisionId" TEXT
  REFERENCES "BrandProfileRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EditorProject" ADD COLUMN "projectLookJson" TEXT;
ALTER TABLE "EditorProject" ADD COLUMN "projectLookUpdatedAt" DATETIME;
CREATE INDEX "EditorProject_brandProfileRevisionId_idx"
  ON "EditorProject"("brandProfileRevisionId");

ALTER TABLE "VideoJob" ADD COLUMN "contentPreflightId" TEXT;
ALTER TABLE "VideoJob" ADD COLUMN "projectVisualContextJson" TEXT;
ALTER TABLE "VideoJob" ADD COLUMN "brandVisualAcceptanceJson" TEXT;
CREATE INDEX "VideoJob_contentPreflightId_idx"
  ON "VideoJob"("contentPreflightId");

CREATE TABLE "ContentPreflight" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "narrativeSourceKind" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "analyzerVersion" TEXT NOT NULL,
  "contentDomain" TEXT NOT NULL,
  "suggestedVisualFormatId" TEXT NOT NULL,
  "suggestedTreatmentJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ContentPreflight_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ContentPreflight_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "EditorProject"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ContentPreflight_userId_createdAt_idx"
  ON "ContentPreflight"("userId", "createdAt");
CREATE INDEX "ContentPreflight_projectId_updatedAt_idx"
  ON "ContentPreflight"("projectId", "updatedAt");
CREATE UNIQUE INDEX "ContentPreflight_projectId_sourceHash_analyzerVersion_key"
  ON "ContentPreflight"("projectId", "sourceHash", "analyzerVersion");

CREATE TABLE "ProjectVisualBeat" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "preflightId" TEXT NOT NULL,
  "beatKey" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "startMs" INTEGER,
  "endMs" INTEGER,
  "sourceExcerptHash" TEXT NOT NULL,
  "beatJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'current',
  "existingAssetUrl" TEXT,
  "existingImageJobId" TEXT,
  "generationIdentityKey" TEXT,
  "outdatedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProjectVisualBeat_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectVisualBeat_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "EditorProject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectVisualBeat_preflightId_fkey"
    FOREIGN KEY ("preflightId") REFERENCES "ContentPreflight"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectVisualBeat_projectId_status_sequence_idx"
  ON "ProjectVisualBeat"("projectId", "status", "sequence");
CREATE INDEX "ProjectVisualBeat_existingImageJobId_idx"
  ON "ProjectVisualBeat"("existingImageJobId");
CREATE UNIQUE INDEX "ProjectVisualBeat_preflightId_beatKey_key"
  ON "ProjectVisualBeat"("preflightId", "beatKey");

ALTER TABLE "AiGenerationJob" ADD COLUMN "fundingSource" TEXT NOT NULL DEFAULT 'credits';
ALTER TABLE "AiGenerationJob" ADD COLUMN "allowanceUnits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiGenerationJob" ADD COLUMN "allowanceWindowStartedAt" DATETIME;

CREATE TABLE "BrandLookPreviewBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "projectId" TEXT,
  "brandProfileId" TEXT,
  "brandProfileDraftId" TEXT,
  "brandProfileRevisionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "sourceSnapshotJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "finishedAt" DATETIME,
  CONSTRAINT "BrandLookPreviewBatch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BrandLookPreviewBatch_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "EditorProject"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BrandLookPreviewBatch_brandProfileId_fkey"
    FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BrandLookPreviewBatch_brandProfileDraftId_fkey"
    FOREIGN KEY ("brandProfileDraftId") REFERENCES "BrandProfileDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BrandLookPreviewBatch_brandProfileRevisionId_fkey"
    FOREIGN KEY ("brandProfileRevisionId") REFERENCES "BrandProfileRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "BrandLookPreviewBatch_userId_createdAt_idx"
  ON "BrandLookPreviewBatch"("userId", "createdAt");
CREATE UNIQUE INDEX "BrandLookPreviewBatch_userId_requestId_key"
  ON "BrandLookPreviewBatch"("userId", "requestId");
CREATE INDEX "BrandLookPreviewBatch_projectId_createdAt_idx"
  ON "BrandLookPreviewBatch"("projectId", "createdAt");
CREATE INDEX "BrandLookPreviewBatch_brandProfileId_createdAt_idx"
  ON "BrandLookPreviewBatch"("brandProfileId", "createdAt");
CREATE INDEX "BrandLookPreviewBatch_status_updatedAt_idx"
  ON "BrandLookPreviewBatch"("status", "updatedAt");

CREATE TABLE "BrandLookPreviewItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batchId" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "aiGenerationJobId" TEXT,
  "outputUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "BrandLookPreviewItem_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "BrandLookPreviewBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BrandLookPreviewItem_aiGenerationJobId_fkey"
    FOREIGN KEY ("aiGenerationJobId") REFERENCES "AiGenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BrandLookPreviewItem_aiGenerationJobId_key"
  ON "BrandLookPreviewItem"("aiGenerationJobId");
CREATE INDEX "BrandLookPreviewItem_batchId_status_idx"
  ON "BrandLookPreviewItem"("batchId", "status");
CREATE INDEX "BrandLookPreviewItem_status_updatedAt_idx"
  ON "BrandLookPreviewItem"("status", "updatedAt");
CREATE UNIQUE INDEX "BrandLookPreviewItem_batchId_phase_key"
  ON "BrandLookPreviewItem"("batchId", "phase");

CREATE TABLE "StarterAiImageAllowance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "windowStartedAt" DATETIME NOT NULL,
  "limitImages" INTEGER NOT NULL DEFAULT 8,
  "reservedImages" INTEGER NOT NULL DEFAULT 0,
  "usedImages" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "StarterAiImageAllowance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StarterAiImageAllowance_userId_windowStartedAt_key"
  ON "StarterAiImageAllowance"("userId", "windowStartedAt");
CREATE INDEX "StarterAiImageAllowance_userId_windowStartedAt_idx"
  ON "StarterAiImageAllowance"("userId", "windowStartedAt");

COMMIT;
