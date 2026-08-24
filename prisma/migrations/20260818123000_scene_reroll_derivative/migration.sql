-- Bind each generated Scene Reroll image to the exact customer-facing MP4
-- derivative. Apply consumes this record in the same transaction that marks
-- its child VideoJob done and promotes the reusable Visual Beat.
CREATE TABLE "SceneRerollDerivative" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "imageJobId" TEXT NOT NULL,
  "sourceVideoJobId" TEXT NOT NULL,
  "sceneIndex" INTEGER NOT NULL,
  "src" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "appliedVideoJobId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" DATETIME,
  CONSTRAINT "SceneRerollDerivative_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SceneRerollDerivative_src_key" ON "SceneRerollDerivative"("src");
CREATE INDEX "SceneRerollDerivative_userId_imageJobId_idx" ON "SceneRerollDerivative"("userId", "imageJobId");
CREATE INDEX "SceneRerollDerivative_sourceVideoJobId_sceneIndex_idx" ON "SceneRerollDerivative"("sourceVideoJobId", "sceneIndex");
CREATE INDEX "SceneRerollDerivative_status_createdAt_idx" ON "SceneRerollDerivative"("status", "createdAt");
