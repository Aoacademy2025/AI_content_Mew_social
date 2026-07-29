export type RunpodTerminalFailure = {
  code:
    | "RUNPOD_UPSTREAM_AUTH"
    | "RUNPOD_AUTH"
    | "RUNPOD_RATE_LIMIT"
    | "RUNPOD_ENDPOINT_UNAVAILABLE"
    | "RUNPOD_QUEUE_TIMEOUT"
    | "RUNPOD_FAILED";
  systemic: boolean;
  retryable: boolean;
};

const HERO_RUNPOD_CIRCUIT_MS = 10 * 60_000;

type RunpodCircuit = {
  code: RunpodTerminalFailure["code"];
  openedAt: number;
} | null;

const globalForRunpodCircuit = globalThis as typeof globalThis & {
  __heroRunpodCircuit?: RunpodCircuit;
};

export function classifyRunpodTerminalFailure(message: string | null | undefined): RunpodTerminalFailure {
  const source = (message ?? "").trim();
  const authFailure = /\b(?:401|403)\b|invalid api key|unauthori[sz]ed|authentication failed/i.test(source);
  if (authFailure && /wavespeed/i.test(source)) {
    return { code: "RUNPOD_UPSTREAM_AUTH", systemic: true, retryable: false };
  }
  if (authFailure) {
    return { code: "RUNPOD_AUTH", systemic: true, retryable: false };
  }
  if (/\b429\b|rate[\s_-]*limit|too many requests/i.test(source)) {
    return { code: "RUNPOD_RATE_LIMIT", systemic: true, retryable: true };
  }
  if (/\b404\b|endpoint (?:is )?not found|unknown endpoint/i.test(source)) {
    return { code: "RUNPOD_ENDPOINT_UNAVAILABLE", systemic: true, retryable: false };
  }
  return { code: "RUNPOD_FAILED", systemic: false, retryable: true };
}

export function openHeroRunpodCircuit(
  code: RunpodTerminalFailure["code"],
  now = Date.now(),
): void {
  globalForRunpodCircuit.__heroRunpodCircuit = { code, openedAt: now };
}

export function closeHeroRunpodCircuit(): void {
  globalForRunpodCircuit.__heroRunpodCircuit = null;
}

export function heroRunpodCircuitState(now = Date.now()):
  | { open: false }
  | { open: true; code: RunpodTerminalFailure["code"]; retryAfterMs: number } {
  const circuit = globalForRunpodCircuit.__heroRunpodCircuit ?? null;
  if (!circuit) return { open: false };
  const retryAfterMs = Math.max(0, circuit.openedAt + HERO_RUNPOD_CIRCUIT_MS - now);
  if (retryAfterMs === 0) {
    closeHeroRunpodCircuit();
    return { open: false };
  }
  return { open: true, code: circuit.code, retryAfterMs };
}

export async function forEachInFailFastBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  handler: (item: T) => Promise<R>,
  shouldStop: (result: R) => boolean,
): Promise<{ processed: T[]; skipped: T[]; stopped: boolean }> {
  const size = Math.max(1, Math.floor(batchSize));
  const processed: T[] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    const results = await Promise.all(batch.map(handler));
    processed.push(...batch);
    if (results.some(shouldStop)) {
      return {
        processed,
        skipped: items.slice(start + batch.length),
        stopped: true,
      };
    }
  }
  return { processed, skipped: [], stopped: false };
}
