import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "render-settlement-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { checkMinuteQuota } = await import("../src/lib/minute-limits");
  const { getBalance, getReservedCredits } = await import("../src/lib/credits");
  const { isBurnAlreadyPaid, recordChargedClip } = await import("../src/lib/clip-charge");
  const {
    refundRenderReservationById,
    retryPendingVideoJobReservationRefunds,
    refundVideoJobBaseReservation,
    refundVideoJobTerminalRenderReservations,
  } = await import("../src/lib/render/reservation-settlement");
  const {
    applyAvatarQuotaRefund,
    inspectAvatarQuotaRefund,
  } = await import("../src/lib/render/avatar-quota-refund");

  const minuteUser = await prisma.user.create({
    data: {
      id: "minute-user",
      name: "Minute User",
      email: "minute@example.com",
      plan: "PRO",
      minutesUsed: 2,
      minutesLimit: 80,
      usagePeriodStartedAt: new Date(),
    },
  });
  const minuteUrl = "/api/renders/minute-base.mp4";
  await prisma.renderJob.create({
    data: {
      id: "minute-render",
      userId: minuteUser.id,
      parentJobId: "minute-video-job",
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      videoUrl: minuteUrl,
      reservedQuota: true,
      reservedMinutes: 2,
    },
  });
  await recordChargedClip(minuteUser.id, minuteUrl, 2);

  const minuteRefund = await refundVideoJobBaseReservation({
    videoJobId: "minute-video-job",
    userId: minuteUser.id,
    reason: "avatar-provider-quota",
  });
  assert.deepEqual(minuteRefund, {
    kind: "refunded",
    renderJobId: "minute-render",
    funding: "minutes",
    amount: 2,
  });
  assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0);
  assert.equal(await isBurnAlreadyPaid(minuteUser.id, minuteUrl), false);

  const minuteAgain = await refundVideoJobBaseReservation({
    videoJobId: "minute-video-job",
    userId: minuteUser.id,
    reason: "avatar-provider-quota",
  });
  assert.equal(minuteAgain.kind, "already_settled");
  assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0);

  const creditUser = await prisma.user.create({
    data: {
      id: "credit-user",
      name: "Credit User",
      email: "credit@example.com",
      plan: "PRO",
      usagePeriodStartedAt: new Date(),
    },
  });
  await prisma.creditBalance.create({
    data: { userId: creditUser.id, granted: 0, purchased: 9 },
  });
  const creditUrl = "/api/renders/credit-base.mp4";
  await prisma.renderJob.create({
    data: {
      id: "credit-render",
      userId: creditUser.id,
      parentJobId: "credit-video-job",
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      videoUrl: creditUrl,
      reservedQuota: true,
      creditsSpent: 6,
      creditsFromGranted: 5,
    },
  });
  await recordChargedClip(creditUser.id, creditUrl, undefined, 6);

  const creditRefund = await refundVideoJobBaseReservation({
    videoJobId: "credit-video-job",
    userId: creditUser.id,
    reason: "avatar-provider-quota",
  });
  assert.deepEqual(creditRefund, {
    kind: "refunded",
    renderJobId: "credit-render",
    funding: "credits",
    amount: 6,
  });
  assert.deepEqual(await getBalance(creditUser.id), { granted: 5, purchased: 10, total: 15 });
  assert.equal(await isBurnAlreadyPaid(creditUser.id, creditUrl), false);

  const missing = await refundVideoJobBaseReservation({
    videoJobId: "missing-video-job",
    userId: minuteUser.id,
    reason: "avatar-provider-quota",
  });
  assert.equal(missing.kind, "not_found");

  await prisma.renderJob.create({
    data: {
      id: "in-flight-render",
      userId: creditUser.id,
      parentJobId: "in-flight-video-job",
      type: "RENDER",
      status: "RUNNING",
      payload: "{}",
      reservedQuota: true,
      creditsSpent: 4,
      creditsFromGranted: 0,
    },
  });
  const inFlight = await refundVideoJobBaseReservation({
    videoJobId: "in-flight-video-job",
    userId: creditUser.id,
    reason: "video_render_failed",
  });
  assert.deepEqual(inFlight, { kind: "in_flight", renderJobId: "in-flight-render" });
  assert.equal(
    (await prisma.renderJob.findUniqueOrThrow({ where: { id: "in-flight-render" } })).reservedQuota,
    true,
  );
  assert.deepEqual(
    await refundVideoJobTerminalRenderReservations({
      videoJobId: "in-flight-video-job",
      userId: creditUser.id,
      reason: "video_render_failed",
    }),
    { kind: "in_flight", candidateJobs: 1, refundedJobs: 0, inFlightJobs: 1 },
  );
  await prisma.renderJob.update({
    where: { id: "in-flight-render" },
    data: { status: "FAILED" },
  });
  assert.deepEqual(
    await refundVideoJobTerminalRenderReservations({
      videoJobId: "in-flight-video-job",
      userId: creditUser.id,
      reason: "video_render_failed",
    }),
    { kind: "settled", candidateJobs: 1, refundedJobs: 1 },
  );

  await prisma.renderJob.createMany({
    data: [
      {
        id: "burn-transfer-base",
        userId: creditUser.id,
        parentJobId: "burn-transfer-video-job",
        type: "RENDER",
        status: "DONE",
        payload: "{}",
        reservedQuota: false,
      },
      {
        id: "burn-transfer-final",
        userId: creditUser.id,
        parentJobId: "burn-transfer-video-job",
        type: "BURN",
        status: "FAILED",
        payload: "{}",
        reservedQuota: true,
        creditsSpent: 2,
        creditsFromGranted: 0,
      },
    ],
  });
  assert.deepEqual(
    await refundVideoJobTerminalRenderReservations({
      videoJobId: "burn-transfer-video-job",
      userId: creditUser.id,
      reason: "video_burn_failed",
    }),
    { kind: "settled", candidateJobs: 2, refundedJobs: 1 },
  );
  assert.equal(
    (await prisma.renderJob.findUniqueOrThrow({ where: { id: "burn-transfer-final" } })).reservedQuota,
    false,
  );

  await prisma.user.update({ where: { id: minuteUser.id }, data: { usageCount: 1 } });
  await prisma.renderJob.create({
    data: {
      id: "legacy-unlinked-render",
      userId: minuteUser.id,
      parentJobId: null,
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      reservedQuota: true,
    },
  });
  const legacyRefund = await refundRenderReservationById({
    renderJobId: "legacy-unlinked-render",
    userId: minuteUser.id,
    reason: "legacy-avatar-provider-quota",
  });
  assert.equal(legacyRefund.kind, "refunded");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: minuteUser.id } })).usageCount, 0);
  assert.equal((await refundRenderReservationById({
    renderJobId: "legacy-unlinked-render",
    userId: minuteUser.id,
    reason: "legacy-avatar-provider-quota",
  })).kind, "already_settled");

  const incidentStart = new Date("2026-07-18T08:00:00.000Z");
  await prisma.user.update({ where: { id: minuteUser.id }, data: { minutesUsed: 3 } });
  await prisma.videoJob.create({
    data: {
      id: "legacy-avatar-quota-job",
      userId: minuteUser.id,
      status: "failed",
      currentStep: "avatar",
      inputJson: JSON.stringify({ script: "incident", avatarMode: "full", avatarId: "avatar-1" }),
      errorMessage: "avatar generate has unknown provider outcome - manual recovery required",
      createdAt: incidentStart,
      startedAt: incidentStart,
      finishedAt: new Date("2026-07-18T08:20:00.000Z"),
    },
  });
  await prisma.renderJob.create({
    data: {
      id: "legacy-avatar-quota-render",
      userId: minuteUser.id,
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      reservedQuota: true,
      reservedMinutes: 3,
      createdAt: new Date("2026-07-18T08:10:00.000Z"),
    },
  });

  const unconfirmed = await inspectAvatarQuotaRefund({
    videoJobId: "legacy-avatar-quota-job",
    renderJobId: "legacy-avatar-quota-render",
  });
  assert.deepEqual(unconfirmed, {
    kind: "rejected",
    videoJobId: "legacy-avatar-quota-job",
    reason: "legacy_unknown_requires_confirmed_heygen_402",
  });
  const incident = await inspectAvatarQuotaRefund({
    videoJobId: "legacy-avatar-quota-job",
    renderJobId: "legacy-avatar-quota-render",
    confirmedLegacyHeygen402: true,
  });
  assert.equal(incident.kind, "ready");
  assert.equal(incident.kind === "ready" ? incident.amount : null, 3);
  assert.equal(incident.kind === "ready" ? incident.renderJobId : null, "legacy-avatar-quota-render");
  assert.equal(incident.kind === "ready" ? (await applyAvatarQuotaRefund(incident)).kind : null, "refunded");
  assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0);
  const incidentJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: "legacy-avatar-quota-job" } });
  assert.equal(incidentJob.errorCode, "quota");
  assert.equal(incidentJob.errorProvider, "heygen");

  const repeatedInspection = await inspectAvatarQuotaRefund({
    videoJobId: "legacy-avatar-quota-job",
    renderJobId: "legacy-avatar-quota-render",
  });
  assert.equal(repeatedInspection.kind, "already_settled", JSON.stringify(repeatedInspection));
  assert.equal(
    repeatedInspection.kind === "already_settled" ? (await applyAvatarQuotaRefund(repeatedInspection)).kind : null,
    "already_settled",
  );
  assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0);

  await prisma.user.update({ where: { id: minuteUser.id }, data: { minutesUsed: 2 } });
  await prisma.videoJob.create({
    data: {
      id: "pending-avatar-refund-job",
      userId: minuteUser.id,
      status: "failed",
      currentStep: "avatar",
      inputJson: JSON.stringify({ script: "pending refund", avatarMode: "full", avatarId: "avatar-1" }),
      errorMessage: "เครดิต HeyGen ไม่เพียงพอ",
      errorCode: "quota",
      errorProvider: "heygen",
      reservationRefundPending: true,
      reservationRefundReason: "avatar-provider-quota",
      finishedAt: new Date(),
    },
  });
  await prisma.renderJob.create({
    data: {
      id: "pending-avatar-refund-render",
      userId: minuteUser.id,
      parentJobId: "pending-avatar-refund-job",
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      reservedQuota: true,
      reservedMinutes: 2,
    },
  });
  await prisma.aiGenerationJob.create({
    data: {
      id: "pending-avatar-refund-image",
      userId: minuteUser.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      status: "completed",
      chargeState: "settled",
      creditCost: 3,
      creditsFromGranted: 0,
      creditsFromPurchased: 3,
      idempotencyKey: "video:pending-avatar-refund-job:scene:0",
    },
  });
  const swept = await retryPendingVideoJobReservationRefunds({ limit: 10 });
  assert.deepEqual(swept, { inspected: 1, settled: 1, pending: 0 });
  const sweptJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: "pending-avatar-refund-job" } });
  assert.equal(sweptJob.reservationRefundPending, false);
  assert.equal(sweptJob.reservationRefundReason, null);
  assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0);
  assert.equal(
    (await prisma.aiGenerationJob.findUniqueOrThrow({
      where: { id: "pending-avatar-refund-image" },
    })).chargeState,
    "refunded",
  );
  assert.equal((await getBalance(minuteUser.id)).total, 3);

  const snapshotUser = await prisma.user.create({
    data: {
      id: "reserved-snapshot-user",
      name: "Reserved snapshot",
      email: "reserved-snapshot@example.com",
      plan: "PRO",
    },
  });
  await prisma.aiGenerationJob.createMany({
    data: [
      {
        id: "reserved-snapshot-ai",
        userId: snapshotUser.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "in_progress",
        chargeState: "reserved",
        creditCost: 3,
      },
      {
        id: "settled-snapshot-ai",
        userId: snapshotUser.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        chargeState: "settled",
        creditCost: 5,
      },
    ],
  });
  await prisma.renderJob.createMany({
    data: [
      {
        id: "reserved-snapshot-render",
        userId: snapshotUser.id,
        type: "RENDER",
        status: "QUEUED",
        payload: "{}",
        reservedQuota: true,
        creditsSpent: 4,
      },
      {
        id: "settled-snapshot-render",
        userId: snapshotUser.id,
        type: "RENDER",
        status: "DONE",
        payload: "{}",
        reservedQuota: true,
        creditsSpent: 8,
      },
    ],
  });
  assert.equal(
    await getReservedCredits(snapshotUser.id),
    7,
    "reserved balance disclosure includes only in-flight AI/render reservations",
  );

  await prisma.$disconnect();
  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
