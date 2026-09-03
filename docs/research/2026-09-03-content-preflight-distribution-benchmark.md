# Content Preflight distribution benchmark — 2026-09-03

**Status: COMPLETE — 20/20 fixtures analyzed across two runs, 0 failed calls.**
Gate 1 PASS (5/20 = 25% <= 40%). Gate 2 PASS (9/9). All 20 real paid Gemini calls made
today, no fixture re-billed.

- Date: 2026-09-03
- Commit at run time: `70cac1d2` (branch `mew/brands-wave1-t8b`); this doc plus two
  script fix-ups land as commits on top of it (see "Commits" below).
- Worktree: `AI_content_Mew_social-brands-wave1-c`
- Script: `scripts/benchmark-content-preflight-distribution.ts`
- Fixtures: `scripts/fixtures/content-preflight-distribution.json` (20 entries)

## How this run happened (two invocation fixes, two paid runs)

**Attempt 1 — BLOCKED, 0 calls.** The script's documented `npx tsx
scripts/benchmark-content-preflight-distribution.ts` invocation crashed on import
before any provider call: `runPaid()` dynamically imports
`src/lib/content-preflight.server.ts` → `src/lib/project-visual-assets.server.ts`,
which starts with `import "server-only"`. That marker package throws unless Node runs
with the `react-server` conditional-exports condition — the pattern every other
`server-only`-touching script in this repo already uses (`benchmark:brand-treatment-v1`
etc.). Fixed by adding an npm script,
`"benchmark:content-preflight-distribution": "node --conditions=react-server --import tsx scripts/benchmark-content-preflight-distribution.ts"`,
and updating the script header to document it.

**Attempt 2 — 14/20 completed, then stopped.** Real run (18:xx local) under the fixed
invocation made 14 successful, error-free Gemini calls (`ghost-01..03`,
`history-01..03`, `drama-01..03`, `news-01..03`, `finance-01`, `finance-02`) before the
operator's shell command hit its own 2-minute timeout and the process was killed
(SIGTERM, exit 143) mid-loop — not an application or analyzer failure; every fixture
that ran returned a real result. Per "if it crashes mid-loop, report how many calls
completed and stop," this was not retried as a full run. The `finally` block's DB
cleanup (a `mkdtemp` throwaway SQLite holding the benchmark key as reversible base64 —
`KEY_ENC_SECRET` isn't set locally) did not run because SIGTERM bypasses Node's
try/finally; the leftover `content-preflight-distribution-<random>/benchmark.db` was
found under the OS tmp dir and deleted by hand immediately afterward.

**Attempt 3 — the missing 6, completed.** Added a `--only <id,id,...>` CLI option to
the script (comma-separated fixture ids; loads and catalog-validates the full 20-entry
fixture file as before, then narrows the analyzed set and all summary/gate messaging to
the requested subset, and labels the output as a subset). Ran the paid subset once —
`--only finance-03,health-01,health-02,product-01,product-02,product-03` — with a
10-minute Bash timeout this time (observed pace ~1s/call for this batch; the run
finished well inside it and exited cleanly, so no leftover temp DB this time). All 6
completed with real results and 0 errors.

Total real paid Gemini calls today: **14 + 6 = 20**, one call per fixture, none
duplicated.

## Step 1 — dry run (after both fixes)

```
npm run benchmark:content-preflight-distribution -- --dry-run
npm run benchmark:content-preflight-distribution -- --dry-run --only finance-03
```

**Both PASS.** The full dry run validates all 20 fixtures unchanged (correct category
counts, every `expectedStylePackId` maps to an ACTIVE Style Pack paired with the
matching treatment preset). The `--only finance-03` dry run lists exactly the one
requested fixture (`"fixtures": 1`, `"totalFixtures": 20`, `"categories": {"finance":
1}`) and labels the gates output `(subset of 1: finance-03)`.

## Step 2 — real (paid) runs

```
CONTENT_PREFLIGHT_BENCHMARK_KEY="$(grep '^GEMINI_SERVER_KEY=' .env | cut -d= -f2- | tr -d '"')" \
  npm run benchmark:content-preflight-distribution 2>&1 | tee /tmp/preflight-benchmark.log
