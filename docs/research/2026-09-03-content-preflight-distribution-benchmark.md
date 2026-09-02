# Content Preflight distribution benchmark — 2026-09-03

**Status: PARTIAL REAL RUN — 14/20 fixtures analyzed, 0 failed calls, then stopped.**
The invocation bug from the first attempt is fixed (see "Invocation fix" below) and the
dry run now passes through the same `npm run benchmark:content-preflight-distribution`
path. The real run made 14 successful paid Gemini calls before the surrounding shell
command hit its own timeout (unrelated to the script or the analyzer) and the process
was terminated mid-loop. Per the "if it crashes mid-loop, report how many calls
completed and stop" instruction, this run was not retried — retrying would re-bill the
14 fixtures that already completed. The 6 remaining fixtures (`finance-03`,
`health-01`, `health-02`, `product-01`, `product-02`, `product-03`) still need a
follow-up paid run.

- Date: 2026-09-03
- Commit at run time: `70cac1d2` (branch `mew/brands-wave1-t8b`); this doc + the
  invocation fix land as a follow-up commit on top of it.
- Worktree: `AI_content_Mew_social-brands-wave1-c`
- Script: `scripts/benchmark-content-preflight-distribution.ts`
- Fixtures: `scripts/fixtures/content-preflight-distribution.json` (20 entries)

## Invocation fix

The first attempt (documented in an earlier version of this doc, superseded here)
crashed on import before any provider call: `runPaid()` dynamically imports
`src/lib/content-preflight.server.ts` → `src/lib/project-visual-assets.server.ts`,
which starts with `import "server-only"`. That marker package throws unless Node is
run with the `react-server` conditional-exports condition — the pattern every other
`server-only`-touching script in this repo already uses (`benchmark:brand-treatment-v1`
etc.).

Fix applied (no other code change):
- `package.json`: added
  `"benchmark:content-preflight-distribution": "node --conditions=react-server --import tsx scripts/benchmark-content-preflight-distribution.ts"`
  next to `benchmark:brand-treatment-v1`.
- `scripts/benchmark-content-preflight-distribution.ts` header (lines ~15–16): now
  documents `npm run benchmark:content-preflight-distribution -- --dry-run` and
  `CONTENT_PREFLIGHT_BENCHMARK_KEY=... npm run benchmark:content-preflight-distribution`.

## Step 1 — dry run

```
npm run benchmark:content-preflight-distribution -- --dry-run
```

**PASS.** Same fixture validation as before (20 fixtures, correct category counts,
every `expectedStylePackId` maps to an ACTIVE Style Pack paired with the matching
treatment preset), now running through the fixed invocation without crashing.

Gates as printed:
1. `expert-clarity` first-ranked <= 40% (max 8 of 20 fixtures)
2. every ghost/history/news fixture ranks its matching preset first (9 fixtures)

## Step 2 — real (paid) run

```
CONTENT_PREFLIGHT_BENCHMARK_KEY="$(grep '^GEMINI_SERVER_KEY=' .env | cut -d= -f2- | tr -d '"')" \
  npm run benchmark:content-preflight-distribution 2>&1 | tee /tmp/preflight-benchmark.log
```

The `[key-crypto] WARNING: KEY_ENC_SECRET is NOT set` banner is the script's throwaway
benchmark DB storing the BYOK key as reversible base64 rather than AES-256-GCM (expected
for a `mkdtemp`-scoped SQLite file that gets deleted after the run) — not a leak in
itself, but see "Cleanup" below for what happened when the process was killed before
its own cleanup ran.

14 of 20 fixtures completed with a real, successful analyzer call before the operator's
shell command exceeded its own 2-minute timeout and the process received SIGTERM
(exit 143). This is **not** an application or analyzer failure — every fixture that ran
returned a real ranked-treatment result, no errors, no timeouts inside the analyzer
itself. It is a mismatch between how long ~20 sequential live Gemini calls actually take
(~8–9s/call observed) and the 2-minute default the run was launched with.

### Fixtures completed (real analyzer output, in order)

