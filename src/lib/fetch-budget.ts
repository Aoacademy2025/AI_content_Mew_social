/**
 * fetchWithBudget — fetch with a per-attempt timeout, bounded retries, and a
 * wall-clock cap. Final failures are thrown as ProviderError (§8 taxonomy).
 *
 * Retry policy (EXPLICIT — do not widen it):
 * - Retries ONLY on (a) network errors / per-attempt timeouts (the request may
 *   never have reached the server) and (b) HTTP statuses in `retryOn`
 *   (default 429, 500, 502, 503, 504 — i.e. the server SAID it failed).
 * - 429 honors the Retry-After header (delta-seconds or HTTP-date), capped by
 *   the remaining wall clock.
 * - Any other status (400/401/402/403/404 …) is NEVER retried.
 * - Non-idempotent POSTs that must not double-submit (e.g. HeyGen generate,
 *   which spends user credits) should pass `retries: 0`.
 *
 * Contract: resolves ONLY with an `ok` Response. Non-ok final outcomes throw
 * ProviderError — unless `returnHttpErrors: true`, in which case the final
 * non-ok Response is returned (body untouched) so existing `res.status`
 * mapping at the call site keeps working; network/timeout failures still throw.
 */
import { providerError, classifyHttpStatus, type ProviderError } from "./provider-errors";

export interface FetchBudgetOptions {
  /** Per-attempt timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  /** HTTP statuses worth retrying. Default [429, 500, 502, 503, 504]. */
  retryOn?: number[];
  /** Total budget across attempts + backoff, in ms. Default 120s. */
  wallClockMs?: number;
  /** Provider tag for error classification, e.g. "heygen". */
  provider: string;
  /** Return the final non-ok HTTP Response instead of throwing. Default false. */
  returnHttpErrors?: boolean;
}

const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];

/** Sleep that resolves early if the caller signal fires (abort-aware). */
const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      // Resolve immediately on abort so the loop can rethrow without delay.
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });

/** Parse Retry-After: delta-seconds ("2") or HTTP-date. null if absent/garbage. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Jittered exponential backoff: 1s, 2s, 4s … + 0-500ms jitter. */
export function backoffDelayMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
}

/** Compose the caller's signal with a per-attempt timeout (AbortSignal.any when available). */
function composeSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([callerSignal, timeoutSignal]);
  return timeoutSignal; // Node < 20.3 fallback — timeout still applies
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

export async function fetchWithBudget(
  url: string,
  init: RequestInit = {},
  options: FetchBudgetOptions,
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    retries = 2,
    retryOn = DEFAULT_RETRY_ON,
    wallClockMs = 120_000,
    provider,
    returnHttpErrors = false,
  } = options;

  const startedAt = Date.now();
  const maxAttempts = retries + 1;
  let lastFailure: ProviderError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: composeSignal(init.signal, timeoutMs) });
    } catch (e) {
      // Caller abort ≠ per-attempt timeout; must not be retried or reclassified.
      if (init?.signal?.aborted) throw e;

      // Network error or per-attempt timeout — the request may never have
      // arrived, so a retry is safe and the failure is transient.
      const reason = isTimeoutError(e)
        ? `timeout after ${timeoutMs}ms`
        : e instanceof Error ? e.message : String(e);
      lastFailure = providerError(
        "transient",
        provider,
        `${provider} fetch failed (attempt ${attempt}/${maxAttempts}): ${reason}`,
      );
      if (attempt < maxAttempts) {
        const delay = backoffDelayMs(attempt);
        if (Date.now() - startedAt + delay < wallClockMs) {
          await sleep(delay, init.signal);
          // If the caller aborted during backoff, propagate immediately.
          if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          continue;
        }
      }
      throw lastFailure;
    }

    if (res.ok) return res;

    // clone() so a returned Response (returnHttpErrors) keeps a readable body
    const excerpt = await res.clone().text().then((t) => t.slice(0, 300)).catch(() => "");
    lastFailure = providerError(
      classifyHttpStatus(res.status),
      provider,
      `${provider} returned HTTP ${res.status}: ${excerpt}`,
      { status: res.status },
    );

    if (retryOn.includes(res.status) && attempt < maxAttempts) {
      const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null;
      const delay = retryAfterMs ?? backoffDelayMs(attempt);
      if (Date.now() - startedAt + delay < wallClockMs) {
        await sleep(delay, init.signal);
        if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        continue;
      }
      // wall clock exhausted — fall through to final handling
    }

    if (returnHttpErrors) return res;
    throw lastFailure;
  }

  // Unreachable: every loop path returns, continues, or throws.
  throw lastFailure ?? providerError("fatal", provider, `${provider}: attempts exhausted`);
}
