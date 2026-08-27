-- CreateTable
CREATE TABLE "StoryFilmPresenterAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmPresenterAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmCharacterProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identityNotes" TEXT,
    "activeReferenceSetVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryFilmCharacterProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmCharacterReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "setVersion" INTEGER NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "viewLabel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmCharacterReference_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StoryFilmCharacterProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "presentationMode" TEXT NOT NULL,
    "sourcePackage" TEXT,
    "narrativeSource" TEXT NOT NULL,
    "narrationMasterUrl" TEXT,
    "narrationDurationMs" INTEGER,
    "narrationVoiceId" TEXT,
    "narrationVoiceSpeed" REAL,
    "presenterAssetId" TEXT,
    "characterProfileId" TEXT,
    "characterReferenceSetVersion" INTEGER,
    "characterLookBrief" TEXT,
    "musicSource" TEXT,
    "musicTrackId" TEXT,
    "musicUrl" TEXT,
    "finalRenderUrl" TEXT,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "durationLimitMs" INTEGER NOT NULL DEFAULT 180000,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stage" TEXT NOT NULL DEFAULT 'setup',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generationEpoch" INTEGER NOT NULL DEFAULT 1,
    "awaitingApproval" BOOLEAN NOT NULL DEFAULT true,
    "stageDataJson" TEXT NOT NULL DEFAULT '{}',
    "lastOpenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryFilmProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StoryFilmProject_presenterAssetId_fkey" FOREIGN KEY ("presenterAssetId") REFERENCES "StoryFilmPresenterAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StoryFilmProject_characterProfileId_fkey" FOREIGN KEY ("characterProfileId") REFERENCES "StoryFilmCharacterProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmCharacterLook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "characterProfileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "brief" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmCharacterLook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "StoryFilmProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StoryFilmCharacterLook_characterProfileId_fkey" FOREIGN KEY ("characterProfileId") REFERENCES "StoryFilmCharacterProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmScene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "generationEpoch" INTEGER NOT NULL,
    "sceneKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "sourceExcerpt" TEXT NOT NULL,
    "grokPrompt" TEXT NOT NULL,
    "mediaPlan" TEXT NOT NULL,
    "visualOwner" TEXT NOT NULL DEFAULT 'broll',
    "characterDirectivesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmScene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "StoryFilmProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "stage" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "targetJson" TEXT,
    "instruction" TEXT,
    "resultStage" TEXT NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "StoryFilmProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmGenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "projectRevision" INTEGER NOT NULL,
    "generationEpoch" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "providerBackend" TEXT NOT NULL,
    "sceneKey" TEXT,
    "payloadJson" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "technicalFailureCount" INTEGER NOT NULL DEFAULT 0,
    "providerJobId" TEXT,
    "leaseOwner" TEXT,
    "leaseTokenHash" TEXT,
    "leaseExpiresAt" DATETIME,
    "heartbeatAt" DATETIME,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "finishedAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryFilmGenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "StoryFilmProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryFilmArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "jobId" TEXT,
    "stage" TEXT NOT NULL,
    "projectRevision" INTEGER NOT NULL,
    "generationEpoch" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sceneKey" TEXT,
    "storageUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "StoryFilmProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StoryFilmArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "StoryFilmGenerationJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryFilmPresenterAsset_storageUrl_key" ON "StoryFilmPresenterAsset"("storageUrl");
CREATE INDEX "StoryFilmPresenterAsset_userId_createdAt_idx" ON "StoryFilmPresenterAsset"("userId", "createdAt");
CREATE INDEX "StoryFilmCharacterProfile_userId_updatedAt_idx" ON "StoryFilmCharacterProfile"("userId", "updatedAt");
CREATE UNIQUE INDEX "StoryFilmCharacterReference_storageUrl_key" ON "StoryFilmCharacterReference"("storageUrl");
CREATE INDEX "StoryFilmCharacterReference_profileId_setVersion_createdAt_idx" ON "StoryFilmCharacterReference"("profileId", "setVersion", "createdAt");
CREATE UNIQUE INDEX "StoryFilmProject_userId_idempotencyKey_key" ON "StoryFilmProject"("userId", "idempotencyKey");
CREATE INDEX "StoryFilmProject_userId_updatedAt_idx" ON "StoryFilmProject"("userId", "updatedAt");
CREATE INDEX "StoryFilmProject_userId_status_updatedAt_idx" ON "StoryFilmProject"("userId", "status", "updatedAt");
CREATE INDEX "StoryFilmProject_presenterAssetId_idx" ON "StoryFilmProject"("presenterAssetId");
CREATE INDEX "StoryFilmProject_characterProfileId_idx" ON "StoryFilmProject"("characterProfileId");
CREATE INDEX "StoryFilmProject_stage_status_updatedAt_idx" ON "StoryFilmProject"("stage", "status", "updatedAt");
CREATE UNIQUE INDEX "StoryFilmCharacterLook_projectId_version_key" ON "StoryFilmCharacterLook"("projectId", "version");
CREATE INDEX "StoryFilmCharacterLook_characterProfileId_createdAt_idx" ON "StoryFilmCharacterLook"("characterProfileId", "createdAt");
CREATE UNIQUE INDEX "StoryFilmScene_projectId_generationEpoch_sceneKey_key" ON "StoryFilmScene"("projectId", "generationEpoch", "sceneKey");
CREATE UNIQUE INDEX "StoryFilmScene_projectId_generationEpoch_sequence_key" ON "StoryFilmScene"("projectId", "generationEpoch", "sequence");
CREATE INDEX "StoryFilmScene_projectId_generationEpoch_sequence_idx" ON "StoryFilmScene"("projectId", "generationEpoch", "sequence");
CREATE UNIQUE INDEX "StoryFilmDecision_projectId_revision_key" ON "StoryFilmDecision"("projectId", "revision");
CREATE UNIQUE INDEX "StoryFilmDecision_projectId_idempotencyKey_key" ON "StoryFilmDecision"("projectId", "idempotencyKey");
CREATE INDEX "StoryFilmDecision_projectId_createdAt_idx" ON "StoryFilmDecision"("projectId", "createdAt");
CREATE UNIQUE INDEX "StoryFilmGenerationJob_projectId_idempotencyKey_key" ON "StoryFilmGenerationJob"("projectId", "idempotencyKey");
CREATE INDEX "StoryFilmGenerationJob_status_providerBackend_availableAt_priority_createdAt_idx" ON "StoryFilmGenerationJob"("status", "providerBackend", "availableAt", "priority", "createdAt");
CREATE INDEX "StoryFilmGenerationJob_projectId_stage_status_idx" ON "StoryFilmGenerationJob"("projectId", "stage", "status");
CREATE INDEX "StoryFilmGenerationJob_leaseExpiresAt_status_idx" ON "StoryFilmGenerationJob"("leaseExpiresAt", "status");
CREATE UNIQUE INDEX "StoryFilmArtifact_jobId_key" ON "StoryFilmArtifact"("jobId");
CREATE INDEX "StoryFilmArtifact_projectId_stage_createdAt_idx" ON "StoryFilmArtifact"("projectId", "stage", "createdAt");
CREATE INDEX "StoryFilmArtifact_projectId_sceneKey_createdAt_idx" ON "StoryFilmArtifact"("projectId", "sceneKey", "createdAt");
