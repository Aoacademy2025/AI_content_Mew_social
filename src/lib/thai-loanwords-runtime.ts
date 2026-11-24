import { prisma } from "@/lib/prisma";
import { setDynamicLoanwords } from "@/lib/thai-loanwords";
import { setDynamicCompounds } from "@/lib/thai-compounds";
import type { CompoundReviewDecision } from "@/lib/compound-review";

export const LOANWORD_STORE_KEY = "thaiLoanwordsAuto";
const REVIEW_LOG_CAP = 150;

export interface CompoundReviewNote {
  word: string;
  decision: CompoundReviewDecision;
  source: "ai" | "guard" | "human";
  reason?: string;
  at: string;
}

export interface CompoundReviewSummary {
  approved: number;
  rejected: number;
  keptForReview: number;
  source: "cron" | "admin";
}

// `words` = auto-mined + manual LOANWORDS (auto-applied, dynamic).
// `denylist` = shared block list (removes a word from BOTH the loanword and compound
//   active sets, and stops either miner re-suggesting it).
// `compounds` = approved native compounds (human or safety-guarded AI auto-approved).
// `autoApprovedCompounds` = subset of `compounds` approved by AI so admins can audit/undo.
// `pendingCompounds` = borderline/unreviewed native-compound candidates awaiting review.
export interface LoanwordStore {
  words: string[];
  denylist: string[];
  compounds?: string[];
  pendingCompounds?: string[];
  autoApprovedCompounds?: string[];
  lastRunAt?: string;
  lastAdded?: string[];
  lastCompoundRunAt?: string;
  lastCompoundsFound?: string[];
  lastCompoundReviewAt?: string;
  lastCompoundReviewSummary?: CompoundReviewSummary;
  compoundReviewLog?: CompoundReviewNote[];
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === "string") : []);

function parseReviewLog(v: unknown): CompoundReviewNote[] {
  if (!Array.isArray(v)) return [];
  const out: CompoundReviewNote[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.word !== "string" || !r.word) continue;
    if (r.decision !== "approve" && r.decision !== "reject" && r.decision !== "review") continue;
    const source = r.source === "ai" || r.source === "guard" || r.source === "human" ? r.source : "ai";
    out.push({
      word: r.word,
      decision: r.decision,
      source,
      reason: typeof r.reason === "string" ? r.reason : undefined,
      at: typeof r.at === "string" ? r.at : "",
    });
  }
  return out.slice(0, REVIEW_LOG_CAP);
}

function parseReviewSummary(v: unknown): CompoundReviewSummary | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.approved !== "number" || typeof r.rejected !== "number" || typeof r.keptForReview !== "number") {
    return undefined;
  }
  return {
    approved: r.approved,
    rejected: r.rejected,
    keptForReview: r.keptForReview,
    source: r.source === "admin" ? "admin" : "cron",
  };
}

// Pure: parse a SiteConfig.value string into a store, fail-open to empty.
export function parseLoanwordStore(value: string | null | undefined): LoanwordStore {
  if (!value) return { words: [], denylist: [] };
  try {
    const j = JSON.parse(value);
    return {
      words: strArr(j.words),
      denylist: strArr(j.denylist),
      compounds: strArr(j.compounds),
      pendingCompounds: strArr(j.pendingCompounds),
      autoApprovedCompounds: strArr(j.autoApprovedCompounds),
      lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : undefined,
      lastAdded: Array.isArray(j.lastAdded) ? strArr(j.lastAdded) : undefined,
      lastCompoundRunAt: typeof j.lastCompoundRunAt === "string" ? j.lastCompoundRunAt : undefined,
      lastCompoundsFound: Array.isArray(j.lastCompoundsFound) ? strArr(j.lastCompoundsFound) : undefined,
      lastCompoundReviewAt: typeof j.lastCompoundReviewAt === "string" ? j.lastCompoundReviewAt : undefined,
      lastCompoundReviewSummary: parseReviewSummary(j.lastCompoundReviewSummary),
      compoundReviewLog: parseReviewLog(j.compoundReviewLog),
    };
  } catch { return { words: [], denylist: [] }; }
}

// Pure: append new words to a store (dedup), returning a new store.
export function mergeStore(store: LoanwordStore, newWords: string[]): LoanwordStore {
  const set = new Set(store.words);
  for (const w of newWords) set.add(w);
  return { ...store, words: [...set] };
}

// Pure store mutations for the admin loanword manager. Words auto-applied by the
// cron live in `words`; `denylist` blocks a word from being re-added by either pass.
export function denyWord(store: LoanwordStore, word: string): LoanwordStore {
  return {
    ...store,
    words: store.words.filter((w) => w !== word),
    denylist: store.denylist.includes(word) ? store.denylist : [...store.denylist, word],
  };
}
export function restoreWord(store: LoanwordStore, word: string): LoanwordStore {
  return { ...store, denylist: store.denylist.filter((w) => w !== word) };
}
export function addWord(store: LoanwordStore, word: string): LoanwordStore {
  return {
    ...store,
    words: store.words.includes(word) ? store.words : [...store.words, word],
    denylist: store.denylist.filter((w) => w !== word), // a manually added word must not stay blocked
  };
}
export function editWord(store: LoanwordStore, oldWord: string, newWord: string): LoanwordStore {
  const words = store.words.filter((w) => w !== oldWord);
  if (newWord && !words.includes(newWord)) words.push(newWord);
  return { ...store, words };
}

// ── Native-compound review (Part 2 + AI auto-review) ─────────────────────────
export function addPendingCompounds(store: LoanwordStore, candidates: string[]): LoanwordStore {
  const known = new Set([...store.words, ...(store.compounds ?? []), ...store.denylist, ...(store.pendingCompounds ?? [])]);
  const pending = [...(store.pendingCompounds ?? [])];
  for (const w of candidates) {
    if (typeof w === "string" && w.length > 0 && !known.has(w)) { known.add(w); pending.push(w); }
  }
  return { ...store, pendingCompounds: pending };
}

