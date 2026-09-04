import { NextResponse } from "next/server";

import {
  authenticateHeroVoiceCanaryHttpRequest,
  heroVoiceCanaryGitAuthority,
  HeroVoiceCanaryHttpError,
  parseHeroVoiceCanaryIfMatch,
} from "@/lib/hero-voice-canary-http.server";
import { HeroVoiceCanaryReviewError, lockHeroVoiceCanaryReview } from "@/lib/hero-voice-canary-review.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const actor = await authenticateHeroVoiceCanaryHttpRequest();
    if ((await request.arrayBuffer()).byteLength !== 0) throw new Error("body_not_allowed");
    const { runId } = await context.params;
    const result = await lockHeroVoiceCanaryReview({
      runId, ownerHmac: actor.ownerHmac, expectedRevision: parseHeroVoiceCanaryIfMatch(request),
      authority: heroVoiceCanaryGitAuthority(),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof HeroVoiceCanaryHttpError ? error.status
      : error instanceof HeroVoiceCanaryReviewError ? error.status : 409;
    return NextResponse.json({ error: status === 401 ? "Unauthorized" : status === 404 ? "Not found" : "Review conflict" }, {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
