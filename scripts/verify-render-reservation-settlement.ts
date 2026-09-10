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
  assert.deepEqual(await getBalance(creditUser.id), { granted: 5, promotional: 0, purchased: 10, total: 15 });
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

  // HERO-15: the HERO-14 incident. A job that died at `intro_wait` because the
  // orchestrator refused a checkpoint it had written itself is owed its minutes for
  // the same reason the quota incident is — HeyGen generated and billed the intro
  // video and we abandoned the render. Unlike the legacy unknown-outcome path this
  // needs no human attestation: the stored checkpoint proves provider engagement.
  {
    const checkpointStart = new Date("2026-09-09T15:28:00.000Z");
    const checkpoint = {
      version: 1, provider: "heygen", phase: "intro_wait",
      providerStartedAt: "2026-09-09T15:37:51.724Z",
      providerDeadlineAt: "2026-09-09T17:37:51.724Z",
      baseUrl: "/api/renders/ckpt-base.mp4", voiceUrl: "/api/renders/ckpt-tts.wav",
      audioDurationMs: 98073, captions: [{ text: "หนึ่ง", startMs: 0, endMs: 900 }],
      words: [], fullText: "หนึ่ง",
      subtitleTimingSource: "partial_forced_alignment",
      speechCoverage: { source: "silence_analysis", spokenEndMs: 98170 },
      baseConfig: {},
      avatar: {
        mode: "bookend", id: "avatar-1", introSecs: 5, tailSecs: 5,
        layout: { scale: 1, offsetX: 0, offsetY: 0 },
        introAudioUrl: "/api/renders/ckpt-intro.wav",
        introVideoId: "05ec14ca3b424c6fae15c4d03e2ee6a7",
      },
    };
    await prisma.user.update({ where: { id: minuteUser.id }, data: { minutesUsed: 2 } });
    const makeJob = async (id: string, providerCheckpointJson: string | null) => {
      await prisma.videoJob.create({
        data: {
          id, userId: minuteUser.id, status: "failed", currentStep: "avatar",
          inputJson: JSON.stringify({ script: "incident", avatarMode: "bookend", avatarId: "avatar-1" }),
          errorMessage: "เกิดข้อผิดพลาด (startup_unknown): invalid avatar provider checkpoint - manual recovery required",
          providerCheckpointJson,
          createdAt: checkpointStart, startedAt: checkpointStart,
          finishedAt: new Date("2026-09-09T15:50:00.000Z"),
        },
      });
      await prisma.renderJob.create({
        data: {
          id: `${id}-render`, userId: minuteUser.id, type: "RENDER", status: "DONE",
          payload: "{}", reservedQuota: true, reservedMinutes: 2,
          createdAt: new Date("2026-09-09T15:40:00.000Z"),
        },
      });
    };

    // Evidence missing → refuse, with its own reason. Never silently refund.
    await makeJob("ckpt-no-evidence-job", null);
    assert.deepEqual(
      await inspectAvatarQuotaRefund({
        videoJobId: "ckpt-no-evidence-job", renderJobId: "ckpt-no-evidence-job-render",
      }),
      { kind: "rejected", videoJobId: "ckpt-no-evidence-job", reason: "checkpoint_provider_engagement_not_confirmed" },
      "a checkpoint failure with no stored checkpoint proves nothing and must not open the money path",
    );

    // A checkpoint that never reached HeyGen (no intro video id) is equally unproven.
    await makeJob("ckpt-no-intro-job", JSON.stringify({
      ...checkpoint, phase: "intro_generate",
      avatar: { ...checkpoint.avatar, introVideoId: undefined },
    }));
    assert.equal(
      (await inspectAvatarQuotaRefund({
        videoJobId: "ckpt-no-intro-job", renderJobId: "ckpt-no-intro-job-render",
      })).kind,
      "rejected",
      "no intro video id means HeyGen was never billed, so there is nothing to compensate",
    );

    // The real shape: refundable, with NO --confirmed-heygen-402 attestation.
    await makeJob("ckpt-job", JSON.stringify(checkpoint));
    const ckptIncident = await inspectAvatarQuotaRefund({
      videoJobId: "ckpt-job", renderJobId: "ckpt-job-render",
    });
    assert.equal(ckptIncident.kind, "ready", JSON.stringify(ckptIncident));
    assert.equal(ckptIncident.kind === "ready" ? ckptIncident.incident : null, "checkpoint_unreadable");
    assert.equal(ckptIncident.kind === "ready" ? ckptIncident.amount : null, 2);
    assert.equal(ckptIncident.kind === "ready" ? ckptIncident.funding : null, "minutes");
    assert.equal(
      ckptIncident.kind === "ready" ? (await applyAvatarQuotaRefund(ckptIncident)).kind : null,
      "refunded",
    );
    assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0, "the 2 minutes come back");

    // The incident record must stay truthful: the quota path normalises error codes,
    // the checkpoint path must not be refiled as a HeyGen quota event.
    const ckptJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: "ckpt-job" } });
    assert.equal(ckptJob.errorCode, null, "a checkpoint failure is never restamped as a quota error");
    assert.equal(ckptJob.errorProvider, null, "a checkpoint failure is never restamped as a heygen error");

    // Idempotent: a second pass is a no-op, not a second refund.
    const repeat = await inspectAvatarQuotaRefund({
      videoJobId: "ckpt-job", renderJobId: "ckpt-job-render",
    });
    assert.equal(repeat.kind, "already_settled", JSON.stringify(repeat));
    assert.equal(
      repeat.kind === "already_settled" ? (await applyAvatarQuotaRefund(repeat)).kind : null,
      "already_settled",
    );
    assert.equal((await checkMinuteQuota(minuteUser.id)).used, 0, "a repeat run never refunds twice");

    // Unchanged guards: a mismatched reviewed render is still refused.
    assert.equal(
      (await inspectAvatarQuotaRefund({
        videoJobId: "ckpt-job", renderJobId: "legacy-avatar-quota-render",
      })).kind,
      "rejected",
      "the reviewed render job must still match",
    );
  }

  // R32/R34: avatar-steps.ts:147 throws this English cause, and the orchestrator's terminal
  // catch now labels unknown step failures as "<prefix> (<code>): <cause>". The refund gate
  // matches by substring so BOTH shapes still open the money path — the wrapped message is
  // built with the SHIPPED classifier here, never a hand-written replica of it, so a change
  // to the wrapping form fails this test instead of silently closing the gate.
  {
    const { classifyUnknownStepFailure } = await import("../src/lib/mcp/orchestrator");
    const LEGACY_UNKNOWN_OUTCOME = "avatar generate has unknown provider outcome - manual recovery required";
    const wrappedLegacyMessage = classifyUnknownStepFailure({
      phaseName: "avatar",
      code: "avatar_unknown",
      cause: LEGACY_UNKNOWN_OUTCOME,
    }).message;
    assert.equal(
      wrappedLegacyMessage,
      `ประกอบ Avatar ไม่สำเร็จ (avatar_unknown): ${LEGACY_UNKNOWN_OUTCOME}`,
      "the avatar cause is English/internal, so the classifier must wrap it with the step prefix + code",
    );

    const wrappedUser = await prisma.user.create({
      data: {
        id: "wrapped-legacy-user",
        name: "Wrapped Legacy User",
        email: "wrapped-legacy@example.com",
        plan: "PRO",
        minutesUsed: 4,
        minutesLimit: 80,
        usagePeriodStartedAt: new Date(),
      },
    });
    const wrappedStart = new Date("2026-08-29T08:00:00.000Z");
    for (const [shape, errorMessage] of [
      ["wrapped", wrappedLegacyMessage],
      ["bare", LEGACY_UNKNOWN_OUTCOME],
    ] as const) {
      await prisma.videoJob.create({
        data: {
          id: `legacy-avatar-${shape}-job`,
          userId: wrappedUser.id,
          status: "failed",
          currentStep: "avatar",
          inputJson: JSON.stringify({ script: "incident", avatarMode: "bookend", avatarId: "avatar-1" }),
          errorMessage,
          errorCode: shape === "wrapped" ? "avatar_unknown" : null,
          createdAt: wrappedStart,
          startedAt: wrappedStart,
          finishedAt: new Date("2026-08-29T08:20:00.000Z"),
        },
      });
      await prisma.renderJob.create({
        data: {
          id: `legacy-avatar-${shape}-render`,
          userId: wrappedUser.id,
          type: "RENDER",
          status: "DONE",
          payload: "{}",
          reservedQuota: true,
          reservedMinutes: 2,
          createdAt: new Date("2026-08-29T08:10:00.000Z"),
        },
      });
      const inspection = await inspectAvatarQuotaRefund({
        videoJobId: `legacy-avatar-${shape}-job`,
        renderJobId: `legacy-avatar-${shape}-render`,
        confirmedLegacyHeygen402: true,
      });
      assert.equal(inspection.kind, "ready", `${shape} legacy message must still reach the refund gate: ${JSON.stringify(inspection)}`);
      assert.equal(inspection.kind === "ready" ? inspection.legacyEvidenceRequired : null, true);
      assert.equal(inspection.kind === "ready" ? inspection.amount : null, 2);
      // The reviewed-confirmation guard still applies to both shapes.
      assert.deepEqual(
        await inspectAvatarQuotaRefund({
          videoJobId: `legacy-avatar-${shape}-job`,
          renderJobId: `legacy-avatar-${shape}-render`,
        }),
        {
          kind: "rejected",
          videoJobId: `legacy-avatar-${shape}-job`,
          reason: "legacy_unknown_requires_confirmed_heygen_402",
        },
      );
    }
    console.log("ok: the avatar refund gate recognises both the bare and the step-prefixed legacy cause");
  }

  // HERO-18: the same legacy cause also covers a generate the provider DEFINITIVELY refused
  // (HeyGen 404, laundered into our own 500) and a generate whose response was lost. Both
  // stop at `intro_generate` with no `avatar.introVideoId`, which proves no provider video
  // was ever delivered — stronger evidence than the --confirmed-heygen-402 attestation, so
  // this shape opens the gate on its own. A checkpoint that DOES carry an intro video id is
  // not this incident and must still ask for the attestation.
  {
    const unfulfilledUser = await prisma.user.create({
      data: {
        id: "unfulfilled-generate-user",
        name: "Unfulfilled Generate User",
        email: "unfulfilled-generate@example.com",
        plan: "PRO",
        minutesUsed: 3,
        minutesLimit: 80,
        usagePeriodStartedAt: new Date(),
      },
    });
    const start = new Date("2026-09-09T15:15:41.000Z");
    const baseCheckpoint = {
      version: 1, provider: "heygen",
      providerStartedAt: "2026-09-09T15:23:42.989Z",
      providerDeadlineAt: "2026-09-09T17:23:42.989Z",
      baseUrl: "/api/renders/unfulfilled-base.mp4",
      voiceUrl: "/api/renders/unfulfilled-tts.wav",
      audioDurationMs: 98073,
      captions: [{ text: "หนึ่ง", startMs: 0, endMs: 900 }],
      words: [], fullText: "หนึ่ง",
      subtitleTimingSource: "partial_forced_alignment",
      speechCoverage: { source: "silence_analysis", spokenEndMs: 98170 },
      baseConfig: {},
      avatar: {
        mode: "bookend", id: "avatar-1", introSecs: 5, tailSecs: 5,
        layout: { scale: 1, offsetX: 0, offsetY: 0 },
        introAudioUrl: "/api/renders/unfulfilled-intro.wav",
      },
    };
    const seed = async (id: string, checkpoint: unknown, minutes: number) => {
      await prisma.videoJob.create({
        data: {
          id, userId: unfulfilledUser.id, status: "failed", currentStep: "avatar",
          inputJson: JSON.stringify({ script: "incident", avatarMode: "bookend", avatarId: "avatar-1" }),
          errorMessage: "avatar generate has unknown provider outcome - manual recovery required",
          errorProvider: "heygen",
          providerCheckpointJson: JSON.stringify(checkpoint),
          createdAt: start, startedAt: start,
          finishedAt: new Date("2026-09-09T15:30:00.000Z"),
        },
      });
      await prisma.renderJob.create({
        data: {
          id: `${id}-render`, userId: unfulfilledUser.id, type: "RENDER", status: "DONE",
          payload: "{}", reservedQuota: true, reservedMinutes: minutes,
          createdAt: new Date("2026-09-09T15:20:00.000Z"),
        },
      });
    };

    // Engagement PROVEN (intro video id present) → not this incident, attestation still required.
    await seed("engaged-generate-job", {
      ...baseCheckpoint, phase: "intro_wait",
      avatar: { ...baseCheckpoint.avatar, introVideoId: "05ec14ca3b424c6fae15c4d03e2ee6a7" },
    }, 1);
    assert.deepEqual(
      await inspectAvatarQuotaRefund({
        videoJobId: "engaged-generate-job", renderJobId: "engaged-generate-job-render",
      }),
      {
        kind: "rejected",
        videoJobId: "engaged-generate-job",
        reason: "legacy_unknown_requires_confirmed_heygen_402",
      },
      "a checkpoint carrying an intro video id is a different incident and keeps its attestation",
    );

    // The HERO-18 shape: refused at generate, nothing delivered, no attestation needed.
    await seed("unfulfilled-generate-job", { ...baseCheckpoint, phase: "intro_generate" }, 2);
    const minutesUsedBefore = (await prisma.user.findUniqueOrThrow({ where: { id: unfulfilledUser.id } })).minutesUsed;
    assert.equal(minutesUsedBefore, 3, "the account starts holding the charge for both jobs");
    const unfulfilled = await inspectAvatarQuotaRefund({
      videoJobId: "unfulfilled-generate-job", renderJobId: "unfulfilled-generate-job-render",
    });
    assert.equal(unfulfilled.kind, "ready", JSON.stringify(unfulfilled));
    assert.equal(
      unfulfilled.kind === "ready" ? unfulfilled.incident : null,
      "provider_generate_unfulfilled",
      "an unfulfilled generate is filed as itself, never as a HeyGen quota event",
    );
    assert.equal(unfulfilled.kind === "ready" ? unfulfilled.amount : null, 2);
    assert.equal(unfulfilled.kind === "ready" ? unfulfilled.funding : null, "minutes");
    assert.equal(
      unfulfilled.kind === "ready" ? (await applyAvatarQuotaRefund(unfulfilled)).kind : null,
      "refunded",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: unfulfilledUser.id } })).minutesUsed,
      1,
      "exactly the 2 minutes reserved by the unfulfilled generate come back, and the engaged job keeps its 1",
    );
    assert.equal(
      (await prisma.renderJob.findUniqueOrThrow({ where: { id: "unfulfilled-generate-job-render" } })).reservedQuota,
      false,
      "the settled reservation is released, so a rerun cannot refund it again",
    );

    const unfulfilledJob = await prisma.videoJob.findUniqueOrThrow({ where: { id: "unfulfilled-generate-job" } });
    assert.equal(unfulfilledJob.errorCode, null, "an unfulfilled generate is never restamped as a quota error");
    assert.equal(unfulfilledJob.errorProvider, "heygen", "the original provider record stays untouched");

    const repeatUnfulfilled = await inspectAvatarQuotaRefund({
      videoJobId: "unfulfilled-generate-job", renderJobId: "unfulfilled-generate-job-render",
    });
    assert.equal(repeatUnfulfilled.kind, "already_settled", JSON.stringify(repeatUnfulfilled));
    assert.equal(
      repeatUnfulfilled.kind === "already_settled" ? (await applyAvatarQuotaRefund(repeatUnfulfilled)).kind : null,
      "already_settled",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: unfulfilledUser.id } })).minutesUsed,
      1,
      "a repeat run never refunds twice",
    );
    console.log("ok: a generate the provider never fulfilled refunds its minutes without an attestation");
  }

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
