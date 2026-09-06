import { NextResponse } from "next/server";
import { withDesktop } from "@/lib/desktop/with-desktop";
import { seatLimitForEffectivePlan } from "@/lib/desktop/seats";
import { checkAiAudioCeiling } from "@/lib/ai-spend-limits";
import { aiTextCallCeilingFor } from "@/lib/ai-text-limits";
import { syncMinuteWindow } from "@/lib/minute-limits";

export const runtime = "nodejs";

export const GET = withDesktop(async (_req, principal) => {
  const [audio, window] = await Promise.all([
    checkAiAudioCeiling(principal.userId, { enforce: true }),
    syncMinuteWindow(principal.userId),
  ]);
  const textCeiling = window ? aiTextCallCeilingFor(window.minutesLimit) : 0;
  const aiTextCallsRemaining = window ? Math.max(0, textCeiling - window.aiTextCallsUsed) : 0;

  return NextResponse.json({
    userId: principal.userId,
    plan: principal.plan,
    effectivePlan: principal.effectivePlan,
    seatLimit: seatLimitForEffectivePlan(principal.effectivePlan),
    aiAudioMinutesRemaining: audio.remaining,
    aiTextCallsRemaining,
    serverTime: new Date().toISOString(),
  });
});
