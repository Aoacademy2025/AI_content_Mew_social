-- Additive Task 2 durability only. Deletion/review/ledger tables belong to later
-- reviewed tasks and are intentionally absent from this migration.
ALTER TABLE "AiGenerationJob" ADD COLUMN "cancelDisposition" TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE "AiGenerationJob" ADD COLUMN "cancelAttemptedAt" DATETIME;
ALTER TABLE "AiGenerationJob" ADD COLUMN "externalRunDisposition" TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE "AiGenerationJob" ADD COLUMN "reservedAiAudioMinutes" REAL NOT NULL DEFAULT 0;
ALTER TABLE "AiGenerationJob" ADD COLUMN "reservedStudioMinutes" REAL NOT NULL DEFAULT 0;

ALTER TABLE "AiGenerationAttempt" ADD COLUMN "inputJson" TEXT;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "dispatchIntentAt" DATETIME;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "dispatchLeaseExpiresAt" DATETIME;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "submissionDisposition" TEXT NOT NULL DEFAULT 'not_dispatched';
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "providerResponseAt" DATETIME;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "pollFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "nextPollAt" DATETIME;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "pollLeaseToken" TEXT;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "pollLeaseExpiresAt" DATETIME;
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "cancelDisposition" TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE "AiGenerationAttempt" ADD COLUMN "cancelAttemptedAt" DATETIME;
