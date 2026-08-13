-- Catch up schema that previously existed only through `prisma db push`.
-- Keeping this additive lets a fresh `prisma migrate deploy` match schema.prisma
-- without rewriting User or risking child-table data.
ALTER TABLE "User" ADD COLUMN "bundleGrantId" TEXT;
ALTER TABLE "User" ADD COLUMN "bundleSubscriptionId" TEXT;
ALTER TABLE "User" ADD COLUMN "bundleAccessExpiresAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "bundleStatus" TEXT;
ALTER TABLE "User" ADD COLUMN "bundleBillingPeriod" TEXT;
ALTER TABLE "User" ADD COLUMN "bundleAmountThb" INTEGER;
ALTER TABLE "User" ADD COLUMN "bundleLastEventId" TEXT;
ALTER TABLE "User" ADD COLUMN "bundleQuotaGrantId" TEXT;
ALTER TABLE "User" ADD COLUMN "bundleCreditsGrantId" TEXT;
ALTER TABLE "User" ADD COLUMN "bundlePrimary" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "BundleEntitlement" (
    "email" TEXT NOT NULL PRIMARY KEY,
    "grantId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "status" TEXT NOT NULL,
    "accessEndsAt" DATETIME NOT NULL,
    "billingPeriod" TEXT,
    "amountThb" INTEGER,
    "lastEventId" TEXT NOT NULL,
    "eventOccurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "BundleEntitlement_lastEventId_key" ON "BundleEntitlement"("lastEventId");
CREATE INDEX "BundleEntitlement_subscriptionId_idx" ON "BundleEntitlement"("subscriptionId");
CREATE INDEX "BundleEntitlement_status_accessEndsAt_idx" ON "BundleEntitlement"("status", "accessEndsAt");
