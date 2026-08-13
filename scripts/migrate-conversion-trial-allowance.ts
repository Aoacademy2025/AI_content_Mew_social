import "dotenv/config";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { STARTER_AI_IMAGE_ALLOWANCE_LIMIT } from "../src/lib/starter-ai-image-allowance.server";

const DAY_MS = 24 * 60 * 60 * 1_000;
const apply = process.argv.includes("--apply");
const backupConfirmed = process.argv.includes("--backup-confirmed");

async function main() {
  if (apply && !backupConfirmed) throw new Error("Apply requires --backup-confirmed");
  const [reservedJobs, reservedUnits, trialUsers] = await Promise.all([
    prisma.aiGenerationJob.count({ where: { fundingSource: "starter_allowance", chargeState: "reserved" } }),
    prisma.starterAiImageAllowance.aggregate({ _sum: { reservedImages: true } }),
    prisma.user.findMany({
      where: { trialStartedAt: { not: null } },
      select: {
        id: true,
        trialStartedAt: true,
        trialEndsAt: true,
        conversionTrialAiImageAllowance: { select: { id: true } },
        starterAiImageAllowances: { select: { usedImages: true } },
      },
    }),
  ]);
  const unresolvedUnits = reservedUnits._sum.reservedImages ?? 0;
  if (apply && (reservedJobs > 0 || unresolvedUnits > 0)) {
    throw new Error(`Refusing apply with unresolved reservations: jobs=${reservedJobs}, units=${unresolvedUnits}`);
  }

  const candidates = trialUsers.filter((user) => !user.conversionTrialAiImageAllowance && user.trialStartedAt);
  let withPriorConsumption = 0;
  let totalCarried = 0;
  const prepared: Array<{ userId: string; startedAt: Date; expiresAt: Date; usedImages: number }> = [];
  for (const user of candidates) {
    const startedAt = user.trialStartedAt!;
    const expiresAt = user.trialEndsAt ?? new Date(startedAt.getTime() + 7 * DAY_MS);
    const [deliveredJobs] = await Promise.all([
      prisma.aiGenerationJob.count({
        where: {
          userId: user.id,
          kind: "image",
          fundingSource: "starter_allowance",
          status: "completed",
          chargeState: "settled",
          outputUrl: { not: null },
          createdAt: { gte: startedAt, lte: expiresAt },
        },
      }),
    ]);
    const legacyUsed = user.starterAiImageAllowances.reduce((sum, row) => sum + row.usedImages, 0);
    const usedImages = Math.min(STARTER_AI_IMAGE_ALLOWANCE_LIMIT, Math.max(legacyUsed, deliveredJobs));
    if (usedImages > 0) withPriorConsumption += 1;
    totalCarried += usedImages;
    prepared.push({ userId: user.id, startedAt, expiresAt, usedImages });
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    trialIdentities: trialUsers.length,
    alreadyMigrated: trialUsers.length - candidates.length,
    candidates: candidates.length,
    withPriorConsumption,
    totalCarried,
    unresolvedReservationJobs: reservedJobs,
    unresolvedReservationUnits: unresolvedUnits,
  }, null, 2));
  if (!apply) return;

  let created = 0;
  for (const item of prepared) {
    try {
      await prisma.conversionTrialAiImageAllowance.create({
        data: {
          userId: item.userId,
          trialStartedAt: item.startedAt,
          expiresAt: item.expiresAt,
          limitImages: STARTER_AI_IMAGE_ALLOWANCE_LIMIT,
          usedImages: item.usedImages,
        },
      });
      created += 1;
    } catch (error) {
      // A newly active Trial can materialize its allowance between the scan and
      // this one-time backfill. Treat the unique userId race as already migrated;
      // every other database error remains fatal.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
  }
  console.log(JSON.stringify({ applied: true, created }, null, 2));
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
