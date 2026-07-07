import { prisma } from "@/lib/prisma";
import { setDynamicLoanwords } from "@/lib/thai-loanwords";
import { setDynamicCompounds } from "@/lib/thai-compounds";

export const LOANWORD_STORE_KEY = "thaiLoanwordsAuto";
// `words` = auto-mined + manual LOANWORDS (auto-applied, dynamic).
// `denylist` = shared block list (removes a word from BOTH the loanword and compound
//   active sets, and stops either miner re-suggesting it).
// `compounds` = admin-APPROVED native compounds (Part 2; dynamic, merged at render).
// `pendingCompounds` = mined native-compound candidates AWAITING admin review — NEVER
//   auto-merged (deciding "real compound" vs "incidental word sequence" is subjective).
export interface LoanwordStore {
  words: string[];
  denylist: string[];
  compounds?: string[];
  pendingCompounds?: string[];
  lastRunAt?: string;
  lastAdded?: string[];
  lastCompoundRunAt?: string;
  lastCompoundsFound?: string[];
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === "string") : []);

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
      lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : undefined,
      lastAdded: Array.isArray(j.lastAdded) ? j.lastAdded : undefined,
      lastCompoundRunAt: typeof j.lastCompoundRunAt === "string" ? j.lastCompoundRunAt : undefined,
      lastCompoundsFound: Array.isArray(j.lastCompoundsFound) ? j.lastCompoundsFound : undefined,
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

// ── Native-compound review (Part 2) — mined candidates are HUMAN-GATED. ──
// The miner drops candidates into `pendingCompounds` (never merged). Admin approve →
// moves into the live `compounds` list (merged at render via refreshDynamicLoanwords).
// Admin reject → drops from pending + adds to the shared denylist so it's never merged
// or re-suggested. Mirrors the loanword add/deny shapes.
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
    denylist: store.denylist.filter((w) => w !== word), // an approved compound must not stay blocked
  };
}
export function rejectCompound(store: LoanwordStore, word: string): LoanwordStore {
  return {
    ...store,
    compounds: (store.compounds ?? []).filter((w) => w !== word),
    pendingCompounds: (store.pendingCompounds ?? []).filter((w) => w !== word),
    denylist: store.denylist.includes(word) ? store.denylist : [...store.denylist, word],
  };
}

export async function readLoanwordStore(): Promise<LoanwordStore> {
  const row = await prisma.siteConfig.findUnique({ where: { key: LOANWORD_STORE_KEY } });
  return parseLoanwordStore(row?.value);
}

export async function writeLoanwordStore(store: LoanwordStore): Promise<void> {
  const value = JSON.stringify(store);
  await prisma.siteConfig.upsert({ where: { key: LOANWORD_STORE_KEY }, create: { key: LOANWORD_STORE_KEY, value }, update: { value } });
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
