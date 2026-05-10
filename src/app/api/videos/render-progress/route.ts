import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import path from "path";
import fs from "fs";

import { authOptions } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  const renderTmpDir = process.env.RENDER_TMP_ROOT
    ? path.resolve(process.env.RENDER_TMP_ROOT)
    : path.join(process.cwd(), ".tmp", "remotion");

  // If jobId provided, read job-specific progress file
  const progressFile = jobId
    ? path.join(renderTmpDir, `render-progress-${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
    : path.join(renderTmpDir, `render-progress-${session.user.id}.json`);

  try {
    const raw = await fs.promises.readFile(progressFile, "utf-8");
    const parsed = JSON.parse(raw) as { progress?: number; videoUrl?: string; error?: string };
    const progress = Number(parsed?.progress);
    return NextResponse.json({
      progress: Number.isFinite(progress) ? progress : 0,
      videoUrl: parsed?.videoUrl ?? null,
      error: parsed?.error ?? null,
    });
  } catch {
    return NextResponse.json({ progress: 0, videoUrl: null, error: null });
  }
}
