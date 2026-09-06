export const HERO_VOICE_CLONE_FAILURE_STATUSES = [
  "failed",
  "failed_unknown_submit",
  "failed_timeout",
  "failed_poll_unavailable",
  "failed_provider_status",
  "failed_provider_missing",
  "failed_identity",
  "failed_output",
] as const;

export type HeroVoiceCloneFailureStatus = typeof HERO_VOICE_CLONE_FAILURE_STATUSES[number];
export type HeroVoiceCloneTerminalStatus = HeroVoiceCloneFailureStatus | "completed" | "canceled";
export type HeroVoiceCloneCancelDisposition = "not_requested" | "confirmed" | "rejected_or_unknown";

const TERMINAL = new Set<string>([...HERO_VOICE_CLONE_FAILURE_STATUSES, "completed", "canceled"]);
const FAILED = new Set<string>(HERO_VOICE_CLONE_FAILURE_STATUSES);

export function isHeroVoiceCloneTerminalStatus(value: string): value is HeroVoiceCloneTerminalStatus {
  return TERMINAL.has(value);
}

export function isHeroVoiceCloneFailureStatus(value: string): value is HeroVoiceCloneFailureStatus {
  return FAILED.has(value);
}

/** A broad, blob-independent classifier used to fail closed when one clone
 * identity surface is malformed. The stricter full invariant is checked by the
 * durable generation boundary before any provider request. */
export function isHeroVoiceCloneDurableRecord(job: {
  kind?: string | null;
  model?: string | null;
  providerModel?: string | null;
  productSurface?: string | null;
  inputJson?: string | null;
}): boolean {
  if (job.kind !== "voice") return false;
  if (job.providerModel === "omnivoice-clone") return true;
  if (job.model?.startsWith("user_") === true) return true;
  if (job.productSurface === "ai_studio") return true;
  try {
    const value = JSON.parse(job.inputJson ?? "null") as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && ((value as Record<string, unknown>).mode === "clone"
        || (value as Record<string, unknown>).cloneCanarySurface === "ai-studio");
  } catch {
    return false;
  }
}

export function heroVoiceClonePublicStatus(value: string): string {
  return isHeroVoiceCloneFailureStatus(value) ? "failed" : value;
}

export function normalizeHeroVoiceClonePublicJob<T extends { status: string }>(job: T): T {
  const status = heroVoiceClonePublicStatus(job.status);
  return status === job.status ? job : { ...job, status };
}

export function heroVoiceCloneFailureHttpStatus(errorCode: string | null): number {
  if (errorCode === "CLONE_POLL_UNAVAILABLE") return 503;
  if (errorCode === "CLONE_PROVIDER_STATUS_INVALID" || errorCode === "CLONE_PROVIDER_JOB_MISSING") return 502;
  return 200;
}

/** Task 5 consumes this immutable application directive when it adds the
 * external append-only run/park ledger. This module does not claim that ledger
 * exists and never mutates RunPod control-plane state. */
export function heroVoiceCloneExternalAbortDirective(input: {
  externalRunDisposition: string;
  status: string;
  errorCode: string | null;
  dispatchIntentAt: Date | null;
}) {
  if (input.externalRunDisposition !== "abort_required") return null;
  const preDispatchAtMs = input.dispatchIntentAt?.getTime() ?? null;
  return Object.freeze({
    version: 1 as const,
    action: "abort-no-go-and-park" as const,
    primaryStatus: input.status,
    errorCode: input.errorCode,
    preserveExternalReserveSeconds: 660 as const,
    firstParkNoLaterThanMs: preDispatchAtMs === null ? null : preDispatchAtMs + 600_000,
    finalObservationDeadlineMs: preDispatchAtMs === null ? null : preDispatchAtMs + 660_000,
  });
}

export function heroVoiceCloneConservation(input: {
  plannedSlots: number;
  notStarted: number;
  providerRejected: number;
  transportUnknown: number;
  providerAccepted: number;
  validCompleted: number;
  providerTerminalFailed: number;
  acceptedOutcomeUnknown: number;
  applicationValidationFailed: number;
}) {
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("clone conservation counters must be non-negative integers");
  }
  const dispatchIntents = input.providerRejected + input.transportUnknown + input.providerAccepted;
  const submissionConserved = input.plannedSlots
    === input.notStarted + input.providerRejected + input.transportUnknown + input.providerAccepted;
  const acceptedOutcomesConserved = input.providerAccepted
    === input.validCompleted + input.providerTerminalFailed
      + input.acceptedOutcomeUnknown + input.applicationValidationFailed;
  if (!submissionConserved || !acceptedOutcomesConserved) {
    throw new Error("clone run counters do not conserve");
  }
  return Object.freeze({
    dispatchIntents,
    possibleProviderReceived: Object.freeze({
      minimum: input.providerAccepted + input.providerRejected,
      maximum: input.providerAccepted + input.providerRejected + input.transportUnknown,
    }),
  });
}
