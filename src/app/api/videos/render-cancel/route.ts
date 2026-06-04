import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { cancelByJobId, activeRenderCancel, getRenderJob, setRenderJob } from "@/app/api/videos/render/cancel-registry";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (jobId) {
    const cancelFn = cancelByJobId.get(jobId);
    if (cancelFn) {
      cancelFn();
      cancelByJobId.delete(jobId);
      console.log(`[Render] job=${jobId} cancelled by user ${authUser.id} (unload)`);
    }
    const existing = getRenderJob(jobId);
    if (existing && existing.status === "running") {
      setRenderJob(jobId, { status: "error", error: "cancelled", startedAt: existing.startedAt });
    }
  } else {
    const cancelFn = activeRenderCancel.get(authUser.id);
    if (cancelFn) {
      cancelFn();
      activeRenderCancel.delete(authUser.id);
    }
  }

  return NextResponse.json({ ok: true });
}
