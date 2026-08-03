// Pure merge/validation helpers for the free per-window b-roll re-render (job mode
// `broll-rerender`). No DB, no network — unit-tested by scripts/verify-broll-rerender.ts.
//
// Flow: after a user swaps, reorders, or changes visibility of b-roll windows in the Editor v2
// Post phase, the client batches the edits and the orchestrator merges them onto the SOURCE
// preview's `bgVideos[]`, then re-renders the base reusing the job's TTS/avatar (no minute
// charge — see the render route's `rerenderOf` skip).
//
// Invariants enforced here (violating any = broken subtitle timing or a charge/SSRF hole):
//  - window TIMING is locked: start/end are copied through untouched, windows are never
//    reordered/added/dropped (subtitle overlay is aligned to these exact spans).
//  - optional `src` is the ONLY place a client-named asset path enters the re-render, so it
//    is whitelisted to a single flat `.mp4` under our own /api/renders or /api/stocks route
//    (no traversal, no external host, no nested path). Visibility-only edits do not need src.

export type WindowEdit = {
  index: number;
  src?: string;
  keyword?: string;
  /** Actual replacement duration from the server-side upload/select/generate response. */
  clipDuration?: number;
  /** Explicit per-window visibility. Tri-state in persisted config: undefined = legacy default. */
  enabled?: boolean;
};

/** The exact media/job pair an export must bind to after any pending B-roll apply. */
export type BrollExportSource = {
  jobId: string;
  videoUrl: string;
  compositeBaseUrl: string | null;
};

/**
 * Resolve the source used by Export without ever falling back to stale media.
 *
 * Pending window edits live in browser state until a free `broll-rerender` job succeeds.
 * Exporting the current source while edits are pending silently drops uploaded/selected B-roll,
 * so a failed apply returns `null` and aborts Export instead of using `current`.
 */
export async function resolveBrollExportSource(input: {
  pendingEditCount: number;
  current: BrollExportSource;
  applyPending: () => Promise<BrollExportSource | null>;
}): Promise<BrollExportSource | null> {
  if (input.pendingEditCount <= 0) return input.current;
  return input.applyPending();
}

// Single flat file under our own render/stock routes. `[\w.-]+` forbids `/` and (with the
// anchored, single-segment shape) any `..` traversal that would still contain a separator;
// a bare `..secret.mp4` can't traverse without a `/`, and the route serves flat basenames.
const SRC_RE = /^\/api\/(renders|stocks)\/[\w.-]+\.mp4$/;
const MAX_EDITS = 40;
const KEYWORD_MAX = 200;
const MAX_CLIP_DURATION_SECONDS = 24 * 60 * 60;

/**
 * Validate + normalize the client-sent window edits. Returns the deduped edit list (last-wins
 * per index) or `{ error }` with a Thai message. Every item must change at least one of `src` or
 * `enabled`. Rejects: non-array, 0 or >40 edits, non-integer/negative index, a supplied `src`
 * that isn't a single flat `.mp4` under /api/renders or /api/stocks, non-boolean `enabled`, and
 * a keyword without a replacement source.
 */
export function validateWindowEdits(edits: unknown): WindowEdit[] | { error: string } {
  if (!Array.isArray(edits)) return { error: "รูปแบบการแก้ b-roll ไม่ถูกต้อง" };
  if (edits.length < 1) return { error: "ไม่มีการแก้ b-roll" };
  if (edits.length > MAX_EDITS) return { error: `แก้ b-roll ได้ครั้งละไม่เกิน ${MAX_EDITS} จุด` };

  // Dedupe by index (last wins) while preserving encounter order of the survivors.
  const byIndex = new Map<number, WindowEdit>();
  for (const raw of edits) {
    if (typeof raw !== "object" || raw === null) return { error: "รายการแก้ b-roll ไม่ถูกต้อง" };
    const { index, src, keyword, clipDuration, enabled } = raw as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return { error: "ตำแหน่งช่วง b-roll ไม่ถูกต้อง" };
    }
    const hasSrc = src !== undefined;
    const hasEnabled = enabled !== undefined;
    if (!hasSrc && !hasEnabled) {
      return { error: "รายการแก้ b-roll ไม่มีการเปลี่ยนแปลง" };
    }
    if (hasSrc && (typeof src !== "string" || !SRC_RE.test(src))) {
      return { error: "ไฟล์ b-roll ไม่ถูกต้อง (ต้องเป็นไฟล์ .mp4 ในระบบ)" };
    }
    if (hasEnabled && typeof enabled !== "boolean") {
      return { error: "สถานะเปิดปิด b-roll ไม่ถูกต้อง" };
    }
    if (keyword !== undefined && typeof keyword !== "string") {
      return { error: "คำค้น b-roll ไม่ถูกต้อง" };
    }
    if (keyword !== undefined && !hasSrc) {
      return { error: "คำค้น b-roll ต้องส่งพร้อมไฟล์ที่ใช้แทน" };
    }
    if (
      clipDuration !== undefined
      && (
        !hasSrc
        || typeof clipDuration !== "number"
        || !Number.isFinite(clipDuration)
        || clipDuration <= 0
        || clipDuration > MAX_CLIP_DURATION_SECONDS
      )
    ) {
      return { error: "ความยาวไฟล์ b-roll ไม่ถูกต้อง" };
    }
    const trimmedKeyword = typeof keyword === "string" ? keyword.trim().slice(0, KEYWORD_MAX) : "";
    const edit: WindowEdit = {
      index,
      ...(typeof src === "string" ? { src } : {}),
      ...(trimmedKeyword ? { keyword: trimmedKeyword } : {}),
      ...(typeof clipDuration === "number" ? { clipDuration } : {}),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
    };
    byIndex.set(index, edit); // last-wins
  }
  return Array.from(byIndex.values());
}

