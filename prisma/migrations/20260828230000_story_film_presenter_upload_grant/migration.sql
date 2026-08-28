-- CreateTable
CREATE TABLE "StoryFilmPresenterUploadGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "presenterAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryFilmPresenterUploadGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryFilmPresenterUploadGrant_tokenHash_key" ON "StoryFilmPresenterUploadGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "StoryFilmPresenterUploadGrant_userId_createdAt_idx" ON "StoryFilmPresenterUploadGrant"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "StoryFilmPresenterUploadGrant_expiresAt_consumedAt_idx" ON "StoryFilmPresenterUploadGrant"("expiresAt", "consumedAt");
