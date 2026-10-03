# Task 3 (PR-A): CI covers every MCP verify script

## Summary

Confirmed the 7 named scripts were genuinely orphaned (not run by any CI step or npm-script
chain reachable from CI). `verify:heygen-avatar-engines` was already wired in CI (`.github/workflows/ci.yml`
line 195) and already chains `verify-mcp-avatar-input.ts` — no change needed there.

Of the 7 orphans:
- 6 pass on Node 22 and are now wired into a new `verify:mcp-all` npm script, run from one new
  CI step, `MCP verify (all)`.
- 1 (`verify-mcp-orchestrator.ts`) fails for a genuine behavior reason (not environment) and is
  excluded with a reason, per the task's rule for superseded behavior.

## Scripts added to `package.json`

```
"verify:mcp-audit-status": "tsx scripts/verify-mcp-audit-status.ts",
"verify:mcp-orchestrator-steps": "tsx scripts/verify-mcp-orchestrator-steps.ts",
"verify:mcp-pipeline-timeout": "node --conditions=react-server --import tsx scripts/verify-mcp-pipeline-timeout.ts",
"verify:mcp-token": "node --conditions=react-server --import tsx scripts/verify-mcp-token.ts",
"verify:mcp-videojob": "node --conditions=react-server --import tsx scripts/verify-mcp-videojob.ts",
"verify:mcp-all": "npm run verify:mcp-parity && npm run verify:mcp-audit-status && npm run verify:mcp-orchestrator-steps && npm run verify:mcp-pipeline-timeout && npm run verify:mcp-token && npm run verify:mcp-videojob",
"verify:mcp-ci-coverage": "tsx scripts/verify-mcp-ci-coverage.ts"
```

`verify:mcp-parity` already existed (`tsx scripts/verify-mcp-parity.ts`) but was not referenced
anywhere in CI; it is now the first link in `verify:mcp-all`.

`verify-mcp-pipeline-timeout.ts`, `verify-mcp-token.ts` and `verify-mcp-videojob.ts` needed
`--conditions=react-server` (they transitively import a `server-only`-gated module /
`src/lib/prisma`), matching the convention already used for every other MCP verify script.
`verify-mcp-token.ts` and `verify-mcp-videojob.ts` also do real Prisma reads/writes, so they
need a pushed schema, not just a bare `DATABASE_URL` file (the job-level `file:./ci.db` has no
tables — confirmed no other CI step pushes a schema into it).

## CI change (`.github/workflows/ci.yml`)

Added one new step right after the existing subtitle/MCP step, following the same
dedicated-DB pattern already used by the "Verify durable AI-image cost reporting" step:

```yaml
- name: MCP verify (all)
  env:
    DATABASE_URL: file:${{ runner.temp }}/heroai-mcp-verify.db?connection_limit=1
  run: ./node_modules/.bin/prisma db push --skip-generate && npm run verify:mcp-all && npm run verify:mcp-ci-coverage
```

No existing step was modified; `verify:mcp-perfect` / `verify:subtitle-audio-sync` /
`verify:heygen-avatar-engines` are untouched.

## Exclusion

`scripts/mcp-verify-exclusions.json` (new):

```json
{
  "scripts/verify-mcp-orchestrator.ts": "Fails on 'subtitle quality gate: rejects changed words/numbers before rendering' — that behavior was removed by ADR 0056 (2026-08-31): subtitle QA is now a report, not a gate; BLOCKING_SUBTITLE_CODES (src/lib/mcp/subtitle-quality.ts) is only empty_script/empty_captions. All other assertions in this file pass; not an environment issue."
}
```

Investigation: ran the script with a real pushed schema (`--conditions=react-server`, dedicated
throwaway DB) and it failed at the assertion `subtitle quality gate: rejects changed words/numbers
before rendering` (the test posts a transcript with changed numbers/words and asserts the job is
marked `failed` and `render` is never called). Read `src/lib/mcp/orchestrator.ts` (~L2410-2460)
and `src/lib/mcp/subtitle-quality.ts` (~L1047-1060): `BLOCKING_SUBTITLE_CODES = ["empty_script",
"empty_captions"]` with an explicit comment "the only subtitle findings that make a clip
un-renderable... (ADR 0056: subtitle QA is a report, not a gate)". This matches
`CLAUDE.md`'s own note that ADR 0056 superseded the old gate and that QA for anything besides
empty_script/empty_captions is report-only. The orphan test encodes pre-ADR-0056 behavior that
was deliberately removed — not an environment problem (DB/env were fully set up the same way as
the other 3 DB-dependent scripts, which all pass). Per the task instructions this was excluded,
not rewritten or deleted. No production code was touched.

