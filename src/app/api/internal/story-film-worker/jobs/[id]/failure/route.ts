import { NextResponse } from "next/server";
import { failStoryFilmGenerationJob } from "@/lib/story-film-generation-queue.server";
import { isStoryFilmWorkerAuthorized } from "@/lib/story-film-worker-auth.server";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isStoryFilmWorkerAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const result = await failStoryFilmGenerationJob({
      jobId: id,
      workerId: typeof body?.workerId === "string" ? body.workerId : "",
      leaseToken: typeof body?.leaseToken === "string" ? body.leaseToken : "",
      errorCode: typeof body?.errorCode === "string" ? body.errorCode : "technical_failure",
      errorMessage: typeof body?.errorMessage === "string" ? body.errorMessage : "Generation failed",
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: "invalid_failure_report", message: error instanceof Error ? error.message : "Failure report failed" }, { status: 409 });
  }
}
