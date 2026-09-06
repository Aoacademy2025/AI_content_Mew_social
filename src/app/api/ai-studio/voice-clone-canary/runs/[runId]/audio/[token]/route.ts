import { NextResponse } from "next/server";
import { heroVoiceClonePrivateJson, heroVoiceClonePrivateResponse } from "@/lib/hero-voice-clone-response.server";

import { authenticateHeroVoiceCanaryHttpRequest, HeroVoiceCanaryHttpError } from "@/lib/hero-voice-canary-http.server";
import { parseHeroVoiceCanaryAudioRange } from "@/lib/hero-voice-canary-range";
import { HeroVoiceCanaryReviewError, readHeroVoiceCanaryReviewAudio } from "@/lib/hero-voice-canary-review.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string; token: string }> }) {
  try {
    const actor = await authenticateHeroVoiceCanaryHttpRequest();
    const { runId, token } = await context.params;
    const bytes = await readHeroVoiceCanaryReviewAudio({ runId, token, ownerHmac: actor.ownerHmac });
    const range = parseHeroVoiceCanaryAudioRange(request.headers.get("range"), bytes.length);
    if (!range) return heroVoiceClonePrivateResponse(new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${bytes.length}` },
    }));
    const [start, end] = range;
    const body = bytes.subarray(start, end + 1);
    const partial = request.headers.has("range");
    return heroVoiceClonePrivateResponse(new NextResponse(body as unknown as BodyInit, {
      status: partial ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length),
        "Content-Type": "audio/wav",
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
    }));
  } catch (error) {
    const status = error instanceof HeroVoiceCanaryHttpError ? error.status
      : error instanceof HeroVoiceCanaryReviewError && error.status === 404 ? 404 : 503;
    return heroVoiceClonePrivateJson({ error: status === 401 ? "Unauthorized" : status === 404 ? "Not found" : "Audio unavailable" }, {
      status,
    });
  }
}
