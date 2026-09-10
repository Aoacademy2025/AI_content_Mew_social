import { prisma } from "@/lib/prisma";
import { parseAvatarProviderCheckpoint } from "@/lib/mcp/avatar-provider-checkpoint";
import {
  refundRenderReservationById,
  summarizeRenderReservationFunding,
  type RenderReservationRefundResult,
} from "@/lib/render/reservation-settlement";

const LEGACY_UNKNOWN_OUTCOME = "avatar generate has unknown provider outcome - manual recovery required";
/**
 * HERO-14: the orchestrator refused a checkpoint it had written itself, and the job
 * died at `intro_wait` after HeyGen had generated and billed the intro video. The
 * customer is owed those minutes for the same reason the quota incident owes them —
 * we engaged the paid provider and then abandoned the render through our own fault.
 */
const CHECKPOINT_UNREADABLE = "invalid avatar provider checkpoint - manual recovery required";

/**
 * HERO-18: the legacy unknown-outcome message also covers generate calls the provider
 * definitively refused (a 404 that our own route reported as a 500) and generate calls
 * whose response was lost. Both leave the checkpoint at `intro_generate` with no
 * `avatar.introVideoId`, which is machine-checkable proof that no provider video was
 * ever delivered to us and therefore that nothing was rendered for the customer. That
 * is a stronger fact than the `--confirmed-heygen-402` attestation the legacy path asks
 * for, so this shape needs no human evidence. A `tail_generate` checkpoint is excluded
 * on purpose: it can only exist after the intro was delivered.
 */
function generateUnfulfilled(providerCheckpointJson: string | null): boolean {
  const checkpoint = parseAvatarProviderCheckpoint(providerCheckpointJson);
  return checkpoint?.phase === "intro_generate" && !checkpoint.avatar.introVideoId;
}

export type AvatarQuotaRefundInspection =
  | { kind: "rejected"; videoJobId: string; reason: string }
  | {
      kind: "ready" | "already_settled";
      videoJobId: string;
      renderJobId: string;
      userId: string;
      /** Which incident opened the gate — the refund reason and any error-code
       *  normalisation follow from this, so a checkpoint failure is never filed
       *  as a HeyGen quota event. */
      incident: "heygen_quota" | "checkpoint_unreadable" | "provider_generate_unfulfilled";
      funding: "minutes" | "credits" | "clips";
      amount: number;
      legacyEvidenceRequired: boolean;
      guard: {
        videoJobUpdatedAt: string;
        errorMessage: string;
      };
    };

function rejected(videoJobId: string, reason: string): AvatarQuotaRefundInspection {
  return { kind: "rejected", videoJobId, reason };
}

function avatarInput(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { avatarMode?: unknown };
    return value.avatarMode === "full" || value.avatarMode === "bookend" || value.avatarMode === "bookend-both";
  } catch {
    return false;
  }
}

