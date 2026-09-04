import { NextResponse } from "next/server";

import {
  authenticateHeroVoiceCanaryHttpRequest,
  heroVoiceCanaryGitAuthority,
  HeroVoiceCanaryHttpError,
} from "@/lib/hero-voice-canary-http.server";
import { getHeroVoiceCanaryReview, HeroVoiceCanaryReviewError } from "@/lib/hero-voice-canary-review.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const actor = await authenticateHeroVoiceCanaryHttpRequest();
    const { runId } = await context.params;
    return NextResponse.json(await getHeroVoiceCanaryReview({
      runId,
      ownerHmac: actor.ownerHmac,
      authority: heroVoiceCanaryGitAuthority(),
    }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof HeroVoiceCanaryHttpError ? error.status
      : error instanceof HeroVoiceCanaryReviewError && error.status === 404 ? 404 : 503;
    return NextResponse.json({ error: status === 401 ? "Unauthorized" : status === 404 ? "Not found" : "Review unavailable" }, {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
