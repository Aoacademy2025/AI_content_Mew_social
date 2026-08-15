import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { decidePaidEquivalentEntitlement } from "../src/lib/paid-equivalent-entitlement.server";

const apply = process.argv.includes("--apply");
const backupConfirmed = process.argv.includes("--backup-confirmed");
const grantedByArg = process.argv.find((arg) => arg.startsWith("--granted-by="));
const grantedById = grantedByArg?.slice("--granted-by=".length).trim() ?? "";
const now = new Date();

async function main() {
  if (apply && (!backupConfirmed || !grantedById)) {
    throw new Error("Apply requires --backup-confirmed and --granted-by=<admin-user-id>");
  }

  const [reservedJobs, reservedUnits, users] = await Promise.all([
    prisma.aiGenerationJob.count({
      where: { fundingSource: "starter_allowance", chargeState: "reserved" },
    }),
    prisma.starterAiImageAllowance.aggregate({ _sum: { reservedImages: true } }),
    prisma.user.findMany({
      where: {
        plan: { in: ["PRO", "BUSINESS"] },
        trialEndsAt: null,
        OR: [{ planExpiresAt: null }, { planExpiresAt: { gt: now } }],
      },
      select: {
        id: true,
        plan: true,
        suspended: true,
        planExpiresAt: true,
        stripeSubscriptionId: true,
        subStatus: true,
        bundleGrantId: true,
        bundleSubscriptionId: true,
        bundleAccessExpiresAt: true,
        bundleStatus: true,
        bundleAmountThb: true,
        payments: {
          where: { status: "PAID", periodDays: { gt: 0 } },
          select: { plan: true, status: true, periodDays: true, paidAt: true, createdAt: true },
        },
        couponRedemptions: {
          select: {
            redeemedAt: true,
            coupon: { select: { type: true, plan: true, durationDays: true } },
          },
        },
        administratorGrants: {
          select: {
            plan: true,
            reason: true,
            startsAt: true,
            expiresAt: true,
            permanent: true,
            revokedAt: true,
          },
        },
      },
    }),
  ]);

  const reservedAllowanceUnits = reservedUnits._sum.reservedImages ?? 0;
  if (apply && (reservedJobs > 0 || reservedAllowanceUnits > 0)) {
    throw new Error(`Refusing apply with unresolved reservations: jobs=${reservedJobs}, units=${reservedAllowanceUnits}`);
  }

  const candidates = users.filter((user) => !decidePaidEquivalentEntitlement({
    user,
    payments: user.payments,
    couponRedemptions: user.couponRedemptions,
    administratorGrants: user.administratorGrants,
  }, now).canUsePaidFeatures);

  const counts = {
    mode: apply ? "apply" : "dry-run",
    scannedPaidLabels: users.length,
    legacyGrantCandidates: candidates.length,
    timed: candidates.filter((user) => user.planExpiresAt).length,
    permanent: candidates.filter((user) => !user.planExpiresAt).length,
    suspended: candidates.filter((user) => user.suspended).length,
    unresolvedReservationJobs: reservedJobs,
    unresolvedReservationUnits: reservedAllowanceUnits,
  };
  console.log(JSON.stringify(counts, null, 2));
  if (!apply) return;

  let created = 0;
  for (const user of candidates) {
    const duplicate = await prisma.administratorGrant.findFirst({
      where: {
        userId: user.id,
        reason: "legacy_admin_plan_backfill",
        revokedAt: null,
        plan: user.plan,
        startsAt: { lte: now },
      },
      select: { id: true },
    });
    if (duplicate) continue;
    await prisma.administratorGrant.create({
      data: {
        userId: user.id,
        plan: user.plan,
        reason: "legacy_admin_plan_backfill",
        startsAt: now,
        expiresAt: user.planExpiresAt,
        permanent: user.planExpiresAt === null,
        grantedById,
      },
    });
    created += 1;
  }
  console.log(JSON.stringify({ applied: true, created }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
