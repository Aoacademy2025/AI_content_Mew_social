import { compileNarrationPlan } from "@/lib/narration-plan";

/**
 * Compatibility helpers for the legacy editor and v2 duration counters. The
 * authoritative preparation contract lives in NarrationPlan so browser and
 * background jobs cannot silently send different provider text.
 */

/** Clean one line (no newline handling) — used by v2 counters that keep segment structure. */
export function cleanScriptLine(line: string): string {
  return compileNarrationPlan(line).speechText;
}

/** Full-script preparation sent to TTS/transcribe without rewriting authored meaning. */
export function preprocessScript(raw: string): string {
  return compileNarrationPlan(raw).speechText;
}
