# LLM Loanword Miner + Admin Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual loanword-seed treadmill with a self-healing loop: an LLM detects mis-split Thai loanwords from real prod scripts (no dictionary dependency), and an admin approves/denies each candidate from a one-click review page before it goes live.

**Architecture:** A daily cron sends recent prod scripts to Gemini and asks for transliterated loanwords that a naive Thai word-segmenter would break. Candidates are validated locally (must actually ICU-mis-split, must be new) and written to a **pending** queue inside the existing `SiteConfig["thaiLoanwordsAuto"]` JSON store — they are NOT auto-applied. An admin reviews the queue at `/admin/loanwords`: Approve moves a word into the live `words` list, Deny moves it into `denylist`. The existing `refreshDynamicLoanwords()` interval (every 10 min) and the editor's `setDynamicLoanwords()` load then pick approved words up automatically, so `tokenizeWords()`/`wordBoundaries()` keep them whole.

**Tech Stack:** Next.js 15 App Router + React 19 + TypeScript, Prisma 6 (SQLite) `SiteConfig`, `@google/genai` via `src/lib/gemini.ts`, PM2 cron (`ecosystem.config.js`), `Intl.Segmenter("th")`. Tests follow the repo's `scripts/verify-*.ts` pattern (plain `tsx` + `assert`, no jest).

## Global Constraints

- **No schema migration.** The pending queue lives in the existing `SiteConfig` JSON blob (key `thaiLoanwordsAuto`), extending `LoanwordStore`. Deploy stays additive (`prisma db push` runs but adds nothing here).
- **Never auto-apply.** Every LLM candidate must pass through human approval. The only writes to the live `words` list come from an admin Approve action.
- **Fail-safe on missing key.** The product is BYOK with no server AI keys (CLAUDE.md). The miner cron reads a dedicated server key `LOANWORD_MINER_GEMINI_KEY`; if it is absent the cron logs and exits 0 (no crash, no partial state).
- **Fail-open validation.** Any parse/LLM error yields an empty candidate list, never a throw that aborts the cron.
- **Admin-only.** All new API routes and the page require `getCurrentUser()` role `ADMIN`, mirroring `src/app/api/admin/updates/route.ts`.
- **Reuse, don't duplicate:** `readLoanwordStore`/`writeLoanwordStore` (`src/lib/thai-loanwords-runtime.ts`), `geminiGenerateText(apiKey, prompt, maxOutputTokens?, temperature?)` (`src/lib/gemini.ts`), `notifyAdmins({ type, title, body })` (`src/lib/notifications.ts`), the `CRON_SECRET` Bearer pattern (`src/app/api/cron/cleanup-videos/route.ts`).
- **Candidate validity rule (verbatim):** a candidate is kept only if it is Thai, length ≥ 3, `Intl.Segmenter("th",{granularity:"word"})` yields ≥ 2 word-like tokens for it (i.e. ICU mis-splits it), and it is not already in `THAI_LOANWORDS ∪ store.words ∪ store.denylist ∪ store.pending`.

---

## File Structure

- **Modify** `src/lib/thai-loanwords-runtime.ts` — extend `LoanwordStore` with `pending`, parse it, add pure helpers `addPending` / `approvePending` / `denyPending`.
- **Create** `src/lib/loanword-llm-miner.ts` — pure, network-free detection logic + an orchestrator that takes an injected LLM caller. One responsibility: turn scripts → validated candidate words.
- **Create** `scripts/cron-llm-loanwords.ts` — the daily job: gather scripts → call Gemini → validate → enqueue pending → notify admins. Mirrors the shape of `scripts/cron-mine-loanwords.ts`.
- **Create** `src/app/api/admin/loanwords/route.ts` — `GET` (list pending/words/denylist) + `POST` (approve/deny one word).
- **Create** `src/app/(dashboard)/admin/loanwords/page.tsx` — server component shell (admin guard) rendering the client island.
- **Create** `src/app/(dashboard)/admin/loanwords/_components/loanword-review.tsx` — client island: list pending candidates with Approve/Deny.
- **Modify** `ecosystem.config.js` — add the `llm-mine-loanwords` cron entry (daily, after the existing dict miner).
- **Modify** `package.json` — add `verify:loanword-pending` and `verify:loanword-miner` scripts.
- **Create** `scripts/verify-loanword-pending.ts`, `scripts/verify-loanword-miner.ts` — verify scripts (team test pattern).

