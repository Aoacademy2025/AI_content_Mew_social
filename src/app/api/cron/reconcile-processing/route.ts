import { NextResponse } from "next/server";
import { applyProcessingReconcile, getProcessingReconcilePlan } from "@/lib/video-reconcile";
import { sweepDeadRenderJobs } from "@/lib/render/job-store";
import { apiError } from "@/lib/api-error";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import { writeCronHeartbeat } from "@/lib/cron-heartbeat";

export const runtime = "nodejs";

function parseBool(value: string | null, fallback: boolean) {
  if (value == null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

// GET /api/cron/reconcile-processing
// Conservative backstop for videos that have a completed output file but remain
// PROCESSING after the editor/client missed its final status update.
// Fails CLOSED if CRON_SECRET is unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const dryRun = parseBool(url.searchParams.get("dryRun"), true);
    const failMissingOutput = parseBool(url.searchParams.get("failMissingOutput"), false);

    const plan = await getProcessingReconcilePlan({
      staleAfterMinutes: url.searchParams.get("staleAfterMinutes") ?? 180,
      failAfterHours: url.searchParams.get("failAfterHours") ?? 24,
      limit: url.searchParams.get("limit") ?? 50,
    });
    const applied = dryRun ? null : await applyProcessingReconcile(plan, { failMissingOutput });

    console.log(
      `[reconcile-processing] ${new Date().toISOString()} dryRun=${dryRun} ` +
      `stale=${plan.summary.total} completeCandidates=${plan.summary.completeCandidates} ` +
      `failCandidates=${plan.summary.failCandidates} appliedCompleted=${applied?.completed ?? 0} ` +
      `appliedFailed=${applied?.failed ?? 0}`,
    );

    // RenderJob sweeper backstop: flip RUNNING jobs with a stale heartbeat (worker dead)
    // back to QUEUED/FAILED. Fail-open — a sweep error must never break the reconcile response.
    let sweptRenderJobs = 0;
    try {
      sweptRenderJobs = await sweepDeadRenderJobs(90_000);
      if (sweptRenderJobs > 0)
        console.log(`[reconcile-processing] swept ${sweptRenderJobs} dead RenderJob(s)`);
    } catch (sweepErr) {
      console.error("[reconcile-processing] sweepDeadRenderJobs error (non-fatal):", sweepErr);
    }

    writeCronHeartbeat("reconcile-processing");
    return NextResponse.json({
      ok: true,
      dryRun,
      options: { ...plan.options, failMissingOutput },
      summary: plan.summary,
      applied,
      sweptRenderJobs,
    });
  } catch (error) {
    return apiError({ route: "GET /api/cron/reconcile-processing", error });
  }
}
