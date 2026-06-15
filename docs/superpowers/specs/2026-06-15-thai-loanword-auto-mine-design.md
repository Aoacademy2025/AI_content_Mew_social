# Design: Daily auto-mining of Thai loanwords (auto-apply live + notify)

**Date:** 2026-06-15 · **Owner:** Mew · **Branch:** `mew/loanword-auto-mine-cron` (builds on #60 merged, #61 list batch)

## Problem
`Intl.Segmenter("th")` mis-splits Thai loanwords in subtitles. #60 added a curated loanword
list (`src/lib/thai-loanwords.ts`); #61 extended it from one day of prod data. But the list
needs ongoing topping-up as new businesses use new loanwords. Mew wants this to happen
automatically each day — detect new mis-split words from real usage and apply them — without
manually pulling data and editing the list, and **without a deploy each time**.

## Goal / Non-goals
- **Goal:** A daily job that mines yesterday's real prod scripts, finds NEW loanwords ICU
  mis-splits, auto-applies them live (server + web client) via a DB store, and notifies an
  admin to review. Reversible.
- **Non-goals (YAGNI):** admin UI for managing the list/denylist (manual SiteConfig edit is
  fine v1); auto-PR folding dynamic words back into the static file; replacing ICU with a
  full dictionary tokenizer (tracked separately as the "permanent fix").

## Safety posture (chosen)
Auto-apply live + notify. Failure mode of a false-add is **low severity** (one extra word
kept whole = at worst a slightly long card) and **reversible** (denylist). Guards: strong
gibberish-fragment filter (0 false positives on 2026-06-15 data), `len≥4`, Thai-only,
dedupe vs static∪dynamic∪denylist, and a **≤25 words/day cap** so a bad-data day can't flood.

## Components

### 1. Store — `SiteConfig["thaiLoanwordsAuto"]` (no schema change)
JSON: `{ words: string[], denylist: string[], lastRunAt: string, lastAdded: string[] }`.
`SiteConfig` is the existing key/value table (same pattern as Stripe config).

### 2. Runtime merge — `src/lib/thai-loanwords.ts` (stays prisma-free / unit-testable)
- Keep `THAI_LOANWORDS` (static seed/baseline).
- Add module-level `let dynamic: Set<string>` + `let denylist: Set<string>` (empty by default).
- `setDynamicLoanwords(words: string[], denylist: string[])` — replaces the dynamic sets.
- `getActiveLoanwords(): string[]` = `(static ∪ dynamic) − denylist`.
- `loanwordSpans()` uses `getActiveLoanwords()` instead of `THAI_LOANWORDS` directly.
- Pure: no I/O. Existing unit tests keep passing (dynamic empty unless a caller sets it).

### 3. Server loader — `src/lib/thai-loanwords-runtime.ts` (prisma, server-only)
- `refreshDynamicLoanwords()` reads `SiteConfig["thaiLoanwordsAuto"]` → `setDynamicLoanwords(...)`.
- Called at **MCP worker startup** (`scripts/mcp-video-worker.ts`) and on a **10-min interval**.
- Fail-open: any error → log + keep current in-memory set (never blocks rendering).

### 4. Web client delivery — `GET /api/thai-loanwords`
- Auth: logged-in user. Returns `{ words, denylist }` = the merged active list.
- Server-side cached (short TTL ~5 min) to avoid per-request DB hits.
- `video-editor/page.tsx` fetches on mount → `setDynamicLoanwords(...)` on the client, before
  any word-mode split. Fail-open: fetch error → client uses static list only.

### 5. Cron — PM2 app `mine-loanwords` + `scripts/cron-mine-loanwords.ts`
- Schedule: daily ~04:10 (after media-cleanup 03:30). `cron_restart` in `ecosystem.config.js`.
- Steps:
  1. Pull scripts from the last ~26h: `VideoJob.inputJson.$.script` + `Video.script` (prisma).
  2. Run the dict-oracle miner (logic shared with `scripts/mine-thai-loanwords.ts`).
  3. Filter candidates: gibberish ICU fragment, `len≥4`, Thai-only, not in static∪dynamic∪denylist.
  4. Cap to ≤25 new words. Append to `SiteConfig.thaiLoanwordsAuto.words`; set `lastRunAt`, `lastAdded`.
  5. If added > 0: create a `Notification` (type `ERROR_SYSTEM`) for each `Role.ADMIN` user with
     the added words, write a `TelemetryEvent`, and log.
- Idempotent: dedupe means re-running the same day adds nothing new.

### 6. Wordlist oracle — vendored `data/words_th.txt`
- Commit a Thai-only filtered PyThaiNLP wordlist (Apache-2.0; attribution in file header / NOTICE).
- Read by the cron only (not imported into the Next.js bundle).

### 7. Reversibility
- Bad auto-add → add the word to `SiteConfig.thaiLoanwordsAuto.denylist` (one-line edit, or a
  small `scripts/loanword-denylist.ts add <word>` helper). Runtime excludes it within ≤10 min
  (server) / next editor load (client); cron never re-adds it.

## Data flow
```
prod scripts ──cron(daily)──> miner+filter ──> SiteConfig.thaiLoanwordsAuto.words
                                                      │
                          ┌───────────────────────────┴───────────────────────┐
              worker startup + 10-min                              GET /api/thai-loanwords (5-min cache)
              refreshDynamicLoanwords()                                         │
                          │                                          editor mount fetch
                  setDynamicLoanwords (server)                  setDynamicLoanwords (client)
                          │                                                     │
                          └──────────────► loanwordSpans()/tokenizeWords() ◄────┘
```

## Error handling
- Loader / API / client fetch: **fail-open** to the static list — subtitles never break on a
  DB/network hiccup.
- Cron: wrap in try/catch; on error log + TelemetryEvent, no partial SiteConfig writes (read,
  compute, single write).

## Testing
- Unit: `getActiveLoanwords` = static∪dynamic−denylist (incl denylist removing a static word);
  `setDynamicLoanwords` idempotence.
- Unit: candidate filter (gibberish, len, dedupe, cap) against a fixture of scripts.
- Existing guards stay green: `verify-thai-wordbreak`, `verify-word-boundaries`,
  `verify-subtitle-garan`, `verify-tts-timing`, `verify-split-snap`.
- Manual: run the cron script once against prod-copy data; confirm SiteConfig + Notification.

## Rollout
1. Merge #61 (list batch) first (this branch builds on it).
2. Ship code (PR) → deploy (`deploy.sh` runs `prisma db push`; no schema change here anyway) →
   restart `ai-content` + `mcp-video-worker`.
3. Start the cron PM2 app: `pm2 start ecosystem.config.js --only mine-loanwords --update-env && pm2 save`
   (deploy.sh does NOT start crons).
4. Seed `SiteConfig.thaiLoanwordsAuto` with `{words:[],denylist:[],...}` (cron creates it if absent).
```
