import { heroVoiceClonePrivateJson } from "@/lib/hero-voice-clone-response.server";

import { heroVoiceCanaryJcsBytes, parseHeroVoiceCanaryStrictJson } from "@/lib/hero-voice-canary-canonical";
import {
  authenticateHeroVoiceCanaryHttpRequest,
  HeroVoiceCanaryHttpError,
  parseHeroVoiceCanaryIfMatch,
} from "@/lib/hero-voice-canary-http.server";
import {
  HeroVoiceCanaryReviewError,
  parseHeroVoiceCanaryScore,
  putHeroVoiceCanaryScore,
} from "@/lib/hero-voice-canary-review.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ runId: string; pairId: string }> }) {
  try {
    const actor = await authenticateHeroVoiceCanaryHttpRequest();
    const expectedRevision = parseHeroVoiceCanaryIfMatch(request);
    const { runId, pairId } = await context.params;
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 2_048) throw new HeroVoiceCanaryReviewError("CANARY_SCORE_INVALID", 400);
    const parsed = parseHeroVoiceCanaryStrictJson(bytes);
    if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes)) throw new HeroVoiceCanaryReviewError("CANARY_SCORE_INVALID", 400);
    const score = parseHeroVoiceCanaryScore(parsed, pairId);
    const result = await putHeroVoiceCanaryScore({ runId, pairId, ownerHmac: actor.ownerHmac, expectedRevision, score });
    return heroVoiceClonePrivateJson(result);
  } catch (error) {
    const status = error instanceof HeroVoiceCanaryHttpError ? error.status
      : error instanceof HeroVoiceCanaryReviewError ? error.status : 409;
    return heroVoiceClonePrivateJson({ error: status === 401 ? "Unauthorized" : status === 404 ? "Not found" : "Review conflict" }, {
      status,
    });
  }
}
