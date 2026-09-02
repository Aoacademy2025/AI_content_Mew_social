-- AlterTable
ALTER TABLE "Music" ADD COLUMN "mood" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "link" TEXT;

-- CreateTable
CREATE TABLE "TrialReminderLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrialReminderLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ManagedStockUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StockSearchCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "queryKey" TEXT NOT NULL,
    "resultsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
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
    "ttsProvider" TEXT DEFAULT 'gemini',
    "geminiVoiceName" TEXT DEFAULT 'Aoede',
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "planExpiresAt" DATETIME,
    "onboardingDismissedAt" DATETIME,
    "firstClipConvertDismissedAt" DATETIME,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subStatus" TEXT,
    "billingPeriod" TEXT,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelAt" DATETIME,
    "trialStartedAt" DATETIME,
    "trialEndsAt" DATETIME,
    "trialEndedAt" DATETIME,
    "bundleGrantId" TEXT,
    "bundleSubscriptionId" TEXT,
    "bundleAccessExpiresAt" DATETIME,
    "bundleStatus" TEXT,
    "bundleBillingPeriod" TEXT,
    "bundleAmountThb" INTEGER,
    "bundleLastEventId" TEXT,
    "bundleQuotaGrantId" TEXT,
    "bundleCreditsGrantId" TEXT,
    "bundlePrimary" BOOLEAN NOT NULL DEFAULT false,
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
INSERT INTO "new_User" ("affiliateRefCode", "aiAudioMinutesUsed", "aiTextCallsUsed", "avatar", "billingPeriod", "bundleAccessExpiresAt", "bundleAmountThb", "bundleBillingPeriod", "bundleCreditsGrantId", "bundleGrantId", "bundleLastEventId", "bundlePrimary", "bundleQuotaGrantId", "bundleStatus", "bundleSubscriptionId", "cancelAt", "cancelAtPeriodEnd", "clerkId", "createdAt", "elevenlabsKey", "elevenlabsVoiceId", "email", "flickrKey", "geminiKey", "geminiKeyMode", "geminiVoiceName", "googleId", "heygenAvatarId", "heygenAvatarsCache", "heygenAvatarsCachedAt", "heygenKey", "id", "image", "kieKey", "minutesLimit", "minutesUsed", "name", "onboardingDismissedAt", "openaiKey", "password", "pexelsKey", "pixabayKey", "plan", "planExpiresAt", "resetExpires", "resetToken", "role", "stripeCustomerId", "stripeSubscriptionId", "subStatus", "suspended", "trialEndsAt", "trialStartedAt", "ttsProvider", "unsplashKey", "updatedAt", "usageCount", "usageLimit", "usagePeriodStartedAt") SELECT "affiliateRefCode", "aiAudioMinutesUsed", "aiTextCallsUsed", "avatar", "billingPeriod", "bundleAccessExpiresAt", "bundleAmountThb", "bundleBillingPeriod", "bundleCreditsGrantId", "bundleGrantId", "bundleLastEventId", "bundlePrimary", "bundleQuotaGrantId", "bundleStatus", "bundleSubscriptionId", "cancelAt", "cancelAtPeriodEnd", "clerkId", "createdAt", "elevenlabsKey", "elevenlabsVoiceId", "email", "flickrKey", "geminiKey", "geminiKeyMode", "geminiVoiceName", "googleId", "heygenAvatarId", "heygenAvatarsCache", "heygenAvatarsCachedAt", "heygenKey", "id", "image", "kieKey", "minutesLimit", "minutesUsed", "name", "onboardingDismissedAt", "openaiKey", "password", "pexelsKey", "pixabayKey", "plan", "planExpiresAt", "resetExpires", "resetToken", "role", "stripeCustomerId", "stripeSubscriptionId", "subStatus", "suspended", "trialEndsAt", "trialStartedAt", "ttsProvider", "unsplashKey", "updatedAt", "usageCount", "usageLimit", "usagePeriodStartedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
CREATE TABLE "new_VideoJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "contentPreflightId" TEXT,
    "projectVisualContextJson" TEXT,
    "brandVisualAcceptanceJson" TEXT,
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
    "fundingState" TEXT NOT NULL DEFAULT 'none',
    "fundedMeteredMinutes" INTEGER,
    "fundedCreditsSpent" INTEGER,
    "fundedCreditsFromGranted" INTEGER,
    "fundedCreditsFromPromotional" INTEGER,
    "fundedCreditFundingJson" TEXT,
    "fundedCreditBalanceAfter" INTEGER,
    "walletFundingAuthorized" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "VideoJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VideoJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditorProject" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_VideoJob" ("brandVisualAcceptanceJson", "contentPreflightId", "createdAt", "currentStep", "errorCode", "errorMessage", "errorProvider", "finishedAt", "fundedCreditFundingJson", "fundedCreditsFromPromotional", "id", "idempotencyFingerprint", "idempotencyKey", "inputJson", "mediaExpiresAt", "outputJson", "progress", "projectId", "projectVisualContextJson", "providerCheckpointJson", "providerNextPollAt", "reservationRefundAttempts", "reservationRefundPending", "reservationRefundReason", "startedAt", "status", "type", "updatedAt", "userId", "videoId") SELECT "brandVisualAcceptanceJson", "contentPreflightId", "createdAt", "currentStep", "errorCode", "errorMessage", "errorProvider", "finishedAt", "fundedCreditFundingJson", "fundedCreditsFromPromotional", "id", "idempotencyFingerprint", "idempotencyKey", "inputJson", "mediaExpiresAt", "outputJson", "progress", "projectId", "projectVisualContextJson", "providerCheckpointJson", "providerNextPollAt", "reservationRefundAttempts", "reservationRefundPending", "reservationRefundReason", "startedAt", "status", "type", "updatedAt", "userId", "videoId" FROM "VideoJob";
DROP TABLE "VideoJob";
ALTER TABLE "new_VideoJob" RENAME TO "VideoJob";
CREATE INDEX "VideoJob_status_idx" ON "VideoJob"("status");
CREATE INDEX "VideoJob_userId_idx" ON "VideoJob"("userId");
CREATE INDEX "VideoJob_projectId_idx" ON "VideoJob"("projectId");
CREATE INDEX "VideoJob_contentPreflightId_idx" ON "VideoJob"("contentPreflightId");
CREATE INDEX "VideoJob_createdAt_idx" ON "VideoJob"("createdAt");
CREATE INDEX "VideoJob_mediaExpiresAt_idx" ON "VideoJob"("mediaExpiresAt");
CREATE UNIQUE INDEX "VideoJob_userId_idempotencyKey_key" ON "VideoJob"("userId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TrialReminderLog_kind_sentAt_idx" ON "TrialReminderLog"("kind", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrialReminderLog_userId_kind_key" ON "TrialReminderLog"("userId", "kind");

-- CreateIndex
CREATE INDEX "ManagedStockUsage_periodKey_idx" ON "ManagedStockUsage"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedStockUsage_provider_periodKey_key" ON "ManagedStockUsage"("provider", "periodKey");

-- CreateIndex
CREATE INDEX "StockSearchCache_expiresAt_idx" ON "StockSearchCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockSearchCache_provider_queryKey_key" ON "StockSearchCache"("provider", "queryKey");
