import { NextResponse } from "next/server";
import {
  sweepStaleReservedImageJobs,
  SWEEP_DEFAULT_LIMIT,
  SWEEP_DEFAULT_STALE_MINUTES,
  SWEEP_MAX_LIMIT,
  SWEEP_MAX_STALE_MINUTES,
  SWEEP_MIN_LIMIT,
  SWEEP_MIN_STALE_MINUTES,
} from "@/lib/ai-image-reconcile";
import { apiError } from "@/lib/api-error";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";
import { sweepStaleUnlinkedBrandLookPreviewItems } from "@/lib/brand-look-preview-job-link.server";
import { resumeBrandLookPreviewBatch } from "@/lib/brand-look-preview.server";

export const runtime = "nodejs";
export const maxDuration = 900;

function parseBool(value: string | null, fallback: boolean) {
  if (value == null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// GET /api/cron/reconcile-ai-images
// Money-safety backstop for AI image credit reservations that stay at
// chargeState="reserved" after a provider status outage or a hard deadline: each
// stale job is polled once and then settled (image delivered, charge stands) or
// refunded. Idempotent — the chargeState guards inside the shared helpers make a
// re-run a no-op. Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const dryRun = parseBool(url.searchParams.get("dryRun"), true);
    const olderThanMinutes = parseBoundedInt(
      url.searchParams.get("olderThanMinutes"),
      SWEEP_DEFAULT_STALE_MINUTES,
      SWEEP_MIN_STALE_MINUTES,
      SWEEP_MAX_STALE_MINUTES,
    );
    const limit = parseBoundedInt(
      url.searchParams.get("limit"),
      SWEEP_DEFAULT_LIMIT,
      SWEEP_MIN_LIMIT,
      SWEEP_MAX_LIMIT,
    );

    const summary = await sweepStaleReservedImageJobs({ olderThanMinutes, limit, dryRun });
    const previewSummary = await sweepStaleUnlinkedBrandLookPreviewItems({
      olderThanMinutes,
      limit,
      dryRun,
    });
    const previewRecoveryResults = dryRun
      ? []
      : await Promise.allSettled(
          previewSummary.batchIds.slice(0, 3).map((batchId) => resumeBrandLookPreviewBatch(batchId)),
        );
    const previewResumed = previewRecoveryResults.filter((result) =>
      result.status === "fulfilled" && result.value !== null).length;
    const previewRecoveryErrors = previewRecoveryResults.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : []);

    console.log(
      `[reconcile-ai-images] ${new Date().toISOString()} dryRun=${dryRun} ` +
      `olderThanMinutes=${summary.olderThanMinutes} limit=${summary.limit} ` +
      `scanned=${summary.scanned} settled=${summary.settled} refunded=${summary.refunded} ` +
      `refundedCredits=${summary.refundedCredits} skipped=${summary.skipped} errors=${summary.errors.length} ` +
      `previewOrphans=${previewSummary.scanned} previewResumable=${previewSummary.resumable} ` +
      `previewResumed=${previewResumed} previewFailed=${previewSummary.failed} ` +
      `previewRecoveryErrors=${previewRecoveryErrors.length}`,
    );

    writeCronHeartbeat("reconcile-ai-images");
    return NextResponse.json({
      ok: true,
      dryRun,
      options: { olderThanMinutes: summary.olderThanMinutes, limit: summary.limit },
      summary,
      previewSummary,
      previewRecovery: { resumed: previewResumed, errors: previewRecoveryErrors },
    });
  } catch (error) {
    return apiError({ route: "GET /api/cron/reconcile-ai-images", error });
  }
}
