-- Additive Task 5 bounded harness/review schema. Task 2 and Task 4 migrations
-- remain separate and ordered before this migration.
ALTER TABLE "ReviewRun" ADD COLUMN "experimentId" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "slotManifestSha256" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "slotManifestJson" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "referenceVoiceId" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "inFlightSlotId" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "parkDisposition" TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE "ReviewRun" ADD COLUMN "publicReviewJson" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "reviewPreparationJson" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "revealCiphertextSha256" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "scoreSheetHmac" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitRepositoryNodeId" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitCanonicalUrl" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitRef" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitCommitSha" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitBlobOid" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitCommitmentPath" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "gitBlobSha256" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "evaluatorEvidenceJson" TEXT;
ALTER TABLE "ReviewRun" ADD COLUMN "costEvidenceJson" TEXT;
CREATE UNIQUE INDEX "ReviewRun_experimentId_key" ON "ReviewRun"("experimentId");
CREATE INDEX "ReviewRun_runState_createdAt_idx" ON "ReviewRun"("runState", "createdAt");

CREATE TABLE "CanaryLedgerRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "ownerHmac" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "recordJson" TEXT NOT NULL,
  "recordHmac" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CanaryLedgerRecord_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ReviewRun" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanaryLedgerRecord_runId_sequence_key"
  ON "CanaryLedgerRecord"("runId", "sequence");
CREATE INDEX "CanaryLedgerRecord_ownerHmac_runId_idx"
  ON "CanaryLedgerRecord"("ownerHmac", "runId");

CREATE TABLE "CanarySubmitNonce" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "ownerHmac" TEXT NOT NULL,
  "slotId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "slotManifestSha256" TEXT NOT NULL,
  "nonceSha256" TEXT NOT NULL,
  "issuedAtMs" BIGINT NOT NULL,
  "expiresAtMs" BIGINT NOT NULL,
  "usedAt" DATETIME,
  "jobId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CanarySubmitNonce_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ReviewRun" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanarySubmitNonce_nonceSha256_key" ON "CanarySubmitNonce"("nonceSha256");
CREATE UNIQUE INDEX "CanarySubmitNonce_jobId_key" ON "CanarySubmitNonce"("jobId");
CREATE UNIQUE INDEX "CanarySubmitNonce_runId_slotId_key" ON "CanarySubmitNonce"("runId", "slotId");
CREATE INDEX "CanarySubmitNonce_runId_usedAt_expiresAtMs_idx"
  ON "CanarySubmitNonce"("runId", "usedAt", "expiresAtMs");
CREATE INDEX "CanarySubmitNonce_ownerHmac_runId_idx" ON "CanarySubmitNonce"("ownerHmac", "runId");

CREATE TABLE "CanaryObjectiveObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ownerHmac" TEXT NOT NULL,
    "batchKind" TEXT NOT NULL,
    "observationJson" TEXT NOT NULL,
    "observationSha256" TEXT NOT NULL,
    "evidenceSha256" TEXT,
    "evidenceHmac" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedAt" DATETIME,
    CONSTRAINT "CanaryObjectiveObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanaryObjectiveObservation_runId_batchKind_key" ON "CanaryObjectiveObservation"("runId", "batchKind");
CREATE INDEX "CanaryObjectiveObservation_ownerHmac_runId_idx" ON "CanaryObjectiveObservation"("ownerHmac", "runId");

ALTER TABLE "AiGenerationJob" ADD COLUMN "canaryRunId" TEXT
  REFERENCES "ReviewRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiGenerationJob" ADD COLUMN "canarySlotId" TEXT;
CREATE UNIQUE INDEX "AiGenerationJob_canaryRunId_canarySlotId_key"
  ON "AiGenerationJob"("canaryRunId", "canarySlotId");
CREATE INDEX "AiGenerationJob_canaryRunId_canarySlotId_idx"
  ON "AiGenerationJob"("canaryRunId", "canarySlotId");

-- Insertion is append-only and sequence-contiguous. HMAC validation remains in
-- the application because the per-run key never enters SQLite.
CREATE TRIGGER "CanaryLedgerRecord_insert_sequence_guard"
BEFORE INSERT ON "CanaryLedgerRecord"
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW."sequence" != COALESCE(
    (SELECT MAX("sequence") + 1 FROM "CanaryLedgerRecord" WHERE "runId" = NEW."runId"),
    1
  ) THEN RAISE(ABORT, 'canary_ledger_sequence_invalid') END;
END;

CREATE TRIGGER "CanaryLedgerRecord_update_forbidden"
BEFORE UPDATE ON "CanaryLedgerRecord"
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'canary_ledger_update_forbidden');
END;

CREATE TRIGGER "CanaryLedgerRecord_delete_guard"
BEFORE DELETE ON "CanaryLedgerRecord"
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM "SiteConfig"
  WHERE "key" = 'hero_voice_canary_ledger_mutation_guard_v1'
    AND ("value" = OLD."runId" OR "value" = '*')
) BEGIN
  SELECT RAISE(ABORT, 'canary_ledger_delete_forbidden');
END;

CREATE TRIGGER "ReviewRun_ledger_head_guard"
BEFORE UPDATE OF "ledgerSequence", "ledgerHeadHmac" ON "ReviewRun"
FOR EACH ROW WHEN NOT (
  NEW."ledgerSequence" = OLD."ledgerSequence" + 1
  AND EXISTS (
    SELECT 1 FROM "CanaryLedgerRecord"
    WHERE "runId" = OLD."id"
      AND "sequence" = NEW."ledgerSequence"
      AND "recordHmac" = NEW."ledgerHeadHmac"
  )
) AND NOT EXISTS (
  SELECT 1 FROM "SiteConfig"
  WHERE "key" = 'hero_voice_canary_ledger_mutation_guard_v1'
    AND ("value" = OLD."id" OR "value" = '*')
) BEGIN
  SELECT RAISE(ABORT, 'canary_ledger_head_update_forbidden');
END;
