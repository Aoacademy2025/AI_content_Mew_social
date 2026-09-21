/**
 * Small, pure rules for how a B-roll window reads and behaves in the post-render editor.
 * Kept out of the components so the timeline, the inspector and their check agree.
 */

/** Keyword the orchestrator stamps on windows that show the customer's uploaded clip. */
export const PRESENTER_KEYWORD = "uploaded presenter clip";

/**
 * Picking a clip for a window that is off is an unambiguous request to show it. Without
 * this the customer's first free update changes nothing and a second one is needed.
 * A window they switched off themselves in this session stays off.
 */
export function pickTurnsWindowOn(input: { currentlyEnabled: boolean; stagedEnabled?: boolean }): boolean {
  return input.stagedEnabled === undefined && !input.currentlyEnabled;
}

export function brollTimelineLabel(input: { enabled: boolean; label: string; src?: string }): string {
  if (input.enabled) return input.label;
  if (input.label === PRESENTER_KEYWORD) return "คลิปของคุณ";
  if (!input.src) return `ว่าง · ${input.label}`;
  return `ปิด · ${input.label}`;
}

/** The presenter keyword is internal; searching stock for it returns nonsense. */
export function seedSearchKeyword(keyword: unknown): string {
  return typeof keyword === "string" && keyword !== PRESENTER_KEYWORD ? keyword : "";
}

/** Source badge for windows the normal provider/filename inference gets wrong. */
export function windowSourceLabelOverride(
  entry: { keyword?: unknown; timelineAligned?: unknown } | null | undefined,
): string | null {
  return entry?.timelineAligned === true || entry?.keyword === PRESENTER_KEYWORD ? "คลิปของคุณ" : null;
}
