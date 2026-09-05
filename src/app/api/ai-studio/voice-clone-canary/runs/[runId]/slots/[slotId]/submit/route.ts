import { heroVoiceClonePrivateJson } from "@/lib/hero-voice-clone-response.server";

import {
  assertHeroVoiceCanaryLoopbackSubmitRequest,
} from "@/lib/hero-voice-canary-auth.server";
import { HeroVoiceGenerationError } from "@/lib/hero-voice-generation.server";
import { authenticateHeroVoiceCanaryHttpRequest, HeroVoiceCanaryHttpError } from "@/lib/hero-voice-canary-http.server";
import { submitHeroVoiceCanarySlotRequest } from "@/lib/hero-voice-canary-submit.server";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return heroVoiceClonePrivateJson({ error: "Not found" }, { status: 404 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; slotId: string }> },
) {
  try {
    assertHeroVoiceCanaryLoopbackSubmitRequest(request);
    const actor = await authenticateHeroVoiceCanaryHttpRequest();
    if (!heroVoiceCloneCanaryAccessDecision(actor.user).allowed) return notFound();
    const { runId, slotId } = await context.params;

    const job = await submitHeroVoiceCanarySlotRequest({
      actor: actor.user,
      ownerHmac: actor.ownerHmac,
      runId,
      slotId,
      requestBytes: Buffer.from(await request.arrayBuffer()),
    });
    return heroVoiceClonePrivateJson({ job }, { status: 202 });
  } catch (error) {
    if (error instanceof HeroVoiceCanaryHttpError) {
      return error.status === 401 ? heroVoiceClonePrivateJson({ error: "Unauthorized" }, { status: 401 }) : notFound();
    }
    if (error instanceof HeroVoiceGenerationError) {
      return error.status === 404 ? notFound() : heroVoiceClonePrivateJson({ error: "Canary submission failed" }, { status: error.status });
    }
    if (error instanceof Error && error.message === "canary_submit_not_found") return notFound();
    return heroVoiceClonePrivateJson({ error: "Canary submission failed" }, { status: 500 });
  }
}
