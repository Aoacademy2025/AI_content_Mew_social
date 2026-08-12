import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  recordBundleEntitlement,
  syncStoredBundleEntitlementForUser,
} from "../src/lib/bundle-entitlement";
import { syncUserEntitlement } from "../src/lib/entitlements";

const now = new Date("2026-08-13T00:00:00.000Z");
const expiresAt = new Date("2026-09-13T00:00:00.000Z");
const revokeAt = new Date("2026-08-20T00:00:00.000Z");

async function main() {
  process.env.CREDITS_LIVE = "0";

  const primary = await prisma.user.create({
    data: { name: "Bundle Primary", email: "bundle-primary@example.test" },
  });
  await recordBundleEntitlement({
    action: "grant",
    email: primary.email,
    grantId: "in_primary_1",
    eventId: "bundle-grant:in_primary_1",
    subscriptionId: "sub_primary",
    expiresAt,
    occurredAt: now,
    billingPeriod: "monthly",
    amountThb: 899,
  });
  await syncStoredBundleEntitlementForUser(primary.id, now);
  let row = await prisma.user.findUniqueOrThrow({ where: { id: primary.id } });
  assert.equal(row.plan, "PRO");
  assert.equal(row.bundlePrimary, true);
  assert.equal(row.bundleBillingPeriod, "monthly");
  assert.equal(row.bundleAmountThb, 899);
  assert.equal(row.usageLimit, 100);
  assert.equal(row.minutesLimit, 80);

  // Duplicate delivery cannot reset already-consumed quota.
  await prisma.user.update({ where: { id: primary.id }, data: { usageCount: 5 } });
  await syncStoredBundleEntitlementForUser(primary.id, now);
  row = await prisma.user.findUniqueOrThrow({ where: { id: primary.id } });
  assert.equal(row.usageCount, 5);

  await recordBundleEntitlement({
    action: "revoke",
    email: primary.email,
    eventId: "bundle-revoke:sub_primary",
    subscriptionId: "sub_primary",
    occurredAt: revokeAt,
    reason: "subscription_canceled",
  });
  await syncStoredBundleEntitlementForUser(primary.id, revokeAt);
  await syncUserEntitlement(primary.id, revokeAt);
  row = await prisma.user.findUniqueOrThrow({ where: { id: primary.id } });
  assert.equal(row.plan, "FREE");

  // A timed/native source survives the exact same Bundle revoke.
  const independent = await prisma.user.create({
    data: {
      name: "Independent Paid",
      email: "bundle-independent@example.test",
      plan: "PRO",
      planExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  await recordBundleEntitlement({
    action: "grant",
    email: independent.email,
    grantId: "in_independent_1",
    eventId: "bundle-grant:in_independent_1",
    subscriptionId: "sub_independent",
    expiresAt,
    occurredAt: now,
    billingPeriod: "monthly",
    amountThb: 899,
  });
  await syncStoredBundleEntitlementForUser(independent.id, now);
  await recordBundleEntitlement({
    action: "revoke",
    email: independent.email,
    eventId: "bundle-revoke:sub_independent",
    subscriptionId: "sub_independent",
    occurredAt: revokeAt,
    reason: "subscription_canceled",
  });
  await syncStoredBundleEntitlementForUser(independent.id, revokeAt);
  await syncUserEntitlement(independent.id, revokeAt);
  const independentAfter = await prisma.user.findUniqueOrThrow({ where: { id: independent.id } });
  assert.equal(independentAfter.plan, "PRO");
  assert.equal(independentAfter.planExpiresAt?.toISOString(), "2027-01-01T00:00:00.000Z");

  // Explicit migration mode converts the two historical manual Bundle terms
  // into source-backed grants, so a mid-period refund revokes immediately.
  const legacy = await prisma.user.create({
    data: {
      name: "Legacy Bundle Manual",
      email: "bundle-legacy@example.test",
      plan: "PRO",
      planExpiresAt: expiresAt,
    },
  });
  await recordBundleEntitlement({
    action: "grant",
    email: legacy.email,
    grantId: "in_legacy_1",
    eventId: "bundle-grant:in_legacy_1",
    subscriptionId: "sub_legacy",
    expiresAt,
    occurredAt: now,
    billingPeriod: "monthly",
    amountThb: 899,
  });
  await syncStoredBundleEntitlementForUser(legacy.id, now, { forcePrimary: true });
  let legacyAfter = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(legacyAfter.bundlePrimary, true);
  assert.equal(legacyAfter.planExpiresAt, null);
  await recordBundleEntitlement({
    action: "revoke",
    email: legacy.email,
    eventId: "bundle-revoke:sub_legacy",
    subscriptionId: "sub_legacy",
    occurredAt: revokeAt,
    reason: "full_refund",
  });
  await syncStoredBundleEntitlementForUser(legacy.id, revokeAt);
  await syncUserEntitlement(legacy.id, revokeAt);
  legacyAfter = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(legacyAfter.plan, "FREE");

  console.log("Bundle entitlement verification passed");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