/**
 * Apply validated edits onto the source preview's `bgVideos[]`. Returns a NEW array (source not
 * mutated) or `{ error }`. Every edit's index is bounds-checked against `bgVideos.length` first —
 * an out-of-range index rejects the WHOLE merge (no partial application). For each edited window:
 * optionally replace `src` (+ `keyword`), optionally persist `brollEnabled`, reset source
 * playback metadata only for replacements, and keep `start`/`end` untouched. Order is preserved.
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
    if (e.src) {
      // Replacement: reset clip playback and strip metadata that describes the OLD asset.
      delete base.clipDuration;
      delete base.provider;
      delete base.title;
      delete base.query;
      delete base.selectionReason;
      delete base.relevanceScore;
      base.src = e.src;
      if (e.keyword) base.keyword = e.keyword;
      if (e.clipDuration !== undefined) base.clipDuration = e.clipDuration;
      base.clipOffset = 0;
    }
    if (typeof e.enabled === "boolean") {
      // Keep true explicitly as well: Upload Avatar defaults alternate by window, so an explicit
      // true is required to turn B-roll ON over a window that used to show the uploaded speaker.
      base.brollEnabled = e.enabled;
    }
    merged.push(base);
  }
  return { bgVideos: merged };
}

/**
 * Canonicalize a voice/audio URL for identity comparison: absolute→pathname (origin is
 * irrelevant — same file), strip any query/hash, and fold the `/renders/` ↔ `/api/renders/`
 * mirror to one form. Returns null for a non-string / empty value. Deliberately lenient: it
 * NEVER collapses two DIFFERENT files, so a benign relative/absolute reformat of the SAME audio
 * still compares equal. (Callers additionally accept a raw exact-string match, so a verbatim
 * value — the legit orchestrator path — always compares equal even without this.)
 */
function canonicalAudioUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch { return s; }
  }
  const q = s.search(/[?#]/);
  if (q !== -1) s = s.slice(0, q);
  if (s.startsWith("/renders/")) s = "/api/renders/" + s.slice("/renders/".length);
  return s || null;
}

/**
 * Does the incoming render config match the paid SOURCE closely enough to ride the FREE
 * `rerenderOf` charge-skip in /api/videos/render? A legit per-window b-roll re-render swaps ONLY
 * `bgVideos` and reuses the source's voice + duration verbatim (see the orchestrator's
 * `rrBaseConfig` = `{ ...preview.config, bgVideos, keywordPopups: [] }`), so we require BOTH:
 *   - `durationInFrames` equal (and > 0) — binds the free render to the paid clip's length so a
 *     longer/expensive config can't ride the skip.
 *   - `voiceFile` (audio identity) equal — the client may NOT swap in a different soundtrack and
 *     still pay nothing. `voiceFile`/`durationInFrames` are the only two source-bound fields; the
 *     rest of the config (scenes/bgVideos/captions) is client-supplied and free to differ.
 *
 * Pure + total: any missing / NaN / mismatched field → `false`, so the route simply falls through
 * to NORMAL charging (never an error, same as every other invalid `rerenderOf` condition today).
 * NEVER returns true when the source carries no usable `voiceFile` (can't bind audio identity).
 */
export function rerenderSkipEligible(args: {
  sourceConfig: Record<string, unknown> | null | undefined;
  incomingConfig: Record<string, unknown> | null | undefined;
}): boolean {
  const { sourceConfig, incomingConfig } = args;
  if (typeof sourceConfig !== "object" || sourceConfig === null) return false;
  if (typeof incomingConfig !== "object" || incomingConfig === null) return false;

  // Duration-frame equality (the existing invariant).
  const srcFrames = Number(sourceConfig.durationInFrames);
  const inFrames = Number(incomingConfig.durationInFrames);
  if (!Number.isFinite(srcFrames) || srcFrames <= 0) return false;
  if (!Number.isFinite(inFrames) || inFrames <= 0) return false;
  if (srcFrames !== inFrames) return false;

  // Audio identity: the free re-render must reuse the paid clip's voice, not a swapped one.
  const srcVoice = sourceConfig.voiceFile;
  const inVoice = incomingConfig.voiceFile;
  if (typeof srcVoice !== "string" || !srcVoice.trim()) return false; // no source voice → ineligible
  if (typeof inVoice !== "string" || !inVoice.trim()) return false;
  if (srcVoice.trim() === inVoice.trim()) return true; // verbatim — the legit orchestrator path
  const a = canonicalAudioUrl(srcVoice);
  const b = canonicalAudioUrl(inVoice);
  return a !== null && a === b;
}
