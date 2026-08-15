import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/clerk-auth";
import {
  HeroVoiceGenerationError,
  startHeroVoiceGeneration,
} from "@/lib/hero-voice-generation.server";
import { publicAiGenerationJob } from "@/lib/ai-generation-jobs.server";
import {
  isOmniVoiceUserAllowed,
  isValidOmniVoiceId,
  OmniVoiceConfigError,
} from "@/lib/omnivoice";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import { polishScriptForTts } from "@/lib/tts-script-polish";
import { isUserVoiceId, loadUserVoiceRef } from "@/lib/user-voices.server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isOmniVoiceUserAllowed(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const voiceId = typeof body?.voiceId === "string" ? body.voiceId.trim() : "";
    const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    const parsedSpeed = typeof body?.speed === "number" ? body.speed : Number(body?.speed);
    const speed = Number.isFinite(parsedSpeed) ? Math.min(3, Math.max(0.3, parsedSpeed)) : 1;
    if (!isValidOmniVoiceId(voiceId)) {
      return NextResponse.json({ error: "voiceId ไม่ถูกต้อง" }, { status: 400 });
    }
    if (!/^[A-Za-z0-9:_-]{8,107}$/.test(idempotencyKey)) {
      return NextResponse.json({ error: "idempotencyKey ไม่ถูกต้อง" }, { status: 400 });
    }
    // Namespace the caller-minted key server-side — the same rule AI Studio images
    // already apply (`studio:`). Without it a caller could mint `video:<jobId>:scene:0`
    // here, and the image reservation's existing-row short-circuit
    // (createReservedImageJob) would adopt this voice row as that image's reservation —
    // generating an image with NO credit debit. 107 + "studio-voice:" keeps the stored
    // key inside the 120-character contract the other namespaces observe.
    const storedIdempotencyKey = `studio-voice:${idempotencyKey}`;

    // Custom clone voices (user_*) — admin-only v1; verify ownership up front
    // so we fail BEFORE reserving quota (the durable submit re-resolves later).
    if (isUserVoiceId(voiceId)) {
      if (user.role !== "ADMIN") return NextResponse.json({ error: "Not found" }, { status: 404 });
      const ref = await loadUserVoiceRef(user.id, voiceId);
      if (!ref) return NextResponse.json({ error: "ไม่พบเสียงโคลนนี้" }, { status: 404 });
    }

    // Silent pre-TTS polish (fail-open) — same rule as the video-editor route:
    // the polished text is what gets chunked, spoken, and timed, so subtitles
    // always match the audio.
    const polishedText = text
      ? (await polishScriptForTts(
          { id: user.id, geminiKey: user.geminiKey, plan: user.plan },
          text,
          omnivoiceScriptCharCapForPlan(user.plan),
        )).text
      : text;

    const result = await startHeroVoiceGeneration({
      userId: user.id,
      plan: user.plan,
      text: polishedText,
      voiceId,
      speed,
      studio: true,
      idempotencyKey: storedIdempotencyKey,
    });
    return NextResponse.json(
      { job: publicAiGenerationJob(result.job) },
      { status: result.job.status === "completed" ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof HeroVoiceGenerationError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, { status: error.status });
    }
    if (error instanceof OmniVoiceConfigError) {
      return NextResponse.json({ error: "Hero Voice ยังไม่พร้อมใช้งาน", retryable: true }, { status: 503 });
    }
    console.error("[ai-studio/voices] request failed:", error);
    return NextResponse.json({ error: "ส่งงานสร้างเสียงไม่สำเร็จ", retryable: true }, { status: 500 });
  }
}
