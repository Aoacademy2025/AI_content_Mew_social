import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";

type RenderJob = {
  status: "running" | "done" | "error";
  videoUrl?: string;
  error?: string;
  startedAt: number;
  progress?: number;
  userId?: string; // owner — set by the render route's setRenderJob for ownership checks
};

function jobFilePath(jobId: string): string {
  const d = path.join(process.cwd(), ".tmp", "render-jobs");
  return path.join(d, `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function readJob(jobId: string): RenderJob | undefined {
  try {
    const raw = fs.readFileSync(jobFilePath(jobId), "utf-8");
    return JSON.parse(raw) as RenderJob;
  } catch { return undefined; }
}

export async function GET(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const job = readJob(jobId);
  if (!job) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }
  // Ownership check: prevent reading another user's job result by jobId. Jobs created
  // before this field existed lack userId; enforce only when present (fail-open during
  // the brief post-deploy window — this legacy path is dev/fallback, prod uses the queue).
  if (job.userId && job.userId !== authUser.id) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  // ให้ render นานได้ถึง 3 ชั่วโมง รองรับคลิปยาว 10 นาที
  const staleMs = 3 * 60 * 60 * 1000;
  if (job.status === "running" && job.startedAt && Date.now() - job.startedAt > staleMs) {
    return NextResponse.json({ status: "error", error: "Render ใช้เวลานานเกิน 3 ชั่วโมง — กรุณาลองใหม่" });
  }

  return NextResponse.json({
    status: job.status,
    videoUrl: job.videoUrl,
    error: job.error,
  });
}
