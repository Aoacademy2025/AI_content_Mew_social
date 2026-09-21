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

/**
 * Copy for a window with nothing in it. AI is offered only where this video can actually
 * generate an image: a fill-it-yourself video skips the content preflight, has no Project
 * Visual Context, and its AI tab is disabled for good.
 */
export function emptyWindowHint(aiAvailable: boolean): string {
  return aiAvailable
    ? "ช่วงนี้ยังว่าง — เลือกสต็อก อัปโหลด หรือสร้างภาพ AI ด้านล่าง ถ้าไม่ใส่จะเป็นพื้นหลังสีแบรนด์"
    : "ช่วงนี้ยังว่าง — เลือกสต็อกหรืออัปโหลดด้านล่าง ถ้าไม่ใส่จะเป็นพื้นหลังสีแบรนด์";
}

/** Tail of the "B-roll is off for this window" banner. The AI tab keeps its money guard. */
export function offWindowHint(aiAvailable: boolean): string {
  const base = " — เลือกสต็อกหรืออัปโหลดด้านล่าง ระบบจะเปิด B-roll ช่วงนี้ให้เอง";
  return aiAvailable ? `${base} · ถ้าจะสร้างภาพ AI ให้กดเปิดช่วงนี้ก่อน` : base;
}
