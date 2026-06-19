import { prisma } from "@/lib/prisma";
import { setDynamicLoanwords } from "@/lib/thai-loanwords";

export const LOANWORD_STORE_KEY = "thaiLoanwordsAuto";
export interface LoanwordStore { words: string[]; denylist: string[]; lastRunAt?: string; lastAdded?: string[] }

// Pure: parse a SiteConfig.value string into a store, fail-open to empty.
export function parseLoanwordStore(value: string | null | undefined): LoanwordStore {
  if (!value) return { words: [], denylist: [] };
  try {
    const j = JSON.parse(value);
    return {
      words: Array.isArray(j.words) ? j.words.filter((w: unknown) => typeof w === "string") : [],
      denylist: Array.isArray(j.denylist) ? j.denylist.filter((w: unknown) => typeof w === "string") : [],
      lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : undefined,
      lastAdded: Array.isArray(j.lastAdded) ? j.lastAdded : undefined,
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

export async function readLoanwordStore(): Promise<LoanwordStore> {
  const row = await prisma.siteConfig.findUnique({ where: { key: LOANWORD_STORE_KEY } });
  return parseLoanwordStore(row?.value);
}

export async function writeLoanwordStore(store: LoanwordStore): Promise<void> {
  const value = JSON.stringify(store);
  await prisma.siteConfig.upsert({ where: { key: LOANWORD_STORE_KEY }, create: { key: LOANWORD_STORE_KEY, value }, update: { value } });
}

export async function refreshDynamicLoanwords(): Promise<void> {
  try { const s = await readLoanwordStore(); setDynamicLoanwords(s.words, s.denylist); }
  catch (e) { console.warn("[loanwords] refresh failed (keeping current set):", e); }
}

let _timer: ReturnType<typeof setInterval> | null = null;
export function startLoanwordRefresh(intervalMs = 10 * 60 * 1000): void {
  void refreshDynamicLoanwords();
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => void refreshDynamicLoanwords(), intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
}