---

### Task 1: Pending-queue store helpers

**Files:**
- Modify: `src/lib/thai-loanwords-runtime.ts:5` (interface) and `:8-19` (`parseLoanwordStore`); append new pure helpers at end of file.
- Test: `scripts/verify-loanword-pending.ts`

**Interfaces:**
- Consumes: existing `LoanwordStore`, `parseLoanwordStore`.
- Produces:
  - `interface PendingCandidate { word: string; samples: string[]; count: number; source: "llm"; detectedAt: string }`
  - `LoanwordStore` gains `pending?: PendingCandidate[]`
  - `addPending(store: LoanwordStore, cands: PendingCandidate[]): LoanwordStore` — appends candidates whose `word` is not already in `words`, `denylist`, or existing `pending`; dedups by `word`.
  - `approvePending(store: LoanwordStore, word: string): LoanwordStore` — removes `word` from `pending`, adds to `words` (dedup).
  - `denyPending(store: LoanwordStore, word: string): LoanwordStore` — removes `word` from `pending`, adds to `denylist` (dedup).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-loanword-pending.ts`:

```ts
//   npx tsx scripts/verify-loanword-pending.ts
import { parseLoanwordStore, addPending, approvePending, denyPending, type PendingCandidate } from "../src/lib/thai-loanwords-runtime";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const cand = (word: string): PendingCandidate => ({ word, samples: ["ตัวอย่าง " + word], count: 2, source: "llm", detectedAt: "2026-06-19T00:00:00Z" });

// parse round-trips pending
const parsed = parseLoanwordStore(JSON.stringify({ words: ["ก"], denylist: [], pending: [cand("แคปชัน")] }));
assert(parsed.pending?.length === 1 && parsed.pending[0].word === "แคปชัน", "parses pending array");
assert(parseLoanwordStore(JSON.stringify({ words: [] })).pending === undefined || parseLoanwordStore("{}").pending?.length === 0 || true, "missing pending → safe");

// addPending skips already-known words, dedups
let s = { words: ["มี"], denylist: ["ห้าม"], pending: [cand("แคปชัน")] };
s = addPending(s, [cand("แคปชัน"), cand("มี"), cand("ห้าม"), cand("คริปโต")]);
assert(s.pending!.map(p => p.word).sort().join(",") === "คริปโต,แคปชัน", "addPending adds only new (skips words/denylist/dup pending)");

// approve moves pending → words
s = approvePending(s, "แคปชัน");
assert(s.words.includes("แคปชัน") && !s.pending!.some(p => p.word === "แคปชัน"), "approve moves to words, out of pending");

// deny moves pending → denylist
s = denyPending(s, "คริปโต");
assert(s.denylist.includes("คริปโต") && !s.pending!.some(p => p.word === "คริปโต"), "deny moves to denylist, out of pending");

console.log(`\n${passed} checks passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-loanword-pending.ts`
Expected: FAIL — `addPending`/`approvePending`/`denyPending`/`PendingCandidate` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/thai-loanwords-runtime.ts`, replace the `LoanwordStore` interface (line 5) and `parseLoanwordStore` body, and append the helpers:

```ts
export interface PendingCandidate { word: string; samples: string[]; count: number; source: "llm"; detectedAt: string }
export interface LoanwordStore { words: string[]; denylist: string[]; pending?: PendingCandidate[]; lastRunAt?: string; lastAdded?: string[] }
```

Inside `parseLoanwordStore`, add to the returned object (before the closing `}`):

```ts
      pending: Array.isArray(j.pending)
        ? j.pending.filter((p: unknown): p is PendingCandidate =>
            !!p && typeof (p as PendingCandidate).word === "string")
          .map((p: PendingCandidate) => ({
            word: p.word,
            samples: Array.isArray(p.samples) ? p.samples.filter((x) => typeof x === "string").slice(0, 3) : [],
            count: typeof p.count === "number" ? p.count : 1,
            source: "llm" as const,
            detectedAt: typeof p.detectedAt === "string" ? p.detectedAt : "",
          }))
        : undefined,
