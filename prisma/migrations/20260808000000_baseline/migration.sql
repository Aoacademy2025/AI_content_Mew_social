-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clerkId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "googleId" TEXT,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "usageLimit" INTEGER NOT NULL DEFAULT 2,
    "usagePeriodStartedAt" DATETIME,
    "openaiKey" TEXT,
    "geminiKey" TEXT,
    "heygenKey" TEXT,
    "elevenlabsKey" TEXT,
    "pexelsKey" TEXT,
    "pixabayKey" TEXT,
    "kieKey" TEXT,
    "unsplashKey" TEXT,
    "flickrKey" TEXT,
    "avatar" TEXT,
    "heygenAvatarId" TEXT,
    "heygenAvatarsCache" TEXT,
    "heygenAvatarsCachedAt" DATETIME,
    "elevenlabsVoiceId" TEXT,
    "ttsProvider" TEXT DEFAULT 'elevenlabs',
    "geminiVoiceName" TEXT DEFAULT 'Aoede',
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "planExpiresAt" DATETIME,
    "onboardingDismissedAt" DATETIME,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subStatus" TEXT,
    "billingPeriod" TEXT,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelAt" DATETIME,
    "trialStartedAt" DATETIME,
    "trialEndsAt" DATETIME,
    "minutesUsed" REAL NOT NULL DEFAULT 0,
    "minutesLimit" INTEGER NOT NULL DEFAULT 0,
    "aiAudioMinutesUsed" REAL NOT NULL DEFAULT 0,
    "aiTextCallsUsed" REAL NOT NULL DEFAULT 0,
    "geminiKeyMode" TEXT NOT NULL DEFAULT 'byok',
    "affiliateRefCode" TEXT,
    "resetToken" TEXT,
    "resetExpires" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Style" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sampleText" TEXT,
    "sampleUrl" TEXT,
    "instructionPrompt" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Style_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Content" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceText" TEXT,
    "sourceUrl" TEXT,
    "styleId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'TH',
    "imageModel" TEXT DEFAULT 'nanobanana',
    "videoDuration" INTEGER,
    "headline" TEXT,
    "subheadline" TEXT,
    "body" TEXT,
    "hashtags" TEXT,
    "imagePrompt" TEXT,
    "visualNotes" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Content_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contentId" TEXT,
    "projectId" TEXT,
    "avatarModel" TEXT NOT NULL,
    "voiceModel" TEXT NOT NULL,
    "imageModel" TEXT,
    "sceneCount" INTEGER NOT NULL,
    "script" TEXT,
    "sceneMapping" TEXT,
    "generatedImages" TEXT,
    "audioUrl" TEXT,
    "videoUrl" TEXT,
    "avatarVideoUrl" TEXT,
    "thumbnail" TEXT,
    "thumbnailConfig" TEXT,
    "renderConfig" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    CONSTRAINT "Video_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Video_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditorProject" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Video_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AvatarPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "avatarId" TEXT NOT NULL,
    "scale" REAL NOT NULL DEFAULT 1,
    "offsetX" REAL NOT NULL DEFAULT 0,
    "offsetY" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AvatarPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EditorProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New Project',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "draftJson" TEXT,
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "activeJobId" TEXT,
    "activeExportJobId" TEXT,
    "latestVideoId" TEXT,
    "lastOpenedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EditorProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrandAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "retiredAt" DATETIME,
    "lifecycleRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrandAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BrandAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditorProject" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrandPreference" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "defaultAssetId" TEXT NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'top-right',
    "sizePct" REAL NOT NULL DEFAULT 18,
    "opacity" REAL NOT NULL DEFAULT 0.9,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrandPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BrandPreference_defaultAssetId_fkey" FOREIGN KEY ("defaultAssetId") REFERENCES "BrandAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EditorStylePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "brandAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EditorStylePreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EditorStylePreset_brandAssetId_fkey" FOREIGN KEY ("brandAssetId") REFERENCES "BrandAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrandProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "bannedWords" TEXT NOT NULL DEFAULT '[]',
    "ctaStyle" TEXT NOT NULL DEFAULT 'follow',
    "language" TEXT NOT NULL DEFAULT 'th',
    "sampleText" TEXT,
    "sampleUrl" TEXT,
    "analysisNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrandProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "brandProfileId" TEXT,
    "topic" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 60,
    "hookFormula" TEXT,
    "structure" TEXT,
    "hookText" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "ctaText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "editorProjectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Script_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Script_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScriptGenerationUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "expiresAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScriptGenerationUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VideoJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "videoId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'create',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "currentStep" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "inputJson" TEXT NOT NULL,
    "outputJson" TEXT,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "errorProvider" TEXT,
    "reservationRefundPending" BOOLEAN NOT NULL DEFAULT false,
    "reservationRefundReason" TEXT,
    "reservationRefundAttempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "idempotencyFingerprint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "mediaExpiresAt" DATETIME,
    "providerCheckpointJson" TEXT,
    "providerNextPollAt" DATETIME,
    CONSTRAINT "VideoJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VideoJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditorProject" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ToolCallAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "toolName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "requestJson" TEXT,
    "responseJson" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT,
    "category" TEXT NOT NULL DEFAULT 'IMPROVEMENT',
    "importance" TEXT NOT NULL DEFAULT 'BANNER',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "targetPath" TEXT,
    "ctaLabel" TEXT,
    "ctaHref" TEXT,
    "imageUrl" TEXT,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductUpdateRead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "updateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductUpdateRead_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "ProductUpdate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductUpdateRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "imageBase64" TEXT,
    "imageName" TEXT,
    "imageMimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "adminReply" TEXT,
    "category" TEXT,
    "severity" TEXT,
    "recommendedAction" TEXT,
    "auditNote" TEXT,
    "impactNote" TEXT,
    "auditedAt" DATETIME,
    "repliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'PRO',
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME,
    "type" TEXT NOT NULL DEFAULT 'GRANT',
    "percentOff" INTEGER,
    "discountDuration" TEXT,
    "stripeCouponId" TEXT,
    "stripePromotionCodeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redeemedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FoundingReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME,
    "releasedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "stripePaymentIntent" TEXT,
    "plan" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'thb',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "periodDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recordedBy" TEXT,
    CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TelemetryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "sessionId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'product',
    "source" TEXT NOT NULL DEFAULT 'client',
    "path" TEXT,
    "step" TEXT,
    "status" TEXT,
    "durationMs" INTEGER,
    "value" REAL,
    "properties" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelemetryEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteConfig" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MediaObject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "area" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "remoteFilename" TEXT,
    "r2Etag" TEXT,
    "remoteState" TEXT NOT NULL DEFAULT 'none',
    "localState" TEXT NOT NULL DEFAULT 'present',
    "localMtimeMs" BIGINT,
    "producedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" DATETIME,
    "nextRetryAt" DATETIME,
    "lastErrorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Music" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "duration" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserMusic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "duration" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserMusic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GeneratedImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "imageModel" TEXT NOT NULL,
    "sceneTitle" TEXT,
    "contentTitle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneratedImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiGenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "providerModel" TEXT,
    "providerRoute" TEXT,
    "providerEndpoint" TEXT,
    "quoteVersion" TEXT,
    "costBudgetUsdMicros" INTEGER,
    "estimatedCostUsdMicros" INTEGER,
    "providerReportedCostUsdMicros" INTEGER,
    "providerReportedCredits" REAL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "inputPreview" TEXT,
    "inputJson" TEXT,
    "outputUrl" TEXT,
    "providerJobId" TEXT,
    "generatedImageId" TEXT,
    "creditCost" INTEGER NOT NULL DEFAULT 0,
    "creditsFromGranted" INTEGER NOT NULL DEFAULT 0,
    "creditsFromPurchased" INTEGER NOT NULL DEFAULT 0,
    "chargeState" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "delayTimeMs" INTEGER,
    "executionTimeMs" INTEGER,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "mediaExpiresAt" DATETIME,
    CONSTRAINT "AiGenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiGenerationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerModel" TEXT NOT NULL,
    "providerRoute" TEXT NOT NULL,
    "providerEndpoint" TEXT,
    "providerJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "estimatedCostUsdMicros" INTEGER NOT NULL,
    "providerReportedCostUsdMicros" INTEGER,
    "providerReportedCredits" REAL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "AiGenerationAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiGenerationJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunpodBillingBucket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "bucketStart" DATETIME NOT NULL,
    "gpuTypeId" TEXT NOT NULL,
    "amountUsdMicros" INTEGER NOT NULL,
    "timeBilledMs" INTEGER NOT NULL,
    "syncedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RunpodBillingSync" (
    "endpointId" TEXT NOT NULL PRIMARY KEY,
    "lastWindowStart" DATETIME NOT NULL,
    "lastWindowEnd" DATETIME NOT NULL,
    "lastSuccessAt" DATETIME,
    "rowsSeen" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ChargedClip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "outputUrl" TEXT NOT NULL,
    "chargedMinutes" INTEGER,
    "creditsSpent" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CreditBalance" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "granted" INTEGER NOT NULL DEFAULT 0,
    "purchased" INTEGER NOT NULL DEFAULT 0,
    "grantedResetAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT,
    "balanceAfter" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "videoId" TEXT,
    "parentJobId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "payload" TEXT NOT NULL,
    "progress" REAL NOT NULL DEFAULT 0,
    "phase" TEXT,
    "heartbeatAt" DATETIME,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "reservedQuota" BOOLEAN NOT NULL DEFAULT false,
    "reservedMinutes" INTEGER,
    "creditsSpent" INTEGER,
    "creditsFromGranted" INTEGER,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "scopeKey" TEXT,
    "videoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "UsedTrialEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Video_projectId_idx" ON "Video"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpToken_userId_idx" ON "McpToken"("userId");

-- CreateIndex
CREATE INDEX "AvatarPreset_userId_idx" ON "AvatarPreset"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AvatarPreset_userId_avatarId_key" ON "AvatarPreset"("userId", "avatarId");

-- CreateIndex
CREATE INDEX "EditorProject_userId_updatedAt_idx" ON "EditorProject"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "EditorProject_userId_status_updatedAt_idx" ON "EditorProject"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "EditorProject_activeJobId_idx" ON "EditorProject"("activeJobId");

-- CreateIndex
CREATE INDEX "EditorProject_activeExportJobId_idx" ON "EditorProject"("activeExportJobId");

-- CreateIndex
CREATE INDEX "EditorProject_latestVideoId_idx" ON "EditorProject"("latestVideoId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandAsset_storageKey_key" ON "BrandAsset"("storageKey");

-- CreateIndex
CREATE INDEX "BrandAsset_userId_createdAt_idx" ON "BrandAsset"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BrandAsset_projectId_idx" ON "BrandAsset"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandPreference_defaultAssetId_key" ON "BrandPreference"("defaultAssetId");

-- CreateIndex
CREATE INDEX "EditorStylePreset_userId_kind_updatedAt_idx" ON "EditorStylePreset"("userId", "kind", "updatedAt");

-- CreateIndex
CREATE INDEX "EditorStylePreset_brandAssetId_idx" ON "EditorStylePreset"("brandAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "EditorStylePreset_userId_kind_nameKey_key" ON "EditorStylePreset"("userId", "kind", "nameKey");

-- CreateIndex
CREATE INDEX "BrandProfile_userId_idx" ON "BrandProfile"("userId");

-- CreateIndex
CREATE INDEX "Script_userId_createdAt_idx" ON "Script"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ScriptGenerationUsage_userId_bucket_createdAt_idx" ON "ScriptGenerationUsage"("userId", "bucket", "createdAt");

-- CreateIndex
CREATE INDEX "ScriptGenerationUsage_status_expiresAt_idx" ON "ScriptGenerationUsage"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptGenerationUsage_userId_bucket_slot_key" ON "ScriptGenerationUsage"("userId", "bucket", "slot");

-- CreateIndex
CREATE INDEX "VideoJob_status_idx" ON "VideoJob"("status");

-- CreateIndex
CREATE INDEX "VideoJob_userId_idx" ON "VideoJob"("userId");

-- CreateIndex
CREATE INDEX "VideoJob_projectId_idx" ON "VideoJob"("projectId");

-- CreateIndex
CREATE INDEX "VideoJob_createdAt_idx" ON "VideoJob"("createdAt");

-- CreateIndex
CREATE INDEX "VideoJob_mediaExpiresAt_idx" ON "VideoJob"("mediaExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VideoJob_userId_idempotencyKey_key" ON "VideoJob"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ToolCallAudit_userId_idx" ON "ToolCallAudit"("userId");

-- CreateIndex
CREATE INDEX "ToolCallAudit_toolName_createdAt_idx" ON "ToolCallAudit"("toolName", "createdAt");

-- CreateIndex
CREATE INDEX "ProductUpdate_state_publishedAt_idx" ON "ProductUpdate"("state", "publishedAt");

-- CreateIndex
CREATE INDEX "ProductUpdate_category_publishedAt_idx" ON "ProductUpdate"("category", "publishedAt");

-- CreateIndex
CREATE INDEX "ProductUpdate_isPinned_publishedAt_idx" ON "ProductUpdate"("isPinned", "publishedAt");

-- CreateIndex
CREATE INDEX "ProductUpdateRead_userId_readAt_idx" ON "ProductUpdateRead"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductUpdateRead_updateId_userId_key" ON "ProductUpdateRead"("updateId", "userId");

-- CreateIndex
CREATE INDEX "SupportTicket_status_createdAt_idx" ON "SupportTicket"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_userId_key" ON "CouponRedemption"("couponId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FoundingReservation_stripeSessionId_key" ON "FoundingReservation"("stripeSessionId");

-- CreateIndex
CREATE INDEX "FoundingReservation_userId_idx" ON "FoundingReservation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripeSessionId_key" ON "Payment"("stripeSessionId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "TelemetryEvent_createdAt_idx" ON "TelemetryEvent"("createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_name_createdAt_idx" ON "TelemetryEvent"("name", "createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_category_createdAt_idx" ON "TelemetryEvent"("category", "createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_step_createdAt_idx" ON "TelemetryEvent"("step", "createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_userId_createdAt_idx" ON "TelemetryEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TelemetryEvent_sessionId_createdAt_idx" ON "TelemetryEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaObject_objectKey_key" ON "MediaObject"("objectKey");

-- CreateIndex
CREATE INDEX "MediaObject_remoteState_nextRetryAt_idx" ON "MediaObject"("remoteState", "nextRetryAt");

-- CreateIndex
CREATE INDEX "MediaObject_localState_producedAt_idx" ON "MediaObject"("localState", "producedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaObject_area_filename_key" ON "MediaObject"("area", "filename");

-- CreateIndex
CREATE UNIQUE INDEX "UserMusic_filename_key" ON "UserMusic"("filename");

-- CreateIndex
CREATE INDEX "UserMusic_userId_createdAt_idx" ON "UserMusic"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiGenerationJob_userId_createdAt_idx" ON "AiGenerationJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiGenerationJob_providerJobId_idx" ON "AiGenerationJob"("providerJobId");

-- CreateIndex
CREATE INDEX "AiGenerationJob_status_kind_idx" ON "AiGenerationJob"("status", "kind");

-- CreateIndex
CREATE INDEX "AiGenerationJob_mediaExpiresAt_idx" ON "AiGenerationJob"("mediaExpiresAt");

-- CreateIndex
CREATE INDEX "AiGenerationJob_kind_chargeState_updatedAt_idx" ON "AiGenerationJob"("kind", "chargeState", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiGenerationJob_userId_idempotencyKey_key" ON "AiGenerationJob"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AiGenerationAttempt_provider_providerJobId_idx" ON "AiGenerationAttempt"("provider", "providerJobId");

-- CreateIndex
CREATE INDEX "AiGenerationAttempt_status_createdAt_idx" ON "AiGenerationAttempt"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiGenerationAttempt_jobId_sequence_key" ON "AiGenerationAttempt"("jobId", "sequence");

-- CreateIndex
CREATE INDEX "RunpodBillingBucket_endpointId_bucketStart_idx" ON "RunpodBillingBucket"("endpointId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "RunpodBillingBucket_endpointId_bucketStart_gpuTypeId_key" ON "RunpodBillingBucket"("endpointId", "bucketStart", "gpuTypeId");

-- CreateIndex
CREATE INDEX "ChargedClip_userId_outputUrl_idx" ON "ChargedClip"("userId", "outputUrl");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_idempotencyKey_key" ON "RenderJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RenderJob_status_type_idx" ON "RenderJob"("status", "type");

-- CreateIndex
CREATE INDEX "RenderJob_userId_createdAt_idx" ON "RenderJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJob_parentJobId_idx" ON "RenderJob"("parentJobId");

-- CreateIndex
CREATE INDEX "RenderJob_scopeKey_status_idx" ON "RenderJob"("scopeKey", "status");

-- CreateIndex
CREATE INDEX "RenderJob_createdAt_idx" ON "RenderJob"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsedTrialEmail_emailHash_key" ON "UsedTrialEmail"("emailHash");
