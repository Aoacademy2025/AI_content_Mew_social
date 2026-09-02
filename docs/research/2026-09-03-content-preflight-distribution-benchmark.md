# Content Preflight distribution benchmark — 2026-09-03

**Status: BLOCKED before any provider call.** The dry run passed; the real (paid) run
never executed a single analyzer call because the invocation specified for Task 8
crashes during module import. Zero cost was incurred. This doc records the attempt,
the root cause, and the exact fix needed before a paid run can be attempted again.

- Date: 2026-09-03
- Commit: `70cac1d2` (branch `mew/brands-wave1-t8b`)
- Worktree: `AI_content_Mew_social-brands-wave1-c`
- Script: `scripts/benchmark-content-preflight-distribution.ts`
- Fixtures: `scripts/fixtures/content-preflight-distribution.json` (20 entries)

## Step 1 — dry run

```
npx tsx scripts/benchmark-content-preflight-distribution.ts --dry-run
```

Result: **PASS**. Fixture validation succeeded — 20 fixtures, category counts matched
the expected distribution, and every fixture's `expectedStylePackId` maps to an ACTIVE
Style Pack paired with the matching treatment preset.

```json
{
  "mode": "dry-run",
  "benchmark": "content-preflight-distribution",
  "fixtures": 20,
  "categories": { "ghost": 3, "history": 3, "drama": 3, "news": 3, "finance": 3, "health": 2, "product": 3 },
  "windowsPerFixture": 4,
  "paidCallsStarted": false
}
```

Gates as printed:
1. `expert-clarity` first-ranked <= 40% (max 8 of 20 fixtures)
2. every ghost/history/news fixture ranks its matching preset first (9 fixtures)

## Step 2 — real (paid) run

Command run exactly as specified in the task dispatch:

```
CONTENT_PREFLIGHT_BENCHMARK_KEY="$(grep '^GEMINI_SERVER_KEY=' .env | cut -d= -f2- | tr -d '"')" \
  npx tsx scripts/benchmark-content-preflight-distribution.ts 2>&1 | tee /tmp/preflight-benchmark.log
```

Result: **crashed immediately**, before the fixture loop started. Full output:

```
This module cannot be imported from a Client Component module. It should only be used from a Server Component.
```

No per-fixture lines were printed, no `artifacts/content-preflight-distribution/results.json`
was written, and `artifacts/` was not even created — confirmed by `ls artifacts/` (no such
directory) after the run. **Zero Gemini calls were made; the real run cost ฿0.**

### Root cause

`runPaid()` dynamically imports `src/lib/content-preflight.server.ts`, which imports
`src/lib/project-visual-assets.server.ts`, which begins with `import "server-only"`.
The `server-only` marker package's `package.json` exports map resolves to a no-op
(`empty.js`) only under Node's `react-server` conditional-exports condition; otherwise
it resolves to `index.js`, whose entire body is:

```js
throw new Error(
  "This module cannot be imported from a Client Component module. " +
    "It should only be used from a Server Component."
);
```

Every other script in this repo that transitively imports a `*.server.ts` file with a
`server-only` guard is invoked with `node --conditions=react-server --import tsx
<script>` (see `package.json` — `verify:content-preflight-thai-name`,
`benchmark:brand-treatment-v1`, `verify:brand-visual-system`, etc., all ~40 occurrences).
`scripts/benchmark-content-preflight-distribution.ts` has no matching `npm run
benchmark:...` entry in `package.json`, and its own header comment documents the bare
`npx tsx scripts/benchmark-content-preflight-distribution.ts` invocation (no
`--conditions=react-server`) as the paid-run command. That invocation is what the Task 8
dispatch also specified. The `--dry-run` path does not hit this: it only imports
`brand-treatment-catalog` and `style-pack-catalog` for catalog validation, neither of
which pulls in a `server-only` module — which is why the dry run passed while the real
run died on the very next import.

### What did NOT happen

- No fixture was analyzed (0/20).
- No Gemini API calls were made (0 calls, ฿0 spent).
- Gate 1 and Gate 2 were not evaluated — there is no distribution to report.
- No files were written under `artifacts/` (directory doesn't exist).
- `git status` is clean; nothing in the worktree changed as a side effect of the crash.

### Fix needed before re-attempting

Either give the script an `npm run benchmark:content-preflight-distribution` entry using
the same pattern as `benchmark:brand-treatment-v1` —

```
"benchmark:content-preflight-distribution": "node --conditions=react-server --import tsx scripts/benchmark-content-preflight-distribution.ts"
```

— or update the script's own header comment/instructions to require
`node --conditions=react-server --import tsx` for the paid path. Per the Task 8b
dispatch's hard rule ("Do NOT re-run on failure — report"), this run was not retried
with a modified invocation; the fix and a fresh approved paid run are left for a
follow-up task.

## Reading

No distribution data exists to interpret — the real run never reached the analyzer.
The dry run confirms the fixture set itself is sound (correct counts, correct
category/preset/Style-Pack pairings), so the benchmark's *content* is not in question;
only its *invocation* is broken for the paid path. Once the `--conditions=react-server`
fix lands, a re-run should reuse this same fixture set and the same two gates
unchanged.