```

Append at end of file:

```ts
export function addPending(store: LoanwordStore, cands: PendingCandidate[]): LoanwordStore {
  const blocked = new Set([...store.words, ...store.denylist, ...(store.pending ?? []).map((p) => p.word)]);
  const pending = [...(store.pending ?? [])];
  for (const c of cands) {
    if (blocked.has(c.word)) continue;
    blocked.add(c.word);
    pending.push(c);
  }
  return { ...store, pending };
}

export function approvePending(store: LoanwordStore, word: string): LoanwordStore {
  const words = store.words.includes(word) ? store.words : [...store.words, word];
  return { ...store, words, pending: (store.pending ?? []).filter((p) => p.word !== word) };
}

export function denyPending(store: LoanwordStore, word: string): LoanwordStore {
  const denylist = store.denylist.includes(word) ? store.denylist : [...store.denylist, word];
  return { ...store, denylist, pending: (store.pending ?? []).filter((p) => p.word !== word) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-loanword-pending.ts`
Expected: PASS — `N checks passed`. Then `npx tsc --noEmit --pretty false` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/thai-loanwords-runtime.ts scripts/verify-loanword-pending.ts
git commit -m "feat(loanwords): pending-queue helpers in the SiteConfig store"
```

---

### Task 2: LLM miner module (pure, network-free)

**Files:**
- Create: `src/lib/loanword-llm-miner.ts`
- Test: `scripts/verify-loanword-miner.ts`

**Interfaces:**
- Consumes: `Intl.Segmenter`. No DB, no network.
- Produces:
  - `function buildMinerPrompt(scripts: string[]): string`
  - `function parseMinerResponse(raw: string): string[]` — extracts a JSON array of strings from the model text, fail-open `[]`.
  - `function icuMisSplits(word: string): boolean` — true if `Intl.Segmenter("th","word")` yields ≥ 2 word-like tokens.
  - `function validateCandidates(words: string[], covered: Set<string>): string[]` — applies the Global Constraints "Candidate validity rule".
  - `async function mineWithLlm(scripts: string[], covered: Set<string>, callLlm: (prompt: string) => Promise<string>): Promise<string[]>` — orchestrates build → call → parse → validate; returns validated words.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-loanword-miner.ts`:

```ts
//   npx tsx scripts/verify-loanword-miner.ts
import { buildMinerPrompt, parseMinerResponse, icuMisSplits, validateCandidates, mineWithLlm } from "../src/lib/loanword-llm-miner";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

assert(buildMinerPrompt(["สวัสดีครับ"]).includes("สวัสดีครับ"), "prompt embeds the scripts");

assert(JSON.stringify(parseMinerResponse('```json\n["แคปชัน","คริปโต"]\n```')) === '["แคปชัน","คริปโต"]', "parses fenced JSON array");
assert(parseMinerResponse("not json at all").length === 0, "bad output → [] (fail-open)");

assert(icuMisSplits("แคปชัน") === true, "ICU mis-splits แคปชัน");
assert(icuMisSplits("กิน") === false, "single real word not flagged");

const covered = new Set(["คริปโต"]);
const v = validateCandidates(["แคปชัน", "คริปโต", "กิน", "AI", "ก"], covered);
assert(v.length === 1 && v[0] === "แคปชัน", "validate keeps only new Thai ICU-mis-splits ≥3 chars");

(async () => {
  const fakeLlm = async () => '["แคปชัน","กิน","คริปโต"]';
  const got = await mineWithLlm(["บางสคริปต์"], new Set(["คริปโต"]), fakeLlm);
  assert(got.length === 1 && got[0] === "แคปชัน", "mineWithLlm end-to-end with injected LLM");
  const errLlm = async () => { throw new Error("boom"); };
  assert((await mineWithLlm(["x"], new Set(), errLlm)).length === 0, "LLM throw → [] (fail-open)");
  console.log(`\n${passed} checks passed`);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/verify-loanword-miner.ts`
Expected: FAIL — module `src/lib/loanword-llm-miner.ts` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/loanword-llm-miner.ts`:

```ts
// LLM-based Thai loanword detector. Unlike the dictionary-oracle miner
// (loanword-mining.ts), this does NOT require the word to exist in any dict —
// the LLM proposes transliterations a naive Thai segmenter would break, and we
// keep only the ones that actually ICU-mis-split and are still unknown. Pure +
// network-free except mineWithLlm, which takes an injected LLM caller.

const seg = new Intl.Segmenter("th", { granularity: "word" });
const isThai = (s: string) => /[฀-๿]/.test(s);

export function icuMisSplits(word: string): boolean {
  const tokens = [...seg.segment(word)].filter((t) => (t as { isWordLike?: boolean }).isWordLike);
  return tokens.length >= 2;
}

export function buildMinerPrompt(scripts: string[]): string {
  const corpus = scripts.join("\n---\n").slice(0, 24000);
  return [
    "You are a Thai NLP assistant. Below are Thai short-video scripts.",
    "List every Thai *transliterated loanword* (foreign word written in Thai script:",
    "brand names, tech/business/medical/beauty/finance terms, etc.) that a naive Thai",
    "word segmenter would likely split mid-word. Return ONLY a JSON array of strings,",
    "each the FULL loanword as written, no fragments, no native Thai words, no English.",
    "Example: [\"แคปชัน\",\"คริปโต\",\"เดลิเวอรี\"]",
    "",
    "SCRIPTS:",
    corpus,
  ].join("\n");
}

export function parseMinerResponse(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function validateCandidates(words: string[], covered: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w) || covered.has(w)) continue;
    if (!isThai(w) || w.length < 3) continue;
    if (!icuMisSplits(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export async function mineWithLlm(
  scripts: string[],
  covered: Set<string>,
  callLlm: (prompt: string) => Promise<string>,
): Promise<string[]> {
  if (scripts.length === 0) return [];
  try {
    const raw = await callLlm(buildMinerPrompt(scripts));
    return validateCandidates(parseMinerResponse(raw), covered);
  } catch (e) {
    console.warn("[llm-loanwords] mine failed (fail-open):", e instanceof Error ? e.message : e);
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/verify-loanword-miner.ts`
Expected: PASS — `N checks passed`. Then `npx tsc --noEmit --pretty false` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loanword-llm-miner.ts scripts/verify-loanword-miner.ts
git commit -m "feat(loanwords): LLM miner module (dict-independent, injectable LLM)"
```

---

### Task 3: Daily cron job

**Files:**
- Create: `scripts/cron-llm-loanwords.ts`
- Modify: `ecosystem.config.js` (add cron entry after `mine-loanwords`)
- Modify: `package.json` (add the two verify scripts to `scripts`)

**Interfaces:**
- Consumes: `readLoanwordStore`, `writeLoanwordStore`, `addPending`, `PendingCandidate` (Task 1); `mineWithLlm` (Task 2); `geminiGenerateText` (`src/lib/gemini.ts`); `notifyAdmins` (`src/lib/notifications.ts`); `THAI_LOANWORDS` (`src/lib/thai-loanwords.ts`); `prisma`.
- Produces: a runnable cron; no exported symbols.

- [ ] **Step 1: Write the cron script**

Create `scripts/cron-llm-loanwords.ts`:

```ts
// Daily: ask Gemini for transliterated loanwords ICU mis-splits in the last ~26h
// of prod scripts, enqueue NEW ones to the pending review queue (NOT auto-applied),
// notify admins. No-ops if LOANWORD_MINER_GEMINI_KEY is unset (BYOK = no server key).
//   DATABASE_URL=... LOANWORD_MINER_GEMINI_KEY=... npx tsx scripts/cron-llm-loanwords.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
import { readLoanwordStore, writeLoanwordStore, addPending, type PendingCandidate } from "../src/lib/thai-loanwords-runtime";
import { mineWithLlm } from "../src/lib/loanword-llm-miner";
import { geminiGenerateText } from "../src/lib/gemini";
import { notifyAdmins } from "../src/lib/notifications";

const LOOKBACK_MS = 26 * 60 * 60 * 1000;

async function main() {
  const key = process.env.LOANWORD_MINER_GEMINI_KEY;
  if (!key) { console.log("[llm-loanwords] LOANWORD_MINER_GEMINI_KEY unset — skipping"); return; }

  const since = new Date(Date.now() - LOOKBACK_MS);
  const jobs = await prisma.videoJob.findMany({ where: { createdAt: { gte: since } }, select: { inputJson: true } });
  const vids = await prisma.video.findMany({ where: { createdAt: { gte: since }, script: { not: null } }, select: { script: true } });
  const scripts: string[] = [];
  for (const j of jobs) { try { const s = JSON.parse(j.inputJson)?.script; if (typeof s === "string" && s.trim()) scripts.push(s); } catch { /* skip */ } }
  for (const v of vids) { if (typeof v.script === "string" && v.script.trim()) scripts.push(v.script); }

  const store = await readLoanwordStore();
  const covered = new Set([...THAI_LOANWORDS, ...store.words, ...store.denylist, ...(store.pending ?? []).map((p) => p.word)]);
  const words = await mineWithLlm(scripts, covered, (prompt) => geminiGenerateText(key, prompt, 2048, 0));

  const now = new Date().toISOString();
  const cands: PendingCandidate[] = words.map((w) => {
    const hit = scripts.filter((s) => s.includes(w));
    const sample = hit[0] ? hit[0].slice(Math.max(0, hit[0].indexOf(w) - 12), hit[0].indexOf(w) + w.length + 12).replace(/\s+/g, " ") : "";
    return { word: w, samples: sample ? [sample] : [], count: hit.length, source: "llm", detectedAt: now };
  });

  const next = addPending({ ...store, lastRunAt: now }, cands);
  await writeLoanwordStore(next);

  const added = (next.pending ?? []).length - (store.pending ?? []).length;
  console.log(`[llm-loanwords] scripts=${scripts.length} proposed=${words.length} enqueued=${added} ${words.join(",")}`);
  await prisma.telemetryEvent.create({ data: { name: "loanwords.llm_mined", category: "pipeline", source: "server", value: added, properties: JSON.stringify({ proposed: words, scripts: scripts.length }) } });
  if (added > 0) {
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `คำตัดซับรออนุมัติ ${added} คำ`,
      body: `LLM เจอคำทับศัพท์ที่อาจถูกตัดผิด ${added} คำ รอรีวิวที่ /admin/loanwords: ${words.join(", ")}`,
    });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("[llm-loanwords] failed:", e); process.exit(1); });
```

- [ ] **Step 2: Add the ecosystem cron entry**

In `ecosystem.config.js`, immediately after the `mine-loanwords` app object (ends near line 87, `},`), insert:

```js
    {
      name: "llm-mine-loanwords",
      cwd: "/var/www/ai-content",
      script: "node_modules/.bin/tsx",
      args: "scripts/cron-llm-loanwords.ts",
      cron_restart: "40 4 * * *", // daily 4:40 AM — LLM proposes loanwords → pending queue (admin approves)
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
```

- [ ] **Step 3: Add verify scripts to package.json**

In `package.json` `scripts`, after `"verify:clip-charge"`, add:

```json
    "verify:loanword-pending": "tsx scripts/verify-loanword-pending.ts",
    "verify:loanword-miner": "tsx scripts/verify-loanword-miner.ts"
```

(Add a trailing comma to the preceding line.)

- [ ] **Step 4: Verify it compiles and dry-runs without a key**

Run: `npx tsc --noEmit --pretty false` → no new errors.
Run: `DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/cron-llm-loanwords.ts`
Expected: prints `[llm-loanwords] LOANWORD_MINER_GEMINI_KEY unset — skipping` and exits 0 (fail-safe path).

- [ ] **Step 5: Commit**

```bash
git add scripts/cron-llm-loanwords.ts ecosystem.config.js package.json
git commit -m "feat(loanwords): daily LLM miner cron → pending queue (no-op without key)"
```

---

### Task 4: Admin API (list + approve/deny)

**Files:**
- Create: `src/app/api/admin/loanwords/route.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (`@/lib/clerk-auth`), `apiError` (`@/lib/api-error`), `readLoanwordStore`/`writeLoanwordStore`/`approvePending`/`denyPending` (Task 1).
- Produces:
  - `GET /api/admin/loanwords` → `{ pending: PendingCandidate[], words: string[], denylist: string[] }`
  - `POST /api/admin/loanwords` body `{ word: string, action: "approve" | "deny" }` → `{ ok: true, pending, words, denylist }`; 400 on bad body.

- [ ] **Step 1: Write the route**

Create `src/app/api/admin/loanwords/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { readLoanwordStore, writeLoanwordStore, approvePending, denyPending } from "@/lib/thai-loanwords-runtime";

export const runtime = "nodejs";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

export async function GET() {
  try {
    const { error } = await requireAdmin();
    if (error) return error;
    const s = await readLoanwordStore();
    return NextResponse.json({ pending: s.pending ?? [], words: s.words, denylist: s.denylist });
  } catch (error) { return apiError({ route: "GET /api/admin/loanwords", error }); }
}

export async function POST(req: Request) {
  try {
    const { error } = await requireAdmin();
    if (error) return error;
    const body = await req.json().catch(() => null);
    const word = typeof body?.word === "string" ? body.word : "";
    const action = body?.action;
    if (!word || (action !== "approve" && action !== "deny")) {
      return NextResponse.json({ error: "word and action ('approve'|'deny') required" }, { status: 400 });
    }
    const s = await readLoanwordStore();
    const next = action === "approve" ? approvePending(s, word) : denyPending(s, word);
    await writeLoanwordStore(next);
    return NextResponse.json({ ok: true, pending: next.pending ?? [], words: next.words, denylist: next.denylist });
  } catch (error) { return apiError({ route: "POST /api/admin/loanwords", error }); }
}
```

- [ ] **Step 2: Verify auth + shape against the dev DB**

Run: `npx tsc --noEmit --pretty false` → no new errors.
Manual check (dev server running): `curl -s localhost:3000/api/admin/loanwords` → `{"error":"Unauthorized"}` with 401 (admin guard active; same as other admin routes when unauthenticated).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/loanwords/route.ts
git commit -m "feat(loanwords): admin API to list + approve/deny pending candidates"
```

---

### Task 5: Admin review page

**Files:**
- Create: `src/app/(dashboard)/admin/loanwords/page.tsx`
- Create: `src/app/(dashboard)/admin/loanwords/_components/loanword-review.tsx`

**Interfaces:**
- Consumes: `GET`/`POST /api/admin/loanwords` (Task 4).
- Produces: a page at `/admin/loanwords`.

- [ ] **Step 1: Write the server shell (admin guard)**

Create `src/app/(dashboard)/admin/loanwords/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { LoanwordReview } from "./_components/loanword-review";

export const dynamic = "force-dynamic";

export default async function LoanwordsAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/dashboard");
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold mb-1">คำตัดซับ (Loanwords) — รออนุมัติ</h1>
      <p className="text-sm text-muted-foreground mb-4">LLM เสนอคำทับศัพท์ที่อาจถูกตัดผิด — กดอนุมัติเพื่อให้ระบบกันคำนั้นไว้ทั้งคำ หรือปฏิเสธเพื่อใส่ denylist</p>
      <LoanwordReview />
    </div>
  );
}
```

- [ ] **Step 2: Write the client island**

Create `src/app/(dashboard)/admin/loanwords/_components/loanword-review.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

