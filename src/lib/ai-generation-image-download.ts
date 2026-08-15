import { backoffDelayMs, fetchWithBudget } from "@/lib/fetch-budget";
import { isProviderError } from "@/lib/provider-errors";

export type ImageDownloadRetryOptions = {
  timeoutMs?: number;
  retries?: number;
  wallClockMs?: number;
};

function isRetryableBodyFailure(error: unknown): boolean {
  if (isProviderError(error)) return error.retryable;
  return error instanceof Error
    && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download and buffer the complete image inside the retry boundary. Returning
 * the upstream Response before its body was consumed left body-stream timeouts
 * outside fetchWithBudget, so a configured retry count still made only one
 * request when the CDN stalled after sending headers.
 */
export async function fetchImageResponseWithRetry(
  url: string,
  options: ImageDownloadRetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 2;
  const wallClockMs = options.wallClockMs ?? 100_000;
  const startedAt = Date.now();
  let lastFailure: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const remainingMs = wallClockMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw lastFailure ?? new Error("runpod-image download budget exhausted");

    try {
      const response = await fetchWithBudget(
        url,
        {
          cache: "no-store",
          redirect: "error",
        },
        {
          provider: "runpod-image",
          timeoutMs: Math.max(1, Math.min(timeoutMs, remainingMs)),
          retries: 0,
          wallClockMs: remainingMs,
        },
      );
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    } catch (error) {
      lastFailure = error;
      if (attempt > retries || !isRetryableBodyFailure(error)) throw error;
      const delayMs = backoffDelayMs(attempt);
      if (Date.now() - startedAt + delayMs >= wallClockMs) throw error;
      await sleep(delayMs);
    }
  }

  throw lastFailure ?? new Error("runpod-image download failed");
}
