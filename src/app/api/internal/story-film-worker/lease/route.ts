import { NextResponse } from "next/server";
import {
  leaseStoryFilmGenerationJobs,
  type StoryFilmProviderBackend,
} from "@/lib/story-film-generation-queue.server";
import { isStoryFilmWorkerAuthorized } from "@/lib/story-film-worker-auth.server";

export const runtime = "nodejs";

const BACKENDS = new Set<StoryFilmProviderBackend>([
  "grok_subscription",
  "hero_voice",
  "hero_text",
  "vidiq",
  "hero_render",
]);

export async function POST(request: Request) {
  if (!isStoryFilmWorkerAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const workerId = typeof body?.workerId === "string" ? body.workerId : "";
    const providerBackends = Array.isArray(body?.providerBackends)
      ? body.providerBackends.filter((value): value is StoryFilmProviderBackend => typeof value === "string" && BACKENDS.has(value as StoryFilmProviderBackend))
      : [];
    const maxJobs = typeof body?.maxJobs === "number" ? body.maxJobs : 1;
    const jobs = await leaseStoryFilmGenerationJobs({ workerId, providerBackends, maxJobs });
    return NextResponse.json({ jobs });
  } catch (error) {
    return NextResponse.json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid lease request",
    }, { status: 400 });
  }
}
