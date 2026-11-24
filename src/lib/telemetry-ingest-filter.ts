import type { TelemetryInput } from "@/lib/telemetry";
import { isThirdPartyFrontendNoise } from "@/lib/frontend-error-noise";
import {
  DEFAULT_WEB_VITALS_SAMPLE_RATE,
  shouldSampleWebVital,
} from "@/lib/web-vitals-telemetry";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Pure server-side ingest filter applied before Clerk auth lookup and SQLite
 * writes in POST /api/telemetry (HERO-128).
 *
 * 1. Drops known third-party browser noise and opaque cross-origin `Script error.`
 *    rows (including from stale cached browser tabs) while keeping all first-party
 *    application, editor, checkout, and Clerk auth errors.
 * 2. Deterministically samples `web_vital` rows by `navigationId` (matching the
 *    client's exact hash so client-sampled navigations are never double-sampled).
 */
export function filterTelemetryBatchForIngest(
  events: readonly TelemetryInput[],
  options: { webVitalSampleRate?: number } = {},
): TelemetryInput[] {
  const sampleRate = options.webVitalSampleRate ?? DEFAULT_WEB_VITALS_SAMPLE_RATE;
  const kept: TelemetryInput[] = [];

  for (const event of events) {
    const props = event.properties ?? {};

    if (event.name === "frontend_error") {
      const source = readString(props.source);
      const isNoise = isThirdPartyFrontendNoise({
        type: readString(props.errorName),
        message: readString(props.message),
        stack: readString(props.stack),
        filenames: source ? [source] : [],
      });
      if (isNoise) continue;
    }

    if (event.name === "web_vital") {
      const sampleKey =
        readString(props.navigationId)
        ?? readString(event.sessionId)
        ?? readString(event.path)
        ?? "anon";
      if (!shouldSampleWebVital(sampleKey, sampleRate)) continue;
    }

    kept.push(event);
  }

  return kept;
}
