import { NextResponse } from "next/server";
import { cancelByJobId, getRenderJob, setRenderJob } from "@/app/api/videos/render/cancel-registry";
export const runtime = "nodejs";

// Called via sendBeacon on page unload — browser does NOT send auth cookies with sendBeacon.
// Security model: jobId = "{userId}-{timestamp}-{random}" is treated as an unguessable token.
// Only the browser that started the render knows the jobId, so no auth check needed.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return NextResponse.json({ error: "invalid jobId" }, { status: 400 });
  }

  const cancelFn = cancelByJobId.get(jobId);
  if (cancelFn) {
    cancelFn();
    cancelByJobId.delete(jobId);
    console.log(`[Render] job=${jobId} cancelled via page unload`);
  }

  const existing = getRenderJob(jobId);
  if (existing && existing.status === "running") {
    setRenderJob(jobId, { status: "error", error: "cancelled", startedAt: existing.startedAt });
  }

  return new Response(null, { status: 204 });
}
