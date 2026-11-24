import { clampTailHoldMs } from "@/lib/tail-hold";
import type {
  V2Caption,
  V2CardLen,
  V2CardOverrides,
  V2SubConfig,
} from "./subtitle-style";

export const SUBTITLE_DRAFT_STORAGE_PREFIX = "editor-v2-subtitle-draft:";
export const SUBTITLE_DRAFT_VERSION = 1 as const;
export const SUBTITLE_DRAFT_DEBOUNCE_MS = 400;
export const SUBTITLE_DRAFT_MAX_BYTES = 256 * 1024;

export const SUBTITLE_DRAFT_RESTORE_COPY = {
  title: "พบการแก้ไขซับที่ยังไม่ได้ส่งออก",
  description: "กู้คืนข้อความและสไตล์ซับที่แก้ค้างไว้ได้",
  restoreLabel: "กู้คืนการแก้ไข",
  discardLabel: "ทิ้งฉบับร่าง",
} as const;

export type SubtitleDraftScope = {
  accountId: string | null | undefined;
  projectId: string | null | undefined;
  jobId: string | null | undefined;
};

export type SubtitleDraftOwner = {
  accountId: string | null | undefined;
  projectId: string | null | undefined;
};

export type SubtitleDraftState = {
  captions: V2Caption[];
  overrides: V2CardOverrides;
  cfg: V2SubConfig;
  cardLen: V2CardLen;
  tailHoldMs: number;
};

export type StoredSubtitleDraft = SubtitleDraftState & {
  version: typeof SUBTITLE_DRAFT_VERSION;
  jobId: string;
  savedAt: number;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "length" | "key">>;

export type PendingEditResyncAction =
  | "refresh-media-only"
  | "preserve-local-subtitles-rebase"
  | "preserve-local-subtitles"
  | "apply-draft"
  | "apply-forced";

const VALID_CARD_LENS = new Set<V2CardLen>(["sentence", "1", "2", "3", "4"]);
const VALID_FONT_WEIGHTS = new Set([400, 600, 900]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length * 2;
}

/** SecurityError-safe access to window.localStorage (handles private browsing & blocked iframes). */
export function safeSubtitleDraftStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    if (
      !storage
      || typeof storage.getItem !== "function"
      || typeof storage.setItem !== "function"
      || typeof storage.removeItem !== "function"
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

export function subtitleDraftKey(scope: SubtitleDraftScope): string | null {
  const accountId = typeof scope.accountId === "string" ? scope.accountId.trim() : "";
  const projectId = typeof scope.projectId === "string" ? scope.projectId.trim() : "";
  const jobId = typeof scope.jobId === "string" ? scope.jobId.trim() : "";
  if (!accountId || !projectId || !jobId) return null;
  return `${SUBTITLE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(jobId)}`;
}

export function cloneSubtitleDraftState(state: SubtitleDraftState): SubtitleDraftState {
  const overrides: V2CardOverrides = {};
  if (isRecord(state.overrides)) {
    for (const [rawIndex, value] of Object.entries(state.overrides)) {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || !isRecord(value)) continue;
      const entry: { textColor?: string; accentColor?: string } = {};
      if (typeof value.textColor === "string") entry.textColor = value.textColor;
      if (typeof value.accentColor === "string") entry.accentColor = value.accentColor;
      if (entry.textColor !== undefined || entry.accentColor !== undefined) {
        overrides[index] = entry;
      }
    }
  }
  return {
    captions: Array.isArray(state.captions) ? state.captions.map((caption) => ({ ...caption })) : [],
    overrides,
    cfg: isRecord(state.cfg) ? { ...state.cfg } : ({} as V2SubConfig),
    cardLen: state.cardLen,
    tailHoldMs: clampTailHoldMs(state.tailHoldMs),
  };
}

function normalizedOverrideEntries(
  overrides: V2CardOverrides | undefined | null,
): Array<[number, string | undefined, string | undefined]> {
  if (!isRecord(overrides)) return [];
  const entries: Array<[number, string | undefined, string | undefined]> = [];
  for (const [rawIndex, rawValue] of Object.entries(overrides)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || !isRecord(rawValue)) continue;
    const textColor = typeof rawValue.textColor === "string" ? rawValue.textColor : undefined;
    const accentColor = typeof rawValue.accentColor === "string" ? rawValue.accentColor : undefined;
    if (textColor === undefined && accentColor === undefined) continue;
    entries.push([index, textColor, accentColor]);
  }
  entries.sort((left, right) => left[0] - right[0]);
  return entries;
}

