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
    const status =
      job.status === "DONE"
        ? "done"
        : job.status === "FAILED" || job.status === "CANCELLED"
        ? "error"
        : "running";
    return NextResponse.json({
      status,
      progress: job.progress,
      videoUrl: job.videoUrl ?? undefined,
      error: job.error ?? undefined,
    });
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
