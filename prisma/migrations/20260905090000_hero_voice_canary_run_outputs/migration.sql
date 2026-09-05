CREATE TABLE "CanaryRunOutput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ownerHmac" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "providerJobId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "stagingStorageKey" TEXT NOT NULL,
    "audioSha256" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanaryRunOutput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanaryRunOutput_storageKey_key" ON "CanaryRunOutput"("storageKey");
CREATE UNIQUE INDEX "CanaryRunOutput_stagingStorageKey_key" ON "CanaryRunOutput"("stagingStorageKey");
CREATE UNIQUE INDEX "CanaryRunOutput_runId_slotId_key" ON "CanaryRunOutput"("runId", "slotId");
CREATE INDEX "CanaryRunOutput_ownerHmac_runId_idx" ON "CanaryRunOutput"("ownerHmac", "runId");
