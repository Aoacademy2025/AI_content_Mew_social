/** Server-only contract for the one bounded subtitle-verification transcription. */
export const INTERNAL_TRANSCRIBE_DEADLINE_HEADER = "x-heroai-transcribe-deadline-ms";
export const SUBTITLE_VERIFY_OUTER_BUDGET_MS = 180_000;
export const SUBTITLE_VERIFY_RESPONSE_MARGIN_MS = 2_000;
export const MAX_INTERNAL_TRANSCRIBE_WORK_MS =
  SUBTITLE_VERIFY_OUTER_BUDGET_MS - SUBTITLE_VERIFY_RESPONSE_MARGIN_MS;

/** Public requests cannot enable bounded internal mode; trusted deadlines are absolute and clamped. */
export function deriveInternalTranscribeDeadline(input: {
  isServiceActor: boolean;
  requestedDeadlineMs: number;
  nowMs?: number;
}): number | null {
  if (!input.isServiceActor) return null;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.requestedDeadlineMs) || input.requestedDeadlineMs <= 0) return null;
  return Math.min(Math.floor(input.requestedDeadlineMs), nowMs + MAX_INTERNAL_TRANSCRIBE_WORK_MS);
}

export class TranscribeDeadlineExceededError extends Error {
  constructor() {
    super("internal_transcribe_deadline_exceeded");
    this.name = "TranscribeDeadlineExceededError";
  }
}

export function transcribeDeadlineRemainingMs(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.floor(deadlineMs - nowMs));
}

export function assertTranscribeDeadline(deadlineMs: number | null, nowMs = Date.now()): void {
  if (deadlineMs !== null && transcribeDeadlineRemainingMs(deadlineMs, nowMs) <= 0) {
    throw new TranscribeDeadlineExceededError();
  }
}

export function isTranscribeDeadlineExceeded(error: unknown, deadlineMs: number | null): boolean {
  if (error instanceof TranscribeDeadlineExceededError) return true;
  if (deadlineMs === null || transcribeDeadlineRemainingMs(deadlineMs) > 25) return false;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function deadlineSignal(deadlineMs: number | null, maxDurationMs: number, parentSignal?: AbortSignal): AbortSignal {
  assertTranscribeDeadline(deadlineMs);
  const timeoutMs = deadlineMs === null
    ? maxDurationMs
    : Math.min(maxDurationMs, transcribeDeadlineRemainingMs(deadlineMs));
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

/** Give local media subprocesses the same absolute cutoff as provider requests. */
export function transcribeDeadlineExecOptions(
  deadlineMs: number | null,
  parentSignal?: AbortSignal,
): { signal?: AbortSignal; timeout?: number } {
  if (deadlineMs === null) return {};
  assertTranscribeDeadline(deadlineMs);
  const timeout = Math.max(1, transcribeDeadlineRemainingMs(deadlineMs));
  return { timeout, signal: deadlineSignal(deadlineMs, timeout, parentSignal) };
}

/** Fetch with the existing per-operation cap, additionally bounded by the trusted route deadline. */
export async function fetchWithinTranscribeDeadline(
  input: string | URL | Request,
  init: RequestInit,
  options: { deadlineMs: number | null; maxDurationMs: number; parentSignal?: AbortSignal },
): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      signal: deadlineSignal(options.deadlineMs, options.maxDurationMs, options.parentSignal),
    });
  } catch (error) {
    if (isTranscribeDeadlineExceeded(error, options.deadlineMs)) {
      throw new TranscribeDeadlineExceededError();
    }
    throw error;
  }
}

/** Do not consume the response margin in a retry backoff or launch the retry after it. */
export async function sleepWithinTranscribeDeadline(delayMs: number, deadlineMs: number | null): Promise<void> {
  if (deadlineMs !== null && transcribeDeadlineRemainingMs(deadlineMs) <= delayMs) {
    throw new TranscribeDeadlineExceededError();
  }
  await new Promise(resolve => setTimeout(resolve, delayMs));
  assertTranscribeDeadline(deadlineMs);
}
