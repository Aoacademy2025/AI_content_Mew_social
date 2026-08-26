-- Admin-only Hero Voice clone references. Audio bytes remain in the private
-- uploads/user-voices directory; this table stores ownership and consent audit.
CREATE TABLE "UserVoice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "refText" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "consentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consentVersion" TEXT NOT NULL DEFAULT 'voice-clone-v1',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserVoice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserVoice_filename_key" ON "UserVoice"("filename");
CREATE INDEX "UserVoice_userId_createdAt_idx" ON "UserVoice"("userId", "createdAt");
