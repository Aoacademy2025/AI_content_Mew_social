import { NextResponse } from "next/server";
import { heartbeatStoryFilmGenerationJob } from "@/lib/story-film-generation-queue.server";
import { isStoryFilmWorkerAuthorized } from "@/lib/story-film-worker-auth.server";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isStoryFilmWorkerAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const result = await heartbeatStoryFilmGenerationJob({
      jobId: id,
      workerId: typeof body?.workerId === "string" ? body.workerId : "",
      leaseToken: typeof body?.leaseToken === "string" ? body.leaseToken : "",
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: "invalid_or_expired_lease", message: error instanceof Error ? error.message : "Heartbeat failed" }, { status: 409 });
  }
}
