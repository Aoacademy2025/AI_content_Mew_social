import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getRenderJob } from "@/lib/render/job-store";
import path from "path";
import fs from "fs";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  // PR-7: durable queue path — read the RenderJob row instead of the .tmp file.
  if (process.env.RENDER_VIA_QUEUE === "1") {
    if (!jobId) {
      return NextResponse.json({ status: "error", error: "jobId required" });
    }
    const job = await getRenderJob(jobId);
    if (!job) return NextResponse.json({ status: "error", error: "job not found" });
    // Ownership check: prevent one user from polling another user's job.
    if (job.userId !== authUser.id) return NextResponse.json({ status: "error", error: "job not found" });
    const stage =
      job.status === "DONE"
        ? "done"
        : job.status === "FAILED" || job.status === "CANCELLED"
        ? "error"
        : "running";
    // Return BOTH `stage` and `status`: the MCP poller (pipeline-client.pollRender)
    // and the legacy progress shape key off `stage`, while other callers may read
    // `status`. Before this, the queue branch returned only `status`, so pollRender's
    // `p.stage` was always undefined → it never saw "done" → every MCP render hit the
    // 15-min timeout ("render timed out") even though the RenderJob was DONE.
    return NextResponse.json({
      stage,
      status: stage,
      progress: job.progress,
      videoUrl: job.videoUrl ?? null,
      error: job.error ?? undefined,
      // Surface the credit-overflow receipt amount ONLY when credits are live, so
      // the response is byte-identical when CREDITS_LIVE is off. getRenderJob reads
      // the full RenderJob row, so job.creditsSpent is already present (no select change).
      ...(process.env.CREDITS_LIVE === "1" ? { creditsSpent: job.creditsSpent ?? null } : {}),
    });
  }

  // Ownership (legacy branch): the prod queue branch above already checks job.userId.
  // For the dev/fallback file path, cross-check the persisted render job's userId
  // (set by the render route) so one user can't read another's progress by jobId.
  if (jobId) {
    try {
      const jobFile = path.join(process.cwd(), ".tmp", "render-jobs", `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
      const job = JSON.parse(fs.readFileSync(jobFile, "utf-8")) as { userId?: string };
      if (job?.userId && job.userId !== authUser.id) {
        return NextResponse.json({
          progress: 0, videoUrl: null, error: null, queued: false, queuePosition: null,
          stage: null, updatedAt: null, queuedAt: null, renderQueueWaitMs: null,
        });
      }
    } catch { /* no job file → legacy/old job, fall through */ }
  }

  const renderTmpDir = process.env.RENDER_TMP_ROOT
    ? path.resolve(process.env.RENDER_TMP_ROOT)
    : path.join(process.cwd(), ".tmp", "remotion");

  // If jobId provided, read job-specific progress file
  const progressFile = jobId
    ? path.join(renderTmpDir, `render-progress-${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
    : path.join(renderTmpDir, `render-progress-${authUser.id}.json`);

  try {
    const raw = await fs.promises.readFile(progressFile, "utf-8");
    const parsed = JSON.parse(raw) as {
      progress?: number;
      videoUrl?: string;
      error?: string;
      queued?: boolean;
      queuePosition?: number | null;
      stage?: string;
      updatedAt?: number;
      queuedAt?: number;
      renderQueueWaitMs?: number;
    };
    const progress = Number(parsed?.progress);
    return NextResponse.json({
      progress: Number.isFinite(progress) ? progress : 0,
      videoUrl: parsed?.videoUrl ?? null,
      error: parsed?.error ?? null,
      queued: parsed?.queued ?? false,
      queuePosition: parsed?.queuePosition ?? null,
      stage: parsed?.stage ?? null,
      updatedAt: parsed?.updatedAt ?? null,
      queuedAt: parsed?.queuedAt ?? null,
      renderQueueWaitMs: parsed?.renderQueueWaitMs ?? null,
    });
  } catch {
    return NextResponse.json({
      progress: 0,
      videoUrl: null,
      error: null,
      queued: false,
      queuePosition: null,
      stage: null,
      updatedAt: null,
      queuedAt: null,
      renderQueueWaitMs: null,
    });
  }
}