/** Discover one exact, unlinked base render for a failed Avatar quota incident. No writes. */
export async function inspectAvatarQuotaRefund(input: {
  videoJobId: string;
  renderJobId: string;
  confirmedLegacyHeygen402?: boolean;
}): Promise<AvatarQuotaRefundInspection> {
  const job = await prisma.videoJob.findUnique({ where: { id: input.videoJobId } });
  if (!job) return rejected(input.videoJobId, "video_job_not_found");
  if (job.status !== "failed" || job.currentStep !== "avatar" || job.outputJson !== null) {
    return rejected(job.id, "video_job_not_failed_at_avatar");
  }
  if (!avatarInput(job.inputJson)) return rejected(job.id, "avatar_input_not_confirmed");

  // The checkpoint incident proves itself and needs no human attestation: a job that
  // failed on this message still stores the checkpoint, and an `intro_wait` phase
  // carrying `avatar.introVideoId` is machine-checkable evidence that HeyGen accepted
  // and generated the intro video before we abandoned it. That is stronger than the
  // flag the legacy unknown-outcome path has to rely on.
  const checkpointUnreadable = job.errorMessage?.includes(CHECKPOINT_UNREADABLE) ?? false;
  if (checkpointUnreadable) {
    const checkpoint = parseAvatarProviderCheckpoint(job.providerCheckpointJson);
    if (!checkpoint?.avatar.introVideoId) {
      return rejected(job.id, "checkpoint_provider_engagement_not_confirmed");
    }
  }
  const structuredQuota = job.errorProvider === "heygen" && job.errorCode === "quota";
  // R32: the orchestrator's terminal catch (Task 5 / R31) may now wrap this exact
  // internal (non-Thai, non-envelope) cause in a "<prefix> (<code>): <cause>" form —
  // match by substring, not exact equality, so both the verbatim legacy shape (seeded
  // directly, or produced before this wrapping existed) and the wrapped form still gate
  // this money-refund path correctly.
  const legacyUnknown = job.errorMessage?.includes(LEGACY_UNKNOWN_OUTCOME) ?? false;
  const unfulfilledGenerate = legacyUnknown && !checkpointUnreadable && generateUnfulfilled(job.providerCheckpointJson);
  if (!structuredQuota && !legacyUnknown && !checkpointUnreadable) {
    return rejected(job.id, "heygen_quota_error_not_confirmed");
  }
  if (
    !structuredQuota
    && !checkpointUnreadable
    && !unfulfilledGenerate
    && legacyUnknown
    && !input.confirmedLegacyHeygen402
  ) {
    return rejected(job.id, "legacy_unknown_requires_confirmed_heygen_402");
  }

  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt;
  if (!end) return rejected(job.id, "video_job_missing_finished_at");
  const render = await prisma.renderJob.findFirst({
    where: {
      id: input.renderJobId,
      userId: job.userId,
      type: "RENDER",
      status: "DONE",
      OR: [{ parentJobId: null }, { parentJobId: job.id }],
      createdAt: { gte: start, lte: end },
    },
  });
  if (!render) return rejected(job.id, "reviewed_base_render_mismatch");

  const funding = summarizeRenderReservationFunding(render);
  return {
    kind: render.reservedQuota ? "ready" : "already_settled",
    videoJobId: job.id,
    renderJobId: render.id,
    userId: job.userId,
    incident: structuredQuota
      ? "heygen_quota"
      : checkpointUnreadable
        ? "checkpoint_unreadable"
        : unfulfilledGenerate
          ? "provider_generate_unfulfilled"
          : "heygen_quota",
    ...funding,
    legacyEvidenceRequired: legacyUnknown,
    guard: {
      videoJobUpdatedAt: job.updatedAt.toISOString(),
      errorMessage: job.errorMessage ?? "",
    },
  };
}

/** Apply only a reviewed inspection receipt; exact reservation settlement remains idempotent. */
export async function applyAvatarQuotaRefund(
  inspection: Exclude<AvatarQuotaRefundInspection, { kind: "rejected" }>,
): Promise<RenderReservationRefundResult> {
  const unchanged = await prisma.videoJob.findFirst({
    where: {
      id: inspection.videoJobId,
      userId: inspection.userId,
      status: "failed",
      currentStep: "avatar",
      outputJson: null,
      updatedAt: new Date(inspection.guard.videoJobUpdatedAt),
      errorMessage: inspection.guard.errorMessage,
    },
    select: { id: true },
  });
  if (!unchanged) return { kind: "not_found" };

  const result = await refundRenderReservationById({
    renderJobId: inspection.renderJobId,
    userId: inspection.userId,
    reason: inspection.incident === "checkpoint_unreadable"
      ? "avatar-checkpoint-unreadable"
      : inspection.incident === "provider_generate_unfulfilled"
        ? "avatar-generate-unfulfilled"
        : "legacy-avatar-heygen-quota",
  });
  // The quota path normalises the legacy free-text failure into structured codes.
  // The checkpoint and unfulfilled-generate paths must NOT: their codes already
  // describe what happened, and restamping either as a HeyGen quota event would
  // falsify the incident record the HERO-14 and HERO-18 observation windows read.
  if (inspection.incident === "heygen_quota"
    && (result.kind === "refunded" || result.kind === "already_settled")) {
    await prisma.videoJob.updateMany({
      where: { id: inspection.videoJobId, userId: inspection.userId, status: "failed" },
      data: { errorCode: "quota", errorProvider: "heygen" },
    });
  }
  return result;
}
