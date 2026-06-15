# Thai Loanword Auto-Mine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily cron that mines new Thai loanwords ICU mis-splits from real prod scripts and auto-applies them live (MCP worker + web editor) via a `SiteConfig` store, with admin notification and a denylist for reversal.

**Architecture:** Dynamic loanwords live in `SiteConfig["thaiLoanwordsAuto"]` (JSON). The pure lib `thai-loanwords.ts` merges static∪dynamic−denylist in memory via `setDynamicLoanwords`. A prisma loader refreshes that in-memory set on the server (worker startup + 10-min interval); the web editor fetches the merged list from `GET /api/thai-loanwords` on mount. A daily PM2 cron mines yesterday's scripts (dictionary-oracle diff vs `Intl.Segmenter`), appends new words to the store, and notifies admins.

**Tech Stack:** TypeScript, Next.js App Router, Prisma/SQLite, `Intl.Segmenter`, PM2 cron, `tsx` verify scripts.

---

## File Structure
- Modify `src/lib/thai-loanwords.ts` — add dynamic/denylist sets, `setDynamicLoanwords`, `getActiveLoanwords`; `loanwordSpans` uses active list.
- Create `src/lib/loanword-mining.ts` — pure dict-oracle miner (shared by cron + standalone script).
- Create `src/lib/thai-loanwords-runtime.ts` — prisma store read/write + `refreshDynamicLoanwords` + `startLoanwordRefresh` + pure `parseLoanwordStore`.
- Create `src/app/api/thai-loanwords/route.ts` — authed, cached GET of merged list.
- Modify `src/app/(dashboard)/video-editor/page.tsx` — `useEffect` fetch → `setDynamicLoanwords` (fail-open).
- Modify `scripts/mcp-video-worker.ts` — call `startLoanwordRefresh()` at startup.
- Create `scripts/cron-mine-loanwords.ts` — cron entry (pull scripts, mine, write store, notify).
- Modify `scripts/mine-thai-loanwords.ts` — reuse `loanword-mining.ts`.
- Modify `ecosystem.config.js` — add `mine-loanwords` PM2 cron app.
- Create `data/words_th.txt` + `data/words_th.LICENSE` — vendored PyThaiNLP wordlist (oracle).
- Create tests: `scripts/verify-loanword-merge.ts`, `scripts/verify-loanword-mining.ts`, `scripts/verify-loanword-store.ts`.

---

### Task 1: Runtime merge in `thai-loanwords.ts`

**Files:**
- Modify: `src/lib/thai-loanwords.ts`
- Test: `scripts/verify-loanword-merge.ts`

- [ ] **Step 1: Write the failing test** — Create `scripts/verify-loanword-merge.ts`:

```typescript
// static ∪ dynamic − denylist merge for loanwords.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-merge.ts
import { THAI_LOANWORDS, setDynamicLoanwords, getActiveLoanwords, loanwordSpans } from "../src/lib/thai-loanwords";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// default: active == static
setDynamicLoanwords([], []);
assert(getActiveLoanwords().length === THAI_LOANWORDS.length, "default active == static list");

// dynamic words are added and deduped against static
setDynamicLoanwords(["สตรีมมิ่ง", "แอดมิน"], []);
const a = getActiveLoanwords();
assert(a.includes("สตรีมมิ่ง"), "dynamic word added");
assert(a.filter((w) => w === "แอดมิน").length === 1, "dynamic dupe of static deduped");

// denylist removes a word even if static
setDynamicLoanwords(["สตรีมมิ่ง"], ["แอดมิน"]);
const b = getActiveLoanwords();
assert(!b.includes("แอดมิน"), "denylist removes a static word");
assert(b.includes("สตรีมมิ่ง"), "dynamic survives denylist of other word");

// loanwordSpans reflects dynamic words
setDynamicLoanwords(["สตรีมมิ่ง"], []);
const spans = loanwordSpans("วันนี้ดูสตรีมมิ่งสนุก");
assert(spans.some((s) => "วันนี้ดูสตรีมมิ่งสนุก".slice(s.start, s.end) === "สตรีมมิ่ง"), "loanwordSpans uses dynamic words");

setDynamicLoanwords([], []); // reset
console.log(`\n${passed} checks passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-merge.ts`
Expected: FAIL — `setDynamicLoanwords`/`getActiveLoanwords` are not exported.

- [ ] **Step 3: Implement** — In `src/lib/thai-loanwords.ts`, after the `THAI_LOANWORDS` array, add:

```typescript
// Dynamic loanwords (auto-mined, stored in SiteConfig) merged on top of the static
// seed at runtime. setDynamicLoanwords is called by the server loader and the web
// editor; getActiveLoanwords is the single list everything else consumes. Cached:
// recomputed only when setDynamicLoanwords runs (loanwordSpans reads it per call).
let _active: string[] = [...THAI_LOANWORDS];
export function setDynamicLoanwords(words: string[], denylist: string[] = []): void {
  const deny = new Set(Array.isArray(denylist) ? denylist : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...THAI_LOANWORDS, ...(Array.isArray(words) ? words : [])]) {
    if (typeof w !== "string" || w.length === 0 || deny.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  _active = out;
}
export function getActiveLoanwords(): string[] {
  return _active;
}
```

Then change `loanwordSpans` to iterate the active list — replace `for (const w of THAI_LOANWORDS) {` with `for (const w of getActiveLoanwords()) {`.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-merge.ts`
Expected: PASS — `5 checks passed`.

- [ ] **Step 5: Run existing guards to confirm no regression**

Run: `for s in verify-thai-wordbreak verify-word-boundaries verify-subtitle-garan; do DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/$s.ts >/dev/null && echo "$s OK"; done`
Expected: all three `OK`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/thai-loanwords.ts scripts/verify-loanword-merge.ts
git commit -m "feat(loanwords): runtime dynamic+denylist merge (static∪dynamic−denylist)"
```

---

### Task 2: Pure mining module `loanword-mining.ts`

**Files:**
- Create: `src/lib/loanword-mining.ts`
- Modify: `scripts/mine-thai-loanwords.ts`
- Test: `scripts/verify-loanword-mining.ts`

- [ ] **Step 1: Write the failing test** — Create `scripts/verify-loanword-mining.ts`:

```typescript
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-mining.ts
import { mineLoanwords } from "../src/lib/loanword-mining";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// tiny dict containing a loanword (ไอเดีย) + native words; ICU splits ไอเดีย => ไอ|เดีย
const dict = new Set(["ไอเดีย", "วันนี้", "ดี", "มาก", "ที่", "ไม่"]);
const scripts = ["วันนี้ไอเดียดีมาก", "ไอเดียนี้ดี"]; // ไอเดีย appears in both

const res = mineLoanwords(scripts, dict, new Set(), { minLen: 4, cap: 25 });
assert(res.some((r) => r.word === "ไอเดีย"), "detects loanword ไอเดีย (gibberish ICU fragment)");
assert(!res.some((r) => r.word === "วันนี้"), "skips native compound (fragments are dict words)");
assert(res.find((r) => r.word === "ไอเดีย")!.count === 2, "frequency counts distinct scripts");

// already-known words are excluded
const res2 = mineLoanwords(scripts, dict, new Set(["ไอเดีย"]), { minLen: 4, cap: 25 });
assert(!res2.some((r) => r.word === "ไอเดีย"), "excludes already-known words");

// cap limits output
const many = new Set(["ไอเดีย", "ครีเอเตอร์", "ซีรีส์"]);
const scriptsMany = ["ไอเดียครีเอเตอร์ซีรีส์"];
assert(mineLoanwords(scriptsMany, many, new Set(), { minLen: 4, cap: 1 }).length <= 1, "cap limits results");

console.log(`\n${passed} checks passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-mining.ts`
Expected: FAIL — module `src/lib/loanword-mining.ts` does not exist.

- [ ] **Step 3: Implement** — Create `src/lib/loanword-mining.ts`:

```typescript
// Pure dictionary-oracle miner: find Thai loanwords that Intl.Segmenter mis-splits.
// A dict word whose ICU segmentation contains a non-dictionary "gibberish" fragment
// is a loanword ICU broke (native compounds split into real words → skipped). No I/O.
export interface MineResult { word: string; count: number; frags: string[] }
export interface MineOpts { minLen?: number; cap?: number }

const COMMON = new Set(["ที่","ไม่","ได้","ใน","ของ","จะ","และ","การ","ความ","มี","ให้","เป็น","กับ","ก็","ว่า","แต่","นี้","นั้น","ครับ","ค่ะ","ต้อง","มา","ไป","อยาก","ตัว","เอง","วัน","ตอน","คน"]);

function maxLenOf(dict: Set<string>): number { let m = 2; for (const w of dict) if (w.length > m) m = w.length; return m; }

function dictWords(span: string, base: number, dict: Set<string>, maxLen: number) {
  const out: { word: string; s: number; e: number }[] = [];
  let i = 0;
  while (i < span.length) {
    let matched = "";
    for (let L = Math.min(maxLen, span.length - i); L >= 2; L--) { const c = span.substr(i, L); if (dict.has(c)) { matched = c; break; } }
    if (matched) { out.push({ word: matched, s: base + i, e: base + i + matched.length }); i += matched.length; } else i += 1;
  }
  return out;
}

export function mineLoanwords(scripts: string[], dict: Set<string>, already: Set<string>, opts: MineOpts = {}): MineResult[] {
  const minLen = opts.minLen ?? 4;
  const cap = opts.cap ?? 25;
  const maxLen = maxLenOf(dict);
  const seg = new Intl.Segmenter("th", { granularity: "word" });
  const icuFrags = (w: string) => [...seg.segment(w)].map((t) => t.segment);
  const freq = new Map<string, number>();
  for (const script of scripts) {
    if (typeof script !== "string" || !script) continue;
    const icu = new Set<number>();
    for (const tok of seg.segment(script)) icu.add(tok.index);
    const seen = new Set<string>();
    const re = /[ก-๙]{2,}/g; let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      for (const dw of dictWords(m[0], m.index, dict, maxLen)) {
        if (dw.word.length < minLen || already.has(dw.word)) continue;
        let cut = false; for (let b = dw.s + 1; b < dw.e; b++) if (icu.has(b)) { cut = true; break; }
        if (!cut) continue;
        const gibberish = icuFrags(dw.word).some((f) => !dict.has(f) && !COMMON.has(f));
        if (!gibberish) continue;
        if (!seen.has(dw.word)) { seen.add(dw.word); freq.set(dw.word, (freq.get(dw.word) ?? 0) + 1); }
      }
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([word, count]) => ({ word, count, frags: icuFrags(word) }));
}

export function loadThaiDict(text: string): Set<string> {
  const dict = new Set<string>();
  for (const raw of text.split("\n")) { const w = raw.trim(); if (/^[ก-๙]{2,24}$/.test(w)) dict.add(w); }
  return dict;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-mining.ts`
Expected: PASS — `5 checks passed`.

- [ ] **Step 5: Refactor `scripts/mine-thai-loanwords.ts` to reuse the module** — replace its inline dict/miner with:

```typescript
import * as fs from "fs";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
import { mineLoanwords, loadThaiDict } from "../src/lib/loanword-mining";
const dict = loadThaiDict(fs.readFileSync(process.env.WORDLIST_PATH || "/tmp/words_th.txt", "utf8"));
const scripts: string[] = [];
for (const line of fs.readFileSync(process.env.SCRIPTS_PATH || "/tmp/today_scripts.jsonl", "utf8").split("\n")) {
  const t = line.trim(); if (!t) continue;
  try { const s = JSON.parse(t); if (typeof s === "string" && s.trim()) scripts.push(s); } catch { /* skip */ }
}
const res = mineLoanwords(scripts, dict, new Set(THAI_LOANWORDS), { minLen: 4, cap: 9999 });
console.log(`scripts=${scripts.length} dict=${dict.size}  new loanword-like mis-splits: ${res.length}\n`);
for (const r of res) console.log(`${String(r.count).padStart(2)}x  ${r.word.padEnd(16)} => ${r.frags.join("|")}`);
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/loanword-mining.ts scripts/verify-loanword-mining.ts scripts/mine-thai-loanwords.ts
git commit -m "feat(loanwords): extract pure dict-oracle miner + reuse in standalone script"
```

---

### Task 3: Vendor the Thai wordlist oracle

**Files:**
- Create: `data/words_th.txt`, `data/words_th.LICENSE`

- [ ] **Step 1: Generate the filtered wordlist** (Thai-only, smaller). The raw list is already at `/tmp/words_th.txt` from earlier mining; if absent, fetch it:

```bash
[ -f /tmp/words_th.txt ] || curl -sL -o /tmp/words_th.txt https://raw.githubusercontent.com/PyThaiNLP/pythainlp/dev/pythainlp/corpus/words_th.txt
mkdir -p data
grep -E '^[ก-๙]{2,24}$' /tmp/words_th.txt > data/words_th.txt
wc -l data/words_th.txt
```

- [ ] **Step 2: Add attribution** — Create `data/words_th.LICENSE`:

```
Thai word list (data/words_th.txt) derived from PyThaiNLP corpus `words_th.txt`.
Source: https://github.com/PyThaiNLP/pythainlp
License: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
Filtered to Thai-only tokens (^[ก-๙]{2,24}$) for the loanword-mining oracle.
```

- [ ] **Step 3: Commit**

```bash
git add data/words_th.txt data/words_th.LICENSE
git commit -m "chore(loanwords): vendor PyThaiNLP Thai wordlist oracle (Apache-2.0)"
```

---

### Task 4: Server store loader `thai-loanwords-runtime.ts`

**Files:**
- Create: `src/lib/thai-loanwords-runtime.ts`
- Test: `scripts/verify-loanword-store.ts`

- [ ] **Step 1: Write the failing test** — Create `scripts/verify-loanword-store.ts`:

```typescript
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-store.ts
import { parseLoanwordStore, mergeStore } from "../src/lib/thai-loanwords-runtime";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

assert(parseLoanwordStore(null).words.length === 0, "null → empty store");
assert(parseLoanwordStore("not json").denylist.length === 0, "bad json → empty store (fail-open)");
const s = parseLoanwordStore(JSON.stringify({ words: ["ไอเดีย"], denylist: ["x"], lastRunAt: "t" }));
assert(s.words[0] === "ไอเดีย" && s.denylist[0] === "x", "parses valid store");

const merged = mergeStore({ words: ["ไอเดีย"], denylist: [] }, ["ไอเดีย", "ครีเอเตอร์"]);
assert(merged.words.length === 2 && merged.words.includes("ครีเอเตอร์"), "mergeStore adds new, dedupes existing");

console.log(`\n${passed} checks passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-store.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — Create `src/lib/thai-loanwords-runtime.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-store.ts`
Expected: PASS — `5 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/thai-loanwords-runtime.ts scripts/verify-loanword-store.ts
git commit -m "feat(loanwords): SiteConfig store loader + pure parse/merge helpers"
```

---

### Task 5: Wire the loader into the MCP worker

**Files:**
- Modify: `scripts/mcp-video-worker.ts`

- [ ] **Step 1: Add the startup call** — near the top of the worker's main loop init (after imports), add:

```typescript
import { startLoanwordRefresh } from "../src/lib/thai-loanwords-runtime";
startLoanwordRefresh(); // load dynamic loanwords now + refresh every 10 min (unref'd)
```

- [ ] **Step 2: Verify it compiles / runs**

Run: `node_modules/.bin/tsc --noEmit` → Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/mcp-video-worker.ts
git commit -m "feat(loanwords): MCP worker loads + refreshes dynamic loanwords on startup"
```

---

### Task 6: API route `GET /api/thai-loanwords`

**Files:**
- Create: `src/app/api/thai-loanwords/route.ts`

- [ ] **Step 1: Implement the route**

```typescript
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { THAI_LOANWORDS } from "@/lib/thai-loanwords";
import { readLoanwordStore } from "@/lib/thai-loanwords-runtime";

// 5-min server cache so editor mounts don't hammer the DB.
let cache: { at: number; data: { words: string[]; denylist: string[] } } | null = null;
const TTL = 5 * 60 * 1000;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const now = Date.now();
  if (cache && now - cache.at < TTL) return NextResponse.json(cache.data);
  const store = await readLoanwordStore();
  const deny = new Set(store.denylist);
  const words = [...new Set([...THAI_LOANWORDS, ...store.words])].filter((w) => !deny.has(w));
  const data = { words, denylist: store.denylist };
  cache = { at: now, data };
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Verify compiles + manual hit**

Run: `node_modules/.bin/tsc --noEmit` → Expected: 0 errors. (Manual: `curl` while logged in returns `{words:[...]}`; deferred to final verification.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/thai-loanwords/route.ts
git commit -m "feat(loanwords): authed cached GET /api/thai-loanwords (merged list for client)"
```

---

### Task 7: Web editor fetches dynamic loanwords on mount

**Files:**
- Modify: `src/app/(dashboard)/video-editor/page.tsx`

- [ ] **Step 1: Add import** — with the other `@/lib` imports at the top of the file:

```typescript
import { setDynamicLoanwords } from "@/lib/thai-loanwords";
```

- [ ] **Step 2: Add a mount-time fetch** — add this `useEffect` alongside the existing ones (e.g., near the `fetch("/api/user/me")` effect):

```typescript
  // Load auto-mined loanwords so client-side word-mode splitting keeps them whole.
  // Fail-open: on any error the static list (already bundled) is used.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/thai-loanwords")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && Array.isArray(d.words)) setDynamicLoanwords(d.words, Array.isArray(d.denylist) ? d.denylist : []); })
      .catch(() => { /* fail-open: static list only */ });
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 3: Verify compiles**

Run: `node_modules/.bin/tsc --noEmit` → Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/video-editor/page.tsx"
git commit -m "feat(loanwords): editor loads dynamic loanwords on mount (fail-open)"
```

---

### Task 8: Cron script `cron-mine-loanwords.ts`

**Files:**
- Create: `scripts/cron-mine-loanwords.ts`

- [ ] **Step 1: Implement the cron entry**

```typescript
// Daily: mine new Thai loanwords from the last ~26h of prod scripts, auto-apply
// them via SiteConfig, notify admins. Reversible via the store's denylist.
//   DATABASE_URL=... npx tsx scripts/cron-mine-loanwords.ts
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/prisma";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
import { mineLoanwords, loadThaiDict } from "../src/lib/loanword-mining";
import { readLoanwordStore, writeLoanwordStore, mergeStore } from "../src/lib/thai-loanwords-runtime";
import { notifyAdmins } from "../src/lib/notifications";

const LOOKBACK_MS = 26 * 60 * 60 * 1000;
const CAP = 25;

async function main() {
  const since = Date.now() - LOOKBACK_MS;
  const jobs = await prisma.videoJob.findMany({ where: { createdAt: { gte: new Date(since) } }, select: { inputJson: true } });
  const vids = await prisma.video.findMany({ where: { createdAt: { gte: new Date(since) }, script: { not: null } }, select: { script: true } });
  const scripts: string[] = [];
  for (const j of jobs) { try { const s = JSON.parse(j.inputJson)?.script; if (typeof s === "string" && s.trim()) scripts.push(s); } catch { /* skip */ } }
  for (const v of vids) { if (typeof v.script === "string" && v.script.trim()) scripts.push(v.script); }

  const dict = loadThaiDict(fs.readFileSync(path.join(process.cwd(), "data/words_th.txt"), "utf8"));
  const store = await readLoanwordStore();
  const already = new Set([...THAI_LOANWORDS, ...store.words, ...store.denylist]);
  const found = mineLoanwords(scripts, dict, already, { minLen: 4, cap: CAP });
  const newWords = found.map((f) => f.word);

  const next = mergeStore({ ...store, lastRunAt: new Date().toISOString(), lastAdded: newWords }, newWords);
  await writeLoanwordStore(next);

  console.log(`[mine-loanwords] scripts=${scripts.length} added=${newWords.length} ${newWords.join(",")}`);
  await prisma.telemetryEvent.create({ data: { name: "loanwords.mined", category: "pipeline", source: "server", value: newWords.length, properties: JSON.stringify({ added: newWords, scripts: scripts.length }) } });
  if (newWords.length > 0) {
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `เพิ่มคำตัดซับใหม่ ${newWords.length} คำ`,
      body: `ระบบเจอ loanword ที่ตัดผิดจากงานวันนี้และเพิ่มเข้าระบบแล้ว: ${newWords.join(", ")} — ถ้าคำไหนไม่ถูก เพิ่มลง denylist ใน SiteConfig["thaiLoanwordsAuto"]`,
    });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("[mine-loanwords] failed:", e); process.exit(1); });
```

> Note: confirm `notifyAdmins` accepts `{ type, title, body }` — read `src/lib/notifications.ts:28` during implementation; if the param names differ (e.g. `message` instead of `body`), match them.

- [ ] **Step 2: Verify compiles**

Run: `node_modules/.bin/tsc --noEmit` → Expected: 0 errors.

- [ ] **Step 3: Dry-run against the dev DB** (creates/updates SiteConfig in dev.db only)

Run: `cp /tmp/words_th.txt data/words_th.txt 2>/dev/null; DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/cron-mine-loanwords.ts`
Expected: prints `[mine-loanwords] scripts=N added=M ...` without throwing (dev DB likely has few/no scripts → added=0 is fine).

- [ ] **Step 4: Commit**

```bash
git add scripts/cron-mine-loanwords.ts
git commit -m "feat(loanwords): daily cron — mine prod scripts, auto-apply via SiteConfig, notify admins"
```

---

### Task 9: Register the PM2 cron app

**Files:**
- Modify: `ecosystem.config.js`

- [ ] **Step 1: Add the app** — inside the `apps` array (mirror the `media-cleanup` entry), add:

```javascript
    {
      name: "mine-loanwords",
      script: "node_modules/.bin/tsx",
      args: "scripts/cron-mine-loanwords.ts",
      cron_restart: "10 4 * * *", // daily 04:10 — mine new Thai loanwords from prod scripts
      autorestart: false,
      env: {
        NODE_ENV: "production",
      },
    },
```

- [ ] **Step 2: Sanity-check JS** — Run: `node -e "require('./ecosystem.config.js'); console.log('ecosystem OK')"` → Expected: `ecosystem OK`.

- [ ] **Step 3: Commit**

```bash
git add ecosystem.config.js
git commit -m "chore(loanwords): register mine-loanwords PM2 cron (daily 04:10)"
```

---

### Task 10: Final verification

- [ ] **Step 1: All loanword + timing guards green**

Run:
```bash
for s in verify-loanword-merge verify-loanword-mining verify-loanword-store verify-thai-wordbreak verify-word-boundaries verify-subtitle-garan verify-tts-timing verify-split-snap; do
  DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/$s.ts >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"; done
```
Expected: every line `OK`.

- [ ] **Step 2: Typecheck**

Run: `node_modules/.bin/tsc --noEmit` → Expected: `0 errors`.

- [ ] **Step 3: Push + PR** (depends on #61 being merged first; rebase if needed)

```bash
git push -u origin mew/loanword-auto-mine-cron
gh pr create --base main --title "feat(subtitle): daily auto-mine Thai loanwords (live + notify)" --body "Implements docs/superpowers/specs/2026-06-15-thai-loanword-auto-mine-design.md"
```

- [ ] **Step 4: Deploy notes (manual, after merge)** — `deploy.sh` (no schema change, but `prisma db push` is a no-op-safe), then restart `ai-content` + `mcp-video-worker`, then start the cron:

```bash
pm2 start ecosystem.config.js --only mine-loanwords --update-env && pm2 save
```

---

## Self-Review notes
- **Spec coverage:** store (T4), runtime merge (T1), server loader+worker (T4/T5), client delivery (T6/T7), cron (T8/T9), wordlist vendor (T3), reversibility/denylist (T1 denylist + T8 reads denylist into `already`), tests (T1/T2/T4/T10), notify (T8). All covered.
- **Type consistency:** `setDynamicLoanwords(words, denylist)`, `getActiveLoanwords()`, `LoanwordStore{words,denylist,lastRunAt,lastAdded}`, `mineLoanwords(scripts,dict,already,opts)→MineResult[]`, `parseLoanwordStore`/`mergeStore`/`readLoanwordStore`/`writeLoanwordStore`/`refreshDynamicLoanwords`/`startLoanwordRefresh` — used consistently across tasks.
- **Open confirm:** `notifyAdmins` param names (T8 note) — verify against `src/lib/notifications.ts` at implementation time.
