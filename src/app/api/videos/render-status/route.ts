import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRenderJob } from "../render/route";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const job = getRenderJob(jobId);
  if (!job) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  // Stale job detection: if still "running" after 30min, the server process likely restarted mid-render
  const staleMs = 30 * 60 * 1000;
  if (job.status === "running" && job.startedAt && Date.now() - job.startedAt > staleMs) {
    return NextResponse.json({ status: "error", error: "Render timed out — server may have restarted. Please try again." });
  }

  return NextResponse.json({
    status: job.status,
    videoUrl: job.videoUrl,
    error: job.error,
  });
}
