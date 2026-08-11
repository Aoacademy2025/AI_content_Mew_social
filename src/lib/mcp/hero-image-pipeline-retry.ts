const RETRYABLE_HERO_PROVIDER_CODES = new Set([
  "HERO_IMAGE_UNAVAILABLE",
  "HERO_IMAGE_TIMEOUT",
]);

export const HERO_IMAGE_PROVIDER_MAX_AUTO_RETRIES = 1;

function recordBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The image route has already canceled/refunded its incomplete batch before it
 * returns either of these errors. Retry only that route once; callers must pass
 * `nextAttempt` back as `heroProviderAttempt` so failed child jobs are never
 * mistaken for the new idempotent batch.
 */
export function heroImageProviderRetryDirective(
  error: unknown,
  completedRetries: number,
): { nextAttempt: number; delayMs: number; code: string } | null {
  const pipelineError = error instanceof Error && error.name === "PipelineHttpError"
    ? error as Error & { path?: unknown; status?: unknown; body?: unknown }
    : null;
  if (!pipelineError
    || pipelineError.path !== "/api/videos/fetch-stock"
    || pipelineError.status !== 503
    || completedRetries >= HERO_IMAGE_PROVIDER_MAX_AUTO_RETRIES) {
    return null;
  }
  const body = recordBody(pipelineError.body);
  const code = typeof body?.code === "string" ? body.code : "";
  if (body?.retryable !== true || !RETRYABLE_HERO_PROVIDER_CODES.has(code)) return null;

  const rawRetryAfterSec = Number(body.retryAfterSec);
  const fallbackSec = code === "HERO_IMAGE_TIMEOUT" ? 30 : 60;
  const retryAfterSec = Number.isFinite(rawRetryAfterSec)
    ? Math.min(120, Math.max(5, Math.ceil(rawRetryAfterSec)))
    : fallbackSec;
  return {
    nextAttempt: completedRetries + 1,
    delayMs: retryAfterSec * 1_000,
    code,
  };
}
