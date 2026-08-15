-- CreateTable
CREATE TABLE "AdministratorGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT NOT NULL,
    "revokedAt" DATETIME,
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AdministratorGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NorthStarDailySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotDate" TEXT NOT NULL,
    "asOf" DATETIME NOT NULL,
    "activeRecurringPayers" INTEGER NOT NULL,
    "activeCreators" INTEGER NOT NULL,
    "monthlyCreators" INTEGER NOT NULL,
    "annualCreators" INTEGER NOT NULL,
    "videoCreators" INTEGER NOT NULL,
    "scriptCreators" INTEGER NOT NULL,
    "imageCreators" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ConversionTrialAiImageAllowance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "trialStartedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "limitImages" INTEGER NOT NULL DEFAULT 8,
    "reservedImages" INTEGER NOT NULL DEFAULT 0,
    "usedImages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConversionTrialAiImageAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "AiGenerationJob" ADD COLUMN "productSurface" TEXT;

-- MAPC scans only successfully delivered work from approved product surfaces.
CREATE INDEX "AiGenerationJob_productSurface_status_finishedAt_idx" ON "AiGenerationJob"("productSurface", "status", "finishedAt");

-- CreateIndex
CREATE INDEX "AdministratorGrant_userId_revokedAt_expiresAt_idx" ON "AdministratorGrant"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "AdministratorGrant_startsAt_expiresAt_idx" ON "AdministratorGrant"("startsAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NorthStarDailySnapshot_snapshotDate_key" ON "NorthStarDailySnapshot"("snapshotDate");

-- CreateIndex
CREATE INDEX "NorthStarDailySnapshot_asOf_idx" ON "NorthStarDailySnapshot"("asOf");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionTrialAiImageAllowance_userId_key" ON "ConversionTrialAiImageAllowance"("userId");

-- CreateIndex
CREATE INDEX "ConversionTrialAiImageAllowance_trialStartedAt_expiresAt_idx" ON "ConversionTrialAiImageAllowance"("trialStartedAt", "expiresAt");
