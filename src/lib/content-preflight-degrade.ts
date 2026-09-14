export type ContentPreflightStockDegradeReason = "invalid_analysis" | "narrative_mismatch";

function isContentPreflightError(
  error: unknown,
  code: string,
): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "ContentPreflightError" && candidate.code === code;
}

/**
 * HERO-29: ADR 0010 forbids a generic visual fallback, but refusing the whole
 * create is worse than offering stock. Analyzer exhaustion and a Narrative/TTS
 * mismatch degrade to stock B-roll instead of writing CONTENT_PREFLIGHT_* on
 * the VideoJob. Missing keys and text quota still fail closed.
 */
export function contentPreflightStockDegradeReason(input: {
  analyzerError?: unknown;
  pinnedWindowCount?: number;
  narrativeAligned?: boolean;
}): ContentPreflightStockDegradeReason | null {
  if (isContentPreflightError(input.analyzerError, "INVALID_ANALYSIS")) {
    return "invalid_analysis";
  }
  if ((input.pinnedWindowCount ?? 0) > 0 && input.narrativeAligned === false) {
    return "narrative_mismatch";
  }
  return null;
}