## New script: `scripts/verify-mcp-ci-coverage.ts` (+ `verify:mcp-ci-coverage`)

Parses every `run:` value out of `.github/workflows/ci.yml` (single-line and `|`/`>` block
scalars — hand-rolled indentation scan, not a YAML library, to avoid relying on `js-yaml` as an
undeclared transitive dependency), extracts `npm run <name>` targets and direct
`scripts/*.{ts,tsx,mts,mjs,py}` paths from each, and recursively resolves `npm run` chains
against `package.json`'s `scripts` map to any depth. That produces the full set of script paths
reachable from CI.

It then globs `scripts/verify-mcp-*.ts`, `scripts/verify-media-import*.ts` and
`scripts/verify-safe-fetch.ts` and fails if any matched file is neither reachable nor listed in
`scripts/mcp-verify-exclusions.json`, and fails if any exclusion entry names a file that doesn't
exist or IS reachable (exclusion bookkeeping checked both ways).

Self-test: the violation/exclusion-problem checks are pure functions
(`findUncoveredOrMiswired`, `findExclusionProblems`) parameterized by their inputs, so the
self-test exercises them with synthetic data (a fake unreachable path, a real reachable path
mis-marked as excluded, a nonexistent exclusion target) with **no filesystem writes** — cleaner
than writing/deleting a throwaway file in `scripts/`, and it runs first in the script's own
output so a broken guard fails loudly before the live check even starts.

## Verification (Node 22, `node-v22.23.3-darwin-arm64`, per G30)

All commands run with that Node 22 build first on `PATH` and a dedicated throwaway SQLite DB
(`prisma db push --skip-generate --accept-data-loss` against a fresh file first, mirroring the
CI step exactly):

| Command | Exit code |
|---|---|
| `node --version` | — (`v22.23.3`, confirmed before every run) |
| `DATABASE_URL=file:<fresh>.db npx prisma generate` | 0 |
| `./node_modules/.bin/prisma db push --skip-generate --accept-data-loss` (fresh throwaway DB) | 0 |
| `npm run verify:mcp-all` | 0 (all 6 chained scripts pass; last line `✅ ALL 52 VIDEOJOB CHECKS PASSED`) |
| `npm run verify:mcp-ci-coverage` | 0 (`✅ ALL MCP CI-COVERAGE CHECKS PASSED`, 22 matched scripts, all covered or validly excluded) |
| `npm run verify:mcp-perfect` (same DB) | 0 (`50 assertions passed ✅`) |

Individual orphan scripts were also run standalone before wiring, to isolate failures/env needs:
- `verify-mcp-audit-status.ts` — 0 (27 assertions)
- `verify-mcp-orchestrator-steps.ts` — 0 (19 checks)
- `verify-mcp-parity.ts` — 0 (already had a working npm script, just unwired from CI)
- `verify-mcp-pipeline-timeout.ts` (needs `--conditions=react-server`) — 0 (5 checks)
- `verify-mcp-token.ts` (needs pushed schema) — 0 (22 checks)
- `verify-mcp-videojob.ts` (needs pushed schema) — 0 (52 checks)
- `verify-mcp-orchestrator.ts` (needs pushed schema) — **1**, excluded (see above); failing
  excerpt:
  ```
  ❌ subtitle quality gate: rejects changed words/numbers before rendering
  ```

No `npm install` was run. No production code (`src/`) was changed — only `package.json`
(scripts section), `.github/workflows/ci.yml` (one new step), and two new files under `scripts/`.

## Deviations from the task text

None. `verify:heygen-avatar-engines` was confirmed already running in CI, as the task asked me
to verify rather than assuming.

## Commit

`git log -1 --format=%H` after committing: see handback message.
