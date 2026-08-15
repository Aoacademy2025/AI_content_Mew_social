/**
 * Decide whether Gemini TTS itself must enforce the legacy minute hard-wall.
 *
 * With the durable minute/credit render settlement enabled, TTS is only the
 * provider step: the base RenderJob atomically reserves included minutes or
 * spends overflow credits once the exact audio duration is known. Blocking at
 * TTS would reject credit-funded renders before that settlement can run.
 *
 * Legacy deployments without MINUTE_QUOTA still reserve managed TTS minutes
 * inside the route, so they keep the old fail-fast check. BYOK never consumes
 * platform minutes at TTS.
 */
export function shouldCheckTtsMinuteQuota(
  geminiMode: "managed" | "byok",
  minuteQuotaEnabled: boolean,
): boolean {
  return geminiMode === "managed" && !minuteQuotaEnabled;
}
