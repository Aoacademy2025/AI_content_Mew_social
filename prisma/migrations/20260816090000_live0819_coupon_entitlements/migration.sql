-- Additive coupon configuration. Existing coupons remain enabled and preserve
-- their historical no-promo behavior until an administrator edits them.
ALTER TABLE "Coupon" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Coupon" ADD COLUMN "stackingPolicy" TEXT NOT NULL DEFAULT 'SAFE_APPEND';
ALTER TABLE "Coupon" ADD COLUMN "promoCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Coupon" ADD COLUMN "promoCreditTtlDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Coupon" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Durable outcome fields prevent later coupon edits from rewriting an already
-- redeemed user's access window.
ALTER TABLE "CouponRedemption" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "CouponRedemption" ADD COLUMN "entitlementPlan" TEXT;
ALTER TABLE "CouponRedemption" ADD COLUMN "entitlementStartsAt" DATETIME;
ALTER TABLE "CouponRedemption" ADD COLUMN "entitlementExpiresAt" DATETIME;

-- Funding snapshots are nullable so every in-flight pre-migration job keeps
-- its legacy granted/purchased refund path.
ALTER TABLE "AiGenerationJob" ADD COLUMN "creditsFromPromotional" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiGenerationJob" ADD COLUMN "creditFundingJson" TEXT;
ALTER TABLE "RenderJob" ADD COLUMN "creditsFromPromotional" INTEGER;
ALTER TABLE "RenderJob" ADD COLUMN "creditFundingJson" TEXT;
ALTER TABLE "VideoJob" ADD COLUMN "fundedCreditsFromPromotional" INTEGER;
ALTER TABLE "VideoJob" ADD COLUMN "fundedCreditFundingJson" TEXT;

CREATE TABLE "PromotionalCreditGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "couponRedemptionId" TEXT NOT NULL,
  "initialAmount" INTEGER NOT NULL,
  "remainingAmount" INTEGER NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PromotionalCreditGrant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PromotionalCreditGrant_couponRedemptionId_fkey"
    FOREIGN KEY ("couponRedemptionId") REFERENCES "CouponRedemption" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PromotionalCreditGrant_couponRedemptionId_key"
  ON "PromotionalCreditGrant"("couponRedemptionId");
CREATE INDEX "PromotionalCreditGrant_userId_expiresAt_idx"
  ON "PromotionalCreditGrant"("userId", "expiresAt");

CREATE TABLE "CouponAuditLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "couponId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "beforeJson" TEXT,
  "afterJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponAuditLog_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "CouponAuditLog_couponId_createdAt_idx"
  ON "CouponAuditLog"("couponId", "createdAt");
CREATE INDEX "CouponAuditLog_actorUserId_createdAt_idx"
  ON "CouponAuditLog"("actorUserId", "createdAt");
CREATE INDEX "CouponRedemption_userId_entitlementStartsAt_entitlementExpiresAt_idx"
  ON "CouponRedemption"("userId", "entitlementStartsAt", "entitlementExpiresAt");
