// Pure merge/validation helpers for the free per-window b-roll re-render (job mode
// `broll-rerender`). No DB, no network — unit-tested by scripts/verify-broll-rerender.ts.
//
// Flow: after a user swaps b-roll windows in the Editor v2 Post phase (Tasks 7-9 produce
// `/api/renders/*.mp4` or `/api/stocks/*.mp4` assets), the client batches the edits and the
// orchestrator merges them onto the SOURCE preview's `bgVideos[]`, then re-renders the base
// reusing the job's TTS/avatar (no minute charge — see the render route's `rerenderOf` skip).
//
// Invariants enforced here (violating any = broken subtitle timing or a charge/SSRF hole):
//  - window TIMING is locked: start/end are copied through untouched, windows are never
//    reordered/added/dropped (subtitle overlay is aligned to these exact spans).
//  - `src` is the ONLY place a client-named asset path enters the re-render, so it is
//    whitelisted to a single flat `.mp4` under our own /api/renders or /api/stocks route
//    (no traversal, no external host, no nested path).

export type WindowEdit = { index: number; src: string; keyword?: string };

// Single flat file under our own render/stock routes. `[\w.-]+` forbids `/` and (with the
// anchored, single-segment shape) any `..` traversal that would still contain a separator;
// a bare `..secret.mp4` can't traverse without a `/`, and the route serves flat basenames.
const SRC_RE = /^\/api\/(renders|stocks)\/[\w.-]+\.mp4$/;
const MAX_EDITS = 40;
const KEYWORD_MAX = 200;

/**
 * Validate + normalize the client-sent window edits. Returns the deduped edit list (last-wins
 * per index) or `{ error }` with a Thai message. Rejects: non-array, 0 or >40 edits, non-integer
 * or negative index, a `src` that isn't a single flat `.mp4` under /api/renders or /api/stocks,
 * and a non-string keyword.
 */
export function validateWindowEdits(edits: unknown): WindowEdit[] | { error: string } {
  if (!Array.isArray(edits)) return { error: "รูปแบบการแก้ b-roll ไม่ถูกต้อง" };
  if (edits.length < 1) return { error: "ไม่มีการแก้ b-roll" };
  if (edits.length > MAX_EDITS) return { error: `แก้ b-roll ได้ครั้งละไม่เกิน ${MAX_EDITS} จุด` };

  // Dedupe by index (last wins) while preserving encounter order of the survivors.
  const byIndex = new Map<number, WindowEdit>();
  for (const raw of edits) {
    if (typeof raw !== "object" || raw === null) return { error: "รายการแก้ b-roll ไม่ถูกต้อง" };
    const { index, src, keyword } = raw as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return { error: "ตำแหน่งช่วง b-roll ไม่ถูกต้อง" };
    }
    if (typeof src !== "string" || !SRC_RE.test(src)) {
      return { error: "ไฟล์ b-roll ไม่ถูกต้อง (ต้องเป็นไฟล์ .mp4 ในระบบ)" };
    }
    if (keyword !== undefined && typeof keyword !== "string") {
      return { error: "คำค้น b-roll ไม่ถูกต้อง" };
    }
    const trimmedKeyword = typeof keyword === "string" ? keyword.trim().slice(0, KEYWORD_MAX) : "";
    const edit: WindowEdit = { index, src, ...(trimmedKeyword ? { keyword: trimmedKeyword } : {}) };
    byIndex.set(index, edit); // last-wins
  }
  return Array.from(byIndex.values());
}

/**
 * Apply validated edits onto the source preview's `bgVideos[]`. Returns a NEW array (source not
 * mutated) or `{ error }`. Every edit's index is bounds-checked against `bgVideos.length` first —
 * an out-of-range index rejects the WHOLE merge (no partial application). For each edited window:
 * replace `src` (+ `keyword` when the edit carries one), reset `clipOffset` to 0, and DROP
 * `clipDuration` (the renderer's Loop probes the new clip's real length and loops safely).
 * `start`/`end` and every other field are copied through untouched; order is preserved.
 */
export function mergeWindowEdits(
  bgVideos: unknown[],
  edits: WindowEdit[],
): { bgVideos: Record<string, unknown>[] } | { error: string } {
  if (!Array.isArray(bgVideos) || bgVideos.length === 0) {
    return { error: "วิดีโอต้นฉบับไม่มีข้อมูล b-roll ที่แก้ไขได้" };
  }
  // Bounds-check ALL edit indices before touching anything (atomic).
  for (const e of edits) {
    if (e.index >= bgVideos.length) {
      return { error: `ตำแหน่งช่วง b-roll เกินจำนวนที่มี (${bgVideos.length} ช่วง)` };
    }
  }
  const byIndex = new Map(edits.map((e) => [e.index, e]));

  const merged: Record<string, unknown>[] = [];
  for (let i = 0; i < bgVideos.length; i++) {
    const v = bgVideos[i];
    if (typeof v !== "object" || v === null) {
      // A non-object entry can only be edited safely if it's not targeted; an edit targeting it
      // has nothing to spread onto → reject rather than fabricate a window.
      if (byIndex.has(i)) return { error: `ช่วง b-roll ที่ ${i} เสียหาย` };
      merged.push(v as Record<string, unknown>);
      continue;
    }
    const base = { ...(v as Record<string, unknown>) };
    const e = byIndex.get(i);
    if (!e) { merged.push(base); continue; }
    // Drop clipDuration; keep everything else (start/end/index/title/query/provider/keyword...).
    delete base.clipDuration;
    base.src = e.src;
    if (e.keyword) base.keyword = e.keyword; // replace keyword only when the edit supplies one
    base.clipOffset = 0;
    merged.push(base);
  }
  return { bgVideos: merged };
}
