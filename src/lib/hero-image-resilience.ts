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
  stopBatch?: boolean;
};

const HERO_RUNPOD_SYSTEMIC_CIRCUIT_MS = 10 * 60_000;
const HERO_RUNPOD_QUEUE_CIRCUIT_MS = 60_000;
const HERO_RUNPOD_HALF_OPEN_PROBE_MS = 60_000;
const HERO_RUNPOD_QUEUE_SIGNAL_WINDOW_MS = 5 * 60_000;
const HERO_RUNPOD_QUEUE_SIGNAL_THRESHOLD = 2;
export const DEFAULT_HERO_RUNPOD_ORPHAN_QUEUE_MS = 2 * 60_000;

type RunpodCircuit = {
  code: RunpodTerminalFailure["code"];
  openedAt: number;
  cooldownMs: number;
  probeClaimedAt: number | null;
} | null;

const globalForRunpodCircuit = globalThis as typeof globalThis & {
  __heroRunpodCircuit?: RunpodCircuit;
  __heroRunpodQueueSignals?: Array<{ at: number; signalId: string }>;
};

export function classifyRunpodTerminalFailure(message: string | null | undefined): RunpodTerminalFailure {
  const source = (message ?? "").trim();
  if (/RUNPOD_QUEUE_TIMEOUT|queue (?:wait )?(?:timed? ?out|timeout)|exceeded the bounded queue wait/i.test(source)) {
    return {
      code: "RUNPOD_QUEUE_TIMEOUT",
      systemic: false,
      retryable: true,
      stopBatch: true,
    };
  }
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
  globalForRunpodCircuit.__heroRunpodCircuit = {
    code,
    openedAt: now,
    cooldownMs: code === "RUNPOD_QUEUE_TIMEOUT"
      ? HERO_RUNPOD_QUEUE_CIRCUIT_MS
      : HERO_RUNPOD_SYSTEMIC_CIRCUIT_MS,
    probeClaimedAt: null,
  };
}

export function closeHeroRunpodCircuit(): void {
  globalForRunpodCircuit.__heroRunpodCircuit = null;
  globalForRunpodCircuit.__heroRunpodQueueSignals = [];
}

/**
 * Queue timeouts are local by default. Only two independent jobs within five
 * minutes open a short provider-wide circuit. Auth/config failures still open
 * the long circuit immediately.
 */
export function recordHeroRunpodFailure(
  code: RunpodTerminalFailure["code"],
  signalId: string,
  now = Date.now(),
): { circuitOpened: boolean; independentSignals: number } {
  if (code !== "RUNPOD_QUEUE_TIMEOUT") {
    openHeroRunpodCircuit(code, now);
    return { circuitOpened: true, independentSignals: 1 };
  }
  const prior = globalForRunpodCircuit.__heroRunpodQueueSignals ?? [];
  const cutoff = now - HERO_RUNPOD_QUEUE_SIGNAL_WINDOW_MS;
  const signals = prior.filter((signal) => signal.at >= cutoff);
  if (!signals.some((signal) => signal.signalId === signalId)) {
    signals.push({ at: now, signalId });
  }
  globalForRunpodCircuit.__heroRunpodQueueSignals = signals;
  if (signals.length >= HERO_RUNPOD_QUEUE_SIGNAL_THRESHOLD) {
    openHeroRunpodCircuit(code, now);
    return { circuitOpened: true, independentSignals: signals.length };
  }
  return { circuitOpened: false, independentSignals: signals.length };
}

export function recordHeroRunpodSuccess(): void {
  closeHeroRunpodCircuit();
}

export function heroRunpodCircuitState(now = Date.now()):
  | { open: false; halfOpen?: true }
  | { open: true; code: RunpodTerminalFailure["code"]; retryAfterMs: number } {
  const circuit = globalForRunpodCircuit.__heroRunpodCircuit ?? null;
  if (!circuit) return { open: false };
  const retryAfterMs = Math.max(0, circuit.openedAt + circuit.cooldownMs - now);
  if (retryAfterMs > 0) {
    return { open: true, code: circuit.code, retryAfterMs };
  }
  if (
    circuit.probeClaimedAt === null
    || now - circuit.probeClaimedAt >= HERO_RUNPOD_HALF_OPEN_PROBE_MS
  ) {
    circuit.probeClaimedAt = now;
    return { open: false, halfOpen: true };
  }
  return {
    open: true,
    code: circuit.code,
    retryAfterMs: HERO_RUNPOD_HALF_OPEN_PROBE_MS - (now - circuit.probeClaimedAt),
  };
}

export function shouldRetryQueuedRunpodJob(input: {
  queuedMs: number;
  health: { workers: { idle: number; running: number }; jobs: { inQueue: number; inProgress: number } };
  orphanQueueMs?: number;
}): boolean {
  const orphanQueueMs = Math.max(
    30_000,
    input.orphanQueueMs ?? DEFAULT_HERO_RUNPOD_ORPHAN_QUEUE_MS,
  );
  return input.queuedMs >= orphanQueueMs
    && input.health.jobs.inQueue > 0
    && input.health.workers.idle > 0;
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
