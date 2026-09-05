CREATE TABLE "BrandLibraryOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "resultJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandLibraryOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BrandLibraryOperation_userId_requestId_key" ON "BrandLibraryOperation"("userId", "requestId");