function effectiveFontWeight(cfg: Partial<V2SubConfig> | undefined | null): number | undefined {
  if (!cfg) return undefined;
  if (cfg.fontWeight === 400 || cfg.fontWeight === 600 || cfg.fontWeight === 900) {
    return cfg.fontWeight;
  }
  if (typeof cfg.bold === "boolean") {
    return cfg.bold ? 900 : 400;
  }
  return undefined;
}

function subtitleConfigEquals(
  left: Partial<V2SubConfig> | undefined | null,
  right: Partial<V2SubConfig> | undefined | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.preset === right.preset
    && left.effect === right.effect
    && left.fontFamily === right.fontFamily
    && effectiveFontWeight(left) === effectiveFontWeight(right)
    && left.fontSize === right.fontSize
    && left.textColor === right.textColor
    && left.accentColor === right.accentColor
    && left.shadow === right.shadow
    && left.outline === right.outline
    && left.outlineSize === right.outlineSize
    && left.verticalPos === right.verticalPos
    && Boolean(left.highlightKeywords) === Boolean(right.highlightKeywords)
    && Boolean(left.statCards) === Boolean(right.statCards)
    && (left.sfxMode ?? "none") === (right.sfxMode ?? "none")
  );
}

/** Semantic equality across the 5 post-phase subtitle fields guarded by HERO-116. */
export function subtitleDraftEquals(left: SubtitleDraftState, right: SubtitleDraftState): boolean {
  if (left.cardLen !== right.cardLen) return false;
  if (clampTailHoldMs(left.tailHoldMs) !== clampTailHoldMs(right.tailHoldMs)) return false;
  if (!subtitleConfigEquals(left.cfg, right.cfg)) return false;

  const leftCaptions = Array.isArray(left.captions) ? left.captions : [];
  const rightCaptions = Array.isArray(right.captions) ? right.captions : [];
  if (leftCaptions.length !== rightCaptions.length) return false;
  for (let i = 0; i < leftCaptions.length; i += 1) {
    const a = leftCaptions[i];
    const b = rightCaptions[i];
    if (
      !a
      || !b
      || a.text !== b.text
      || a.startMs !== b.startMs
      || a.endMs !== b.endMs
      || (a.tag ?? undefined) !== (b.tag ?? undefined)
    ) {
      return false;
    }
  }

  const leftOverrides = normalizedOverrideEntries(left.overrides);
  const rightOverrides = normalizedOverrideEntries(right.overrides);
  if (leftOverrides.length !== rightOverrides.length) return false;
  for (let i = 0; i < leftOverrides.length; i += 1) {
    const a = leftOverrides[i];
    const b = rightOverrides[i];
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
  }

  return true;
}

export function hasUnsavedSubtitleChanges(
  current: SubtitleDraftState,
  baseline: SubtitleDraftState,
): boolean {
  return !subtitleDraftEquals(current, baseline);
}

function normalizeStoredCaptions(value: unknown): V2Caption[] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const captions: V2Caption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const text = boundedString(candidate.text, 4_000);
    const startMs = finiteNumber(candidate.startMs, 0, 86_400_000);
    const endMs = finiteNumber(candidate.endMs, 0, 86_400_000);
    const tag = candidate.tag === undefined ? undefined : boundedString(candidate.tag, 80);
    if (text === null || startMs === null || endMs === null || endMs < startMs || tag === null) {
      return null;
    }
    captions.push({ text, startMs, endMs, ...(tag === undefined ? {} : { tag }) });
  }
  return captions;
}

function normalizeStoredConfig(value: unknown): V2SubConfig | null {
  if (!isRecord(value)) return null;
  const preset = boundedString(value.preset, 80);
  const effect = boundedString(value.effect, 80);
  const fontFamily = boundedString(value.fontFamily, 200);
  const fontSize = finiteNumber(value.fontSize, 1, 1_000);
  const textColor = boundedString(value.textColor, 64);
  const accentColor = boundedString(value.accentColor, 64);
  const outlineSize = finiteNumber(value.outlineSize, 0, 100);
  const verticalPos = finiteNumber(value.verticalPos, 0, 100);
  const fontWeight = value.fontWeight === undefined ? undefined : Number(value.fontWeight);
  if (
    preset === null
    || effect === null
    || fontFamily === null
    || fontSize === null
    || textColor === null
    || accentColor === null
    || outlineSize === null
    || verticalPos === null
    || typeof value.bold !== "boolean"
    || typeof value.shadow !== "boolean"
    || typeof value.outline !== "boolean"
    || (fontWeight !== undefined && !VALID_FONT_WEIGHTS.has(fontWeight))
    || (value.highlightKeywords !== undefined && typeof value.highlightKeywords !== "boolean")
    || (value.statCards !== undefined && typeof value.statCards !== "boolean")
    || (value.sfxMode !== undefined && value.sfxMode !== "none" && value.sfxMode !== "subtle")
  ) {
    return null;
  }
  return {
    preset: preset as V2SubConfig["preset"],
    effect: effect as V2SubConfig["effect"],
    fontFamily,
    bold: value.bold,
    ...(fontWeight === undefined ? {} : { fontWeight: fontWeight as 400 | 600 | 900 }),
    fontSize,
    textColor,
    accentColor,
    shadow: value.shadow,
    outline: value.outline,
    outlineSize,
    verticalPos,
    ...(typeof value.highlightKeywords === "boolean" ? { highlightKeywords: value.highlightKeywords } : {}),
    ...(typeof value.statCards === "boolean" ? { statCards: value.statCards } : {}),
    ...(value.sfxMode === "none" || value.sfxMode === "subtle" ? { sfxMode: value.sfxMode } : {}),
  };
}

