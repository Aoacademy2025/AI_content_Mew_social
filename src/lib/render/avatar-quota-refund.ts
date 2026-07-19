import { prisma } from "@/lib/prisma";
import {
  refundRenderReservationById,
  summarizeRenderReservationFunding,
  type RenderReservationRefundResult,
} from "@/lib/render/reservation-settlement";

const LEGACY_UNKNOWN_OUTCOME = "avatar generate has unknown provider outcome - manual recovery required";

export type AvatarQuotaRefundInspection =
  | { kind: "rejected"; videoJobId: string; reason: string }
  | {
      kind: "ready" | "already_settled";
      videoJobId: string;
      renderJobId: string;
      userId: string;
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

  const structuredQuota = job.errorProvider === "heygen" && job.errorCode === "quota";
  const legacyUnknown = job.errorMessage === LEGACY_UNKNOWN_OUTCOME;
  if (!structuredQuota && !legacyUnknown) return rejected(job.id, "heygen_quota_error_not_confirmed");
  if (!structuredQuota && legacyUnknown && !input.confirmedLegacyHeygen402) {
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
    reason: "legacy-avatar-heygen-quota",
  });
  if (result.kind === "refunded" || result.kind === "already_settled") {
    await prisma.videoJob.updateMany({
      where: { id: inspection.videoJobId, userId: inspection.userId, status: "failed" },
      data: { errorCode: "quota", errorProvider: "heygen" },
    });
  }
  return result;
}
