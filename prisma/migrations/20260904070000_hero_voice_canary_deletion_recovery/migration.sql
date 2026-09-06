-- Additive Task 4 deletion/recovery schema. Task 2's job/attempt migration is
-- intentionally preserved as a separate earlier migration.
ALTER TABLE "UserVoice" ADD COLUMN "deletionTransactionId" TEXT;
ALTER TABLE "UserVoice" ADD COLUMN "deletionClaimedAt" DATETIME;
CREATE INDEX "UserVoice_deletionTransactionId_idx" ON "UserVoice"("deletionTransactionId");

CREATE TABLE "ReviewRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerHmac" TEXT NOT NULL,
    "runState" TEXT NOT NULL DEFAULT 'planned',
    "state" TEXT NOT NULL DEFAULT 'collecting',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "privateArtifactManifestJson" TEXT,
    "rawScoresJson" TEXT,
    "revealCiphertextJson" TEXT,
    "ledgerSequence" INTEGER NOT NULL DEFAULT 0,
    "ledgerHeadHmac" TEXT,
    "sanitizedAggregatesJson" TEXT,
    "receiptId" TEXT,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ReviewRun_ownerHmac_state_idx" ON "ReviewRun"("ownerHmac", "state");
CREATE INDEX "ReviewRun_receiptId_idx" ON "ReviewRun"("receiptId");

CREATE TABLE "DeletionTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationKind" TEXT NOT NULL,
    "intendedOutcome" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "scopeUserId" TEXT,
    "scopeVoiceId" TEXT,
    "scopeReviewRunId" TEXT,
    "scopeOwnerHmac" TEXT,
    "configurationHmac" TEXT,
    "receiptId" TEXT NOT NULL,
    "receiptJson" TEXT,
    "plannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dbCommittedAt" DATETIME,
    "doneAt" DATETIME,
    "rolledBackAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "DeletionTransaction_receiptId_key" ON "DeletionTransaction"("receiptId");
CREATE INDEX "DeletionTransaction_status_plannedAt_idx" ON "DeletionTransaction"("status", "plannedAt");
CREATE INDEX "DeletionTransaction_scopeUserId_idx" ON "DeletionTransaction"("scopeUserId");
CREATE INDEX "DeletionTransaction_scopeVoiceId_idx" ON "DeletionTransaction"("scopeVoiceId");
CREATE INDEX "DeletionTransaction_scopeReviewRunId_idx" ON "DeletionTransaction"("scopeReviewRunId");
CREATE INDEX "DeletionTransaction_scopeOwnerHmac_idx" ON "DeletionTransaction"("scopeOwnerHmac");

CREATE TABLE "DeletionArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletionTransactionId" TEXT NOT NULL,
    "rootKind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "expectedSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "quarantinedAt" DATETIME,
    "unlinkedAt" DATETIME,
    "restoredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeletionArtifact_deletionTransactionId_fkey"
      FOREIGN KEY ("deletionTransactionId") REFERENCES "DeletionTransaction" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeletionArtifact_deletionTransactionId_rootKind_storageKey_key"
  ON "DeletionArtifact"("deletionTransactionId", "rootKind", "storageKey");
CREATE INDEX "DeletionArtifact_deletionTransactionId_status_idx"
  ON "DeletionArtifact"("deletionTransactionId", "status");