function normalizeStoredOverrides(value: unknown, captionCount: number): V2CardOverrides | null {
  if (!isRecord(value)) return null;
  const overrides: V2CardOverrides = {};
  for (const [rawIndex, candidate] of Object.entries(value)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= captionCount || !isRecord(candidate)) {
      return null;
    }
    const textColor = candidate.textColor === undefined ? undefined : boundedString(candidate.textColor, 64);
    const accentColor = candidate.accentColor === undefined ? undefined : boundedString(candidate.accentColor, 64);
    if (textColor === null || accentColor === null) return null;
    if (textColor !== undefined || accentColor !== undefined) {
      overrides[index] = {
        ...(textColor === undefined ? {} : { textColor }),
        ...(accentColor === undefined ? {} : { accentColor }),
      };
    }
  }
  return overrides;
}

export function parseStoredSubtitleDraft(
  value: unknown,
  expectedJobId: string,
): StoredSubtitleDraft | null {
  if (!isRecord(value)) return null;
  if (value.version !== SUBTITLE_DRAFT_VERSION) return null;
  if (typeof value.jobId !== "string" || !value.jobId || value.jobId !== expectedJobId) return null;
  if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt) || value.savedAt <= 0) {
    return null;
  }
  if (typeof value.cardLen !== "string" || !VALID_CARD_LENS.has(value.cardLen as V2CardLen)) {
    return null;
  }
  if (typeof value.tailHoldMs !== "number" || !Number.isFinite(value.tailHoldMs)) {
    return null;
  }
  const captions = normalizeStoredCaptions(value.captions);
  const cfg = normalizeStoredConfig(value.cfg);
  if (!captions || !cfg) return null;
  const overrides = normalizeStoredOverrides(value.overrides, captions.length);
  if (!overrides) return null;
  return {
    version: SUBTITLE_DRAFT_VERSION,
    jobId: value.jobId,
    savedAt: value.savedAt,
    captions,
    overrides,
    cfg,
    cardLen: value.cardLen as V2CardLen,
    tailHoldMs: clampTailHoldMs(value.tailHoldMs),
  };
}

export function readSubtitleDraft(
  storage: StorageLike | null,
  scope: SubtitleDraftScope,
): StoredSubtitleDraft | null {
  const key = subtitleDraftKey(scope);
  if (!storage || !key || typeof scope.jobId !== "string") return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    return parseStoredSubtitleDraft(JSON.parse(raw), scope.jobId.trim());
  } catch {
    return null;
  }
}

function olderSubtitleDraftKeys(storage: StorageLike, preserveKeys: ReadonlySet<string>): string[] {
  try {
    if (typeof storage.length !== "number" || typeof storage.key !== "function") {
      return [];
    }
    const candidates: Array<{ key: string; savedAt: number }> = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (!k || preserveKeys.has(k) || !k.startsWith(SUBTITLE_DRAFT_STORAGE_PREFIX)) continue;
      let savedAt = 0;
      try {
        const raw = storage.getItem(k);
        if (raw) {
          const parsed = JSON.parse(raw) as { savedAt?: unknown };
          if (typeof parsed?.savedAt === "number" && Number.isFinite(parsed.savedAt)) {
            savedAt = parsed.savedAt;
          }
        }
      } catch {
        // Corrupt entry: treat as oldest (savedAt = 0) so it gets evicted first.
      }
      candidates.push({ key: k, savedAt });
    }
    candidates.sort((left, right) => left.savedAt - right.savedAt);
    return candidates.map((candidate) => candidate.key);
  } catch {
    return [];
  }
}