| id | category | expected preset | first-ranked preset | match |
|---|---|---|---|---|
| ghost-01 | ghost | thai-supernatural-horror | thai-supernatural-horror | yes |
| ghost-02 | ghost | thai-supernatural-horror | thai-supernatural-horror | yes |
| ghost-03 | ghost | thai-supernatural-horror | thai-supernatural-horror | yes |
| history-01 | history | thai-history-period-storytelling | thai-history-period-storytelling | yes |
| history-02 | history | thai-history-period-storytelling | thai-history-period-storytelling | yes |
| history-03 | history | thai-history-period-storytelling | thai-history-period-storytelling | yes |
| drama-01 | drama | thai-human-drama | thai-human-drama | yes |
| drama-02 | drama | thai-human-drama | thai-human-drama | yes |
| drama-03 | drama | thai-human-drama | thai-human-drama | yes |
| news-01 | news | investigative-news-crime | investigative-news-crime | yes |
| news-02 | news | investigative-news-crime | investigative-news-crime | yes |
| news-03 | news | investigative-news-crime | investigative-news-crime | yes |
| finance-01 | finance | expert-clarity | expert-clarity | yes |
| finance-02 | finance | expert-clarity | expert-clarity | yes |

`suggestedStylePackId` is not available for these 14: the script only writes
`artifacts/content-preflight-distribution/results.json` (which carries
`suggestedStylePackId` per outcome) after the full 20-fixture loop finishes. Because the
process was killed mid-loop, no `results.json` was written — `artifacts/` does not
exist on disk after this run. The table above reflects only what was captured on stdout
(`tee /tmp/preflight-benchmark.log`), which prints `id` and first-ranked preset per
fixture as it completes.

### Fixtures NOT attempted (run stopped before reaching them)

`finance-03`, `health-01`, `health-02`, `product-01`, `product-02`, `product-03` — 6
fixtures, 0 calls made against any of them.

### Failed calls

**0.** All 14 completed fixtures returned a real result; none errored.

### Cleanup

The script's `finally` block (`rmSync` on the `mkdtemp` throwaway DB directory holding
the benchmark key) did not run — SIGTERM from outside the process bypasses Node's
try/finally the same way a hard kill would. The leftover directory
(`.../T/content-preflight-distribution-<random>/benchmark.db`, containing the benchmark
key as reversible base64 per the warning above) was found and deleted by hand
immediately after this run, before writing this doc. No other artifact from this run
was left on disk.

## Gates (evaluated against what actually completed)

**Gate 2 — ghost/history/news matching preset first: PASS, 9/9.** All 9 fixtures in the
must-match set (`ghost-01..03`, `history-01..03`, `news-01..03`) completed in this run,
and every one ranked its expected preset first. This gate is fully resolved regardless
of the 6 outstanding fixtures, since none of them belong to the must-match categories.

**Gate 1 — `expert-clarity` first-ranked <= 40% of 20: NOT YET DETERMINED.** Only
14/20 fixtures ran. Of those, `expert-clarity` was first-ranked for 2 (`finance-01`,
`finance-02`) — 2/14 = 14%. The full-set gate needs all 20: the 6 outstanding fixtures
include 1 more `finance` fixture and both `health` fixtures, all three of which *expect*
`expert-clarity` as their correct preset per the fixture file, plus 3 `product`
fixtures that expect `premium-product-lifestyle`. If the remaining fixtures land on
their expected presets, the final count would be 5/20 = 25% (still under the 40% cap),
but this is a projection from the fixture file's expectations, not a measured result —
Gate 1 cannot be marked PASS or FAIL until the 6 remaining fixtures are actually run.

### First-ranked treatment distribution (14/20 completed)

| preset | count | share of 14 completed |
|---|---|---|
| thai-supernatural-horror | 3 | 21% |
| thai-history-period-storytelling | 3 | 21% |
| thai-human-drama | 3 | 21% |
| investigative-news-crime | 3 | 21% |
| expert-clarity | 2 | 14% |

## Reading

The invocation fix works as expected — 14 consecutive real analyzer calls succeeded
with zero errors, so the `--conditions=react-server` requirement was the entire blocker
from the first attempt, not any defect in the analyzer or the fixtures. On the data that
does exist, the "monoculture" the benchmark exists to catch is not showing up: `ghost`,
`history`, `drama`, and `news` each cleanly picked their own distinct, category-specific
preset in all 9-of-9 (well, 12-of-12 counting drama, which isn't gated but still
diagnostic) attempts, and the two `finance` fixtures that did run correctly fell through
to `expert-clarity` — exactly the "neutral last resort for content with no strong genre
signal" behavior the ranking rule is supposed to produce, not evidence of a collapse.
Gate 2 is conclusively PASS. Gate 1 cannot be called yet — the fixtures still needed to
settle it (the second finance fixture, both health fixtures, and the three product
fixtures) are precisely the categories most likely to test whether `expert-clarity`
over-fires, so finishing the run matters for confidence on Gate 1 even though the
partial numbers point toward a pass. A follow-up paid run over just those 6 fixtures (or
a fresh full 20-fixture run with a longer timeout, e.g. `timeout 600`) is needed to close
this out.