export function approveCompound(store: LoanwordStore, word: string): LoanwordStore {
  const compounds = store.compounds ?? [];
  return {
    ...store,
    compounds: compounds.includes(word) ? compounds : [...compounds, word],
    pendingCompounds: (store.pendingCompounds ?? []).filter((w) => w !== word),
    autoApprovedCompounds: (store.autoApprovedCompounds ?? []).filter((w) => w !== word),
    denylist: store.denylist.filter((w) => w !== word), // an approved compound must not stay blocked
  };
}

export function addCompound(store: LoanwordStore, word: string): LoanwordStore {
  return approveCompound(store, word);
}

export function rejectCompound(store: LoanwordStore, word: string): LoanwordStore {
  return {
    ...store,
    compounds: (store.compounds ?? []).filter((w) => w !== word),
    pendingCompounds: (store.pendingCompounds ?? []).filter((w) => w !== word),
    autoApprovedCompounds: (store.autoApprovedCompounds ?? []).filter((w) => w !== word),
    denylist: store.denylist.includes(word) ? store.denylist : [...store.denylist, word],
  };
}

export function bulkApproveCompounds(store: LoanwordStore, words: string[]): LoanwordStore {
  let next = store;
  for (const w of words) {
    const trimmed = typeof w === "string" ? w.trim() : "";
    if (trimmed) next = approveCompound(next, trimmed);
  }
  return next;
}

export function bulkRejectCompounds(store: LoanwordStore, words: string[]): LoanwordStore {
  let next = store;
  for (const w of words) {
    const trimmed = typeof w === "string" ? w.trim() : "";
    if (trimmed) next = rejectCompound(next, trimmed);
  }
  return next;
}

export function applyCompoundReview(
  store: LoanwordStore,
  items: { word: string; decision: CompoundReviewDecision; source: "ai" | "guard" | "human"; reason?: string }[],
  meta: { source: "cron" | "admin"; at?: string },
): { store: LoanwordStore; summary: CompoundReviewSummary } {
  const at = meta.at ?? new Date().toISOString();
  const compoundsSet = new Set(store.compounds ?? []);
  const autoApprovedSet = new Set(store.autoApprovedCompounds ?? []);
  const pendingSet = new Set(store.pendingCompounds ?? []);
  const denySet = new Set(store.denylist);

  let approved = 0;
  let rejected = 0;
  let keptForReview = 0;

  const newNotes: CompoundReviewNote[] = [];

  for (const item of items) {
    const word = item.word.trim();
    if (!word) continue;
    if (item.decision === "approve") {
      compoundsSet.add(word);
      if (item.source === "ai") autoApprovedSet.add(word);
      pendingSet.delete(word);
      denySet.delete(word);
      approved++;
    } else if (item.decision === "reject") {
      compoundsSet.delete(word);
      autoApprovedSet.delete(word);
      pendingSet.delete(word);
      denySet.add(word);
      rejected++;
    } else {
      if (!compoundsSet.has(word) && !denySet.has(word)) {
        pendingSet.add(word);
      }
      keptForReview++;
    }
    newNotes.push({
      word,
      decision: item.decision,
      source: item.source,
      reason: item.reason,
      at,
    });
  }

  // Merge newest review notes at front, deduplicating by word (latest wins), capped.
  const mergedLog: CompoundReviewNote[] = [];
  const seenWords = new Set<string>();
  for (const note of [...newNotes, ...(store.compoundReviewLog ?? [])]) {
    if (seenWords.has(note.word)) continue;
    seenWords.add(note.word);
    mergedLog.push(note);
    if (mergedLog.length >= REVIEW_LOG_CAP) break;
  }

  const summary: CompoundReviewSummary = {
    approved,
    rejected,
    keptForReview,
    source: meta.source,
  };

  return {
    store: {
      ...store,
      compounds: [...compoundsSet],
      autoApprovedCompounds: [...autoApprovedSet].filter((w) => compoundsSet.has(w)),
      pendingCompounds: [...pendingSet],
      denylist: [...denySet],
      lastCompoundReviewAt: at,
      lastCompoundReviewSummary: summary,
      compoundReviewLog: mergedLog,
    },
    summary,
  };
}

let _storeRevision = 0;
export function getLoanwordStoreRevision(): number {
  return _storeRevision;
}
export function bumpLoanwordStoreRevision(): void {
  _storeRevision += 1;
}

export async function readLoanwordStore(): Promise<LoanwordStore> {
  const row = await prisma.siteConfig.findUnique({ where: { key: LOANWORD_STORE_KEY } });
  return parseLoanwordStore(row?.value);
}

export async function writeLoanwordStore(store: LoanwordStore): Promise<void> {
  const value = JSON.stringify(store);
  await prisma.siteConfig.upsert({ where: { key: LOANWORD_STORE_KEY }, create: { key: LOANWORD_STORE_KEY, value }, update: { value } });
  bumpLoanwordStoreRevision();
}

export async function refreshDynamicLoanwords(): Promise<void> {
  try {
    const s = await readLoanwordStore();
    setDynamicLoanwords(s.words, s.denylist);
    setDynamicCompounds(s.compounds ?? [], s.denylist); // approved compounds → live merge (same refresh)
  } catch (e) { console.warn("[loanwords] refresh failed (keeping current set):", e); }
}

let _timer: ReturnType<typeof setInterval> | null = null;
export function startLoanwordRefresh(intervalMs = 10 * 60 * 1000): void {
  void refreshDynamicLoanwords();
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => void refreshDynamicLoanwords(), intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
}