export function writeSubtitleDraft(
  storage: StorageLike | null,
  scope: SubtitleDraftScope,
  state: SubtitleDraftState,
  now = Date.now(),
  options?: { preserveKeys?: readonly string[] },
): boolean {
  const key = subtitleDraftKey(scope);
  if (!storage || !key || typeof scope.jobId !== "string") return false;
  const normalizedJobId = scope.jobId.trim();
  const payload = parseStoredSubtitleDraft(
    {
      version: SUBTITLE_DRAFT_VERSION,
      jobId: normalizedJobId,
      savedAt: now,
      captions: state.captions,
      overrides: state.overrides,
      cfg: state.cfg,
      cardLen: state.cardLen,
      tailHoldMs: clampTailHoldMs(state.tailHoldMs),
    },
    normalizedJobId,
  );
  if (!payload) return false;
  const serialized = JSON.stringify(payload);
  if (utf8ByteLength(serialized) > SUBTITLE_DRAFT_MAX_BYTES) return false;
  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    // Best-effort quota recovery: evict corrupt/oldest subtitle drafts one by one (never touch
    // unrelated app keys or explicitly preserved keys such as a re-key source) until the write
    // fits. SecurityError / disabled storage returns false without throwing.
    const preserve = new Set<string>([key, ...(options?.preserveKeys ?? [])]);
    const evictable = olderSubtitleDraftKeys(storage, preserve);
    for (const oldKey of evictable) {
      try {
        storage.removeItem(oldKey);
        storage.setItem(key, serialized);
        return true;
      } catch {
        // Keep evicting older subtitle drafts until space frees up or candidates run out.
      }
    }
    return false;
  }
}

export function clearSubtitleDraft(
  storage: StorageLike | null,
  scope: SubtitleDraftScope,
): boolean {
  const key = subtitleDraftKey(scope);
  if (!storage || !key) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate a stored subtitle draft across a B-roll rerender job adoption (`fromJobId -> toJobId`).
 * Preserves the original draft if the destination write fails (e.g., quota exhausted), and avoids
 * overwriting a newer draft already saved at `toJobId`.
 */
export function rekeySubtitleDraft(
  storage: StorageLike | null,
  owner: SubtitleDraftOwner,
  fromJobId: string | null | undefined,
  toJobId: string | null | undefined,
): StoredSubtitleDraft | null {
  const normalizedFrom = typeof fromJobId === "string" ? fromJobId.trim() : "";
  const normalizedTo = typeof toJobId === "string" ? toJobId.trim() : "";
  if (!storage || !normalizedFrom || !normalizedTo) return null;

  if (normalizedFrom === normalizedTo) {
    return readSubtitleDraft(storage, { ...owner, jobId: normalizedTo });
  }

  const fromScope: SubtitleDraftScope = { ...owner, jobId: normalizedFrom };
  const toScope: SubtitleDraftScope = { ...owner, jobId: normalizedTo };
  const existingTarget = readSubtitleDraft(storage, toScope);
  const source = readSubtitleDraft(storage, fromScope);

  if (!source) return existingTarget;
  if (existingTarget && existingTarget.savedAt >= source.savedAt) {
    clearSubtitleDraft(storage, fromScope);
    return existingTarget;
  }

  const fromKey = subtitleDraftKey(fromScope);
  const wrote = writeSubtitleDraft(
    storage,
    toScope,
    source,
    source.savedAt,
    fromKey ? { preserveKeys: [fromKey] } : undefined,
  );
  if (!wrote) return null;
  clearSubtitleDraft(storage, fromScope);
  return {
    ...source,
    jobId: normalizedTo,
  };
}

/**
 * Decide how `usePostPhaseEditor`'s `pendingEdit` resync effect reacts to an incoming server draft:
 * - Explicit 409 `stale_revision` reload (`forceApply`) always adopts the agent's latest draft.
 * - Equal revision only refreshes untouched media import states.
 * - A B-roll rebase revision bump (`brollRebaseInFlight`) must NEVER overwrite unsaved local
 *   subtitle edits; it advances revision/media pointers only.
 * - Any other unsolicited revision bump while the creator has unsaved local subtitle edits also
 *   preserves local subtitles instead of silently clobbering them.
 */
export function decidePendingEditResyncAction(input: {
  incomingRevision: number;
  appliedRevision: number | null;
  hasUnsavedLocalSubtitles: boolean;
  brollRebaseInFlight: boolean;
  forceApply: boolean;
}): PendingEditResyncAction {
  if (input.forceApply) return "apply-forced";
  if (input.appliedRevision === input.incomingRevision) return "refresh-media-only";
  if (input.brollRebaseInFlight) return "preserve-local-subtitles-rebase";
  if (input.hasUnsavedLocalSubtitles) return "preserve-local-subtitles";
  return "apply-draft";
}
