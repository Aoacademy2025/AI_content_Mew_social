ALTER TABLE "BrandProfile" ADD COLUMN "archivedAt" DATETIME;

CREATE INDEX "BrandProfile_userId_archivedAt_updatedAt_idx"
ON "BrandProfile"("userId", "archivedAt", "updatedAt");