```
→ 14/20, stopped (attempt 2, above).

```
CONTENT_PREFLIGHT_BENCHMARK_KEY="$(grep '^GEMINI_SERVER_KEY=' .env | cut -d= -f2- | tr -d '"')" \
  npm run benchmark:content-preflight-distribution -- --only finance-03,health-01,health-02,product-01,product-02,product-03 \
  2>&1 | tee /tmp/preflight-benchmark-2.log
```
→ 6/6, completed. Script's own summary for this subset:

```
First-ranked treatment distribution (subset of 6: finance-03, health-01, health-02, product-01, product-02, product-03):
  expert-clarity                      3  50%
  premium-product-lifestyle           3  50%

Gate 1 expert-clarity first-ranked 50% (<= 40%): FAIL
Gate 2 ghost/history/news matching preset first: PASS

Suggested Style Pack matched the expected pack for 4/6 fixtures.
```

The subset-only "Gate 1 FAIL" line above is expected and not meaningful on its own —
the script computes Gate 1's threshold relative to whatever set it's given, and a
6-fixture slice weighted 3-of-6 toward `expert-clarity` (both `health` fixtures plus one
`finance` fixture legitimately expect `expert-clarity`) will read high in isolation. The
real Gate 1 figure is computed over the full 20 below.

### Failed calls

**0 across both real runs.** All 20 fixtures returned a real, error-free analyzer
result.

## Full 20-fixture results

| id | category | expected preset | first-ranked preset | treatment match | suggested Style Pack | expected Style Pack | pack match |
|---|---|---|---|---|---|---|---|
| ghost-01 | ghost | thai-supernatural-horror | thai-supernatural-horror | yes | not captured¹ | thai-ghost | — |
| ghost-02 | ghost | thai-supernatural-horror | thai-supernatural-horror | yes | not captured¹ | thai-ghost | — |
| ghost-03 | ghost | thai-supernatural-horror | thai-supernatural-horror | yes | not captured¹ | thai-ghost | — |
| history-01 | history | thai-history-period-storytelling | thai-history-period-storytelling | yes | not captured¹ | thai-history | — |
| history-02 | history | thai-history-period-storytelling | thai-history-period-storytelling | yes | not captured¹ | thai-history | — |
| history-03 | history | thai-history-period-storytelling | thai-history-period-storytelling | yes | not captured¹ | thai-history | — |
| drama-01 | drama | thai-human-drama | thai-human-drama | yes | not captured¹ | life-drama | — |
| drama-02 | drama | thai-human-drama | thai-human-drama | yes | not captured¹ | life-drama | — |
| drama-03 | drama | thai-human-drama | thai-human-drama | yes | not captured¹ | life-drama | — |
| news-01 | news | investigative-news-crime | investigative-news-crime | yes | not captured¹ | news-fast | — |
| news-02 | news | investigative-news-crime | investigative-news-crime | yes | not captured¹ | news-fast | — |
| news-03 | news | investigative-news-crime | investigative-news-crime | yes | not captured¹ | news-fast | — |
| finance-01 | finance | expert-clarity | expert-clarity | yes | not captured¹ | finance-clear | — |
| finance-02 | finance | expert-clarity | expert-clarity | yes | not captured¹ | finance-clear | — |
| finance-03 | finance | expert-clarity | expert-clarity | yes | finance-clear | finance-clear | yes |
| health-01 | health | expert-clarity | expert-clarity | yes | finance-clear | health-simple | **no** |
| health-02 | health | expert-clarity | expert-clarity | yes | finance-clear | health-simple | **no** |
| product-01 | product | premium-product-lifestyle | premium-product-lifestyle | yes | premium-product | premium-product | yes |
| product-02 | product | premium-product-lifestyle | premium-product-lifestyle | yes | premium-product | premium-product | yes |
| product-03 | product | premium-product-lifestyle | premium-product-lifestyle | yes | premium-product | premium-product | yes |

¹ `suggestedStylePackId` for the first 14 fixtures was not captured: the script only
writes `results.json` (which carries `suggestedStylePackId` per outcome) after its
fixture loop finishes, and attempt 2's process was killed mid-loop before reaching that
point — only the console line (`id` + first-ranked treatment) survived, via `tee`. This
data is genuinely gone; re-running those 14 to recover it would re-bill them, which is
out of scope for this task. Style Pack match rate below is reported only over the 6
fixtures where the data exists.

**Treatment match: 20/20 (100%).** Every fixture — not just the 9 gated ones — ranked
its expected treatment preset first.

**Style Pack match (where captured): 4/6.** Both `health` fixtures resolved to
`finance-clear` instead of the expected `health-simple`, even though their treatment
(`expert-clarity`) was correct — see "Reading" below.

### First-ranked treatment distribution (all 20)

| preset | count | share of 20 |
|---|---|---|
| thai-supernatural-horror | 3 | 15% |
| thai-history-period-storytelling | 3 | 15% |
| thai-human-drama | 3 | 15% |
| investigative-news-crime | 3 | 15% |
| premium-product-lifestyle | 3 | 15% |
| expert-clarity | 5 | 25% |

## Gates (final, over all 20)

**Gate 1 — `expert-clarity` first-ranked <= 40% of 20: PASS, 25%.** `expert-clarity`
was first-ranked for 5/20 fixtures (`finance-01`, `finance-02`, `finance-03`,
`health-01`, `health-02`) — all five are fixtures whose fixture-file *expected* preset
is itself `expert-clarity`, i.e. the analyzer is not over-firing it onto content that
should land elsewhere. 25% is comfortably under the 40% cap.

**Gate 2 — ghost/history/news matching preset first: PASS, 9/9.** All 9 must-match
fixtures (`ghost-01..03`, `history-01..03`, `news-01..03`) ranked their expected preset
first.

## Cleanup

- Attempt 2's leftover throwaway DB directory was found and deleted by hand (see above).
- Attempt 3 exited normally; no leftover temp DB.
- `artifacts/content-preflight-distribution/results.json` exists locally from attempt 3
  (6-fixture subset only) but is git-ignored and was not committed — confirmed via
  `git status --short` before each commit in this task.

## Commits

- `8b553de1` — first (BLOCKED) attempt doc, superseded by this rewrite.
- `4a82d612` — invocation fix (`benchmark:content-preflight-distribution` npm script +
  script header) + doc rewritten with the 14/20 partial results.
- This commit — `--only` CLI option added to the script, doc rewritten with the
  complete 20/20 results merging both real runs.

## Reading

With all 20 fixtures now measured, the "monoculture" this benchmark exists to catch —
`expert-clarity` dominating regardless of genre — is not present: it is first-ranked
only for the 5 fixtures that are actually finance/health content with no strong genre
signal, exactly the "neutral last resort" behavior the ranking rule is designed to
produce, and every genre-coded category (ghost, history, drama, news, product) picked
its own distinct, correct preset 100% of the time. The one soft spot the data does show
is at the Style Pack layer, not the treatment layer: both `health` fixtures correctly
chose the `expert-clarity` treatment but then resolved to the `finance-clear` Style
Pack instead of `health-simple` — `stylePackForRecommendation` appears to be picking the
first/only active pack for a given treatment+format combination without a
category-aware tiebreak between `finance-clear` and `health-simple`, which likely both
pair `expert-clarity` with the same `suggestedVisualFormatId` (`clear-infographic`).
That's a distinct, narrower finding from what this benchmark's two gates measure (they
only look at the first-ranked *treatment*, not the suggested *Style Pack*) and is worth
a follow-up ticket on `stylePackForRecommendation`'s tiebreak logic, but it does not
affect either gate result: both Gate 1 and Gate 2 pass on the treatment data actually
being tested.
