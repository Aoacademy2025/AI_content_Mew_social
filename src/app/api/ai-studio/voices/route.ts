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

    const result = await startHeroVoiceGeneration({
      userId: user.id,
      plan: user.plan,
      text,
      voiceId,
      speed,
      studio: true,
      idempotencyKey,
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
