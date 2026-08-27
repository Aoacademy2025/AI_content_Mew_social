import { NextResponse } from "next/server";
import { markStoryFilmGenerationSubmitted } from "@/lib/story-film-generation-queue.server";
import { isStoryFilmWorkerAuthorized } from "@/lib/story-film-worker-auth.server";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isStoryFilmWorkerAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const result = await markStoryFilmGenerationSubmitted({
      jobId: id,
      workerId: typeof body?.workerId === "string" ? body.workerId : "",
      leaseToken: typeof body?.leaseToken === "string" ? body.leaseToken : "",
      providerJobId: typeof body?.providerJobId === "string" ? body.providerJobId : "",
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: "invalid_submission", message: error instanceof Error ? error.message : "Submission failed" }, { status: 409 });
  }
}