interface Pending { word: string; samples: string[]; count: number; detectedAt: string }
interface Data { pending: Pending[]; words: string[]; denylist: string[] }

export function LoanwordReview() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/admin/loanwords");
      if (!r.ok) throw new Error(String(r.status));
      setData(await r.json());
    } catch (e) { setErr("โหลดไม่สำเร็จ: " + (e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { void load(); }, []);

  async function act(word: string, action: "approve" | "deny") {
    setBusy(word);
    try {
      const r = await fetch("/api/admin/loanwords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ word, action }) });
      if (!r.ok) throw new Error(String(r.status));
      setData(await r.json());
    } catch (e) { setErr("บันทึกไม่สำเร็จ: " + (e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  if (err) return <p className="text-sm text-red-500">{err}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">กำลังโหลด…</p>;
  if (data.pending.length === 0) return <p className="text-sm text-muted-foreground">ไม่มีคำรออนุมัติ ✓ (live {data.words.length} คำ · denylist {data.denylist.length})</p>;

  return (
    <ul className="space-y-2">
      {data.pending.map((p) => (
        <li key={p.word} className="flex items-center justify-between rounded-md border p-3">
          <div className="min-w-0">
            <div className="font-medium">{p.word} <span className="text-xs text-muted-foreground">×{p.count}</span></div>
            {p.samples[0] && <div className="truncate text-xs text-muted-foreground">…{p.samples[0]}…</div>}
          </div>
          <div className="flex gap-2 shrink-0">
            <button disabled={busy === p.word} onClick={() => act(p.word, "approve")} className="rounded bg-green-600 px-3 py-1 text-sm text-white disabled:opacity-50">อนุมัติ</button>
            <button disabled={busy === p.word} onClick={() => act(p.word, "deny")} className="rounded bg-zinc-200 px-3 py-1 text-sm disabled:opacity-50">ปฏิเสธ</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit --pretty false` → no new errors.
Run: `npm run build` (or visit `/admin/loanwords` on the dev server as an admin) → page renders, shows "ไม่มีคำรออนุมัติ" against an empty queue.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/admin/loanwords/page.tsx" "src/app/(dashboard)/admin/loanwords/_components/loanword-review.tsx"
git commit -m "feat(loanwords): /admin/loanwords review page (approve/deny pending)"
```

---

### Task 6: End-to-end wiring check + deploy notes

**Files:**
- Modify: `docs/superpowers/plans/2026-06-19-llm-loanword-miner.md` (append the deploy checklist below — or move to STATUS.md per team convention)

**Interfaces:** none (verification + docs only).

- [ ] **Step 1: Confirm the live-application path already exists (no code needed)**

Read `src/lib/thai-loanwords-runtime.ts:38-49` (`refreshDynamicLoanwords` + `startLoanwordRefresh`) and `src/app/(dashboard)/video-editor/page.tsx:384` (`setDynamicLoanwords`). Confirm an approved word reaches `getActiveLoanwords()` via the existing 10-min refresh / editor load — no new wiring required. Note the finding in the commit message.

- [ ] **Step 2: Full local gate**

Run, expecting all green:
```bash
npx tsx scripts/verify-loanword-pending.ts
npx tsx scripts/verify-loanword-miner.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 3: Record deploy steps**

Deploy checklist (verbatim for the deployer):
1. Set the server key in prod `.env`: `LOANWORD_MINER_GEMINI_KEY=<a Gemini key owned by the company, not a customer's>`.
2. `bash deploy/deploy.sh` (additive; no schema change — `pending` is JSON in `SiteConfig`).
3. Start the new cron once: `export CRON_SECRET="$(grep ^CRON_SECRET= .env | cut -d= -f2-)"; pm2 start ecosystem.config.js --only llm-mine-loanwords --update-env && pm2 save`.
4. Smoke: `DATABASE_URL=... LOANWORD_MINER_GEMINI_KEY=... npx tsx scripts/cron-llm-loanwords.ts` on prod → expect `enqueued=N`, then open `/admin/loanwords` and confirm the queue lists them.
5. Approve one, wait ≤10 min (or restart `ai-content`), re-gen a clip containing that word in word-count mode → confirm it stays whole.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-19-llm-loanword-miner.md
git commit -m "docs(loanwords): deploy checklist for LLM miner + approval queue"
```

---

## Self-Review

**Spec coverage:**
- LLM detection (dict-independent) → Task 2 (`mineWithLlm`) + Task 3 (cron wires Gemini).
- Admin approval queue (no auto-apply) → Task 1 (pending store), Task 4 (API), Task 5 (page). Global Constraint "Never auto-apply" enforced: the cron only calls `addPending`; the live `words` list is only written by `approvePending` via the admin POST.
- Reuse existing infra → readLoanwordStore/writeLoanwordStore, geminiGenerateText, notifyAdmins, refreshDynamicLoanwords (Task 6 confirms the load path), denylist (Task 1 `denyPending`).
- BYOK / no server key → Global Constraint + Task 3 Step 1 (`if (!key) … return`) + Task 3 Step 4 verifies the no-op path.
- Fail-open → `mineWithLlm` try/catch (Task 2) + `parseMinerResponse` returns `[]`.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type consistency:** `PendingCandidate` shape (`word/samples/count/source/detectedAt`) is identical across Task 1 (definition), Task 3 (construction), Task 4 (return), Task 5 (`Pending` interface mirrors it). `addPending`/`approvePending`/`denyPending` signatures match between Task 1, Task 3, and Task 4. `mineWithLlm(scripts, covered, callLlm)` matches between Task 2 and Task 3. ✓

**Out of scope (intentional, YAGNI):** frequency-based detector as a second source (the noisy heuristic miner) — `source` is already an enum-friendly string field so it can be added later without a schema change; dictionary expansion (the quick-win `data/words_th.txt` augmentation) is a separate, independent effort.
