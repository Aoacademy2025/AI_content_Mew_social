import { heroVoiceClonePrivateJson as privateJson } from "@/lib/hero-voice-clone-response.server";

import { getCurrentUser } from "@/lib/clerk-auth";
import {
  HeroVoiceGenerationError,
  startHeroVoiceGeneration,
} from "@/lib/hero-voice-generation.server";
import { publicAiGenerationJob } from "@/lib/ai-generation-jobs.server";
import {
  HeroVoiceCloneConfigError,
  OmniVoiceConfigError,
} from "@/lib/omnivoice";
import { normalizeHeroVoiceClonePublicJob } from "@/lib/hero-voice-clone-state";
import { isUserVoiceId } from "@/lib/user-voices.server";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";
import { heroVoiceCanaryDeletionConfigured } from "@/lib/hero-voice-canary-storage.server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    // The fully marked harness has one mutation entrance: submit-by-slot. Do
    // this before ordinary auth so the canary cannot trigger lazy Clerk/trial
    // writes through the customer route.
    if (process.env.HERO_VOICE_CANARY_EXECUTION_MODE === "1" && heroVoiceCanaryDeletionConfigured()) {
      return privateJson({ error: "Not found" }, { status: 404 });
    }
    const user = await getCurrentUser();
    const access = heroVoiceCloneCanaryAccessDecision(user);
    if (!access.allowed) {
      return privateJson(
        { error: access.status === 401 ? "Unauthorized" : "Not found" },
        { status: access.status },
      );
    }
    if (!user) throw new Error("clone canary access decision admitted a missing actor");

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const voiceId = typeof body?.voiceId === "string" ? body.voiceId.trim() : "";
    const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    const parsedSpeed = typeof body?.speed === "number" ? body.speed : Number(body?.speed);
    const speed = Number.isFinite(parsedSpeed) ? Math.min(3, Math.max(0.3, parsedSpeed)) : 1;
    // Stock IDs and malformed/non-owned clone IDs are deliberately
    // indistinguishable from missing resources on this canary-only surface.
    if (!isUserVoiceId(voiceId)) {
      return privateJson({ error: "Not found" }, { status: 404 });
    }
    if (!/^[A-Za-z0-9:_-]{8,107}$/.test(idempotencyKey)) {
      return privateJson({ error: "idempotencyKey ไม่ถูกต้อง" }, { status: 400 });
    }
    // Namespace the caller-minted key server-side — the same rule AI Studio images
    // already apply (`studio:`). Without it a caller could mint `video:<jobId>:scene:0`
    // here, and the image reservation's existing-row short-circuit
    // (createReservedImageJob) would adopt this voice row as that image's reservation —
    // generating an image with NO credit debit. 107 + "studio-voice:" keeps the stored
    // key inside the 120-character contract the other namespaces observe.
    const storedIdempotencyKey = `studio-voice:${idempotencyKey}`;

    const result = await startHeroVoiceGeneration({
      userId: user.id,
      plan: user.plan,
      text,
      voiceId,
      speed,
      studio: true,
      cloneCanarySurface: "ai-studio",
      idempotencyKey: storedIdempotencyKey,
    });
    return privateJson(
      { job: normalizeHeroVoiceClonePublicJob(publicAiGenerationJob(result.job)) },
      { status: result.job.status === "completed" ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof HeroVoiceGenerationError) {
      return privateJson({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, { status: error.status });
    }
    if (error instanceof HeroVoiceCloneConfigError) {
      return privateJson({
        error: "Hero Voice clone ยังไม่พร้อมใช้งาน",
        code: error.code,
        retryable: false,
      }, { status: 503 });
    }
    if (error instanceof OmniVoiceConfigError) {
      return privateJson({ error: "Hero Voice ยังไม่พร้อมใช้งาน", retryable: true }, { status: 503 });
    }
    console.error("[ai-studio/voices] request failed:", error);
    return privateJson({ error: "ส่งงานสร้างเสียงไม่สำเร็จ", retryable: true }, { status: 500 });
  }
}
