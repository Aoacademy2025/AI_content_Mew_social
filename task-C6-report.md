# Task C6 Report — Documentation edits

## Files touched
1. `CLAUDE.md`
2. `docs/ops/linear-sentry-observability.md`
3. `docs/audits/2026-09-12-performance-audit.md`

## Changes by file

### CLAUDE.md (5 edits)
- Line 11: Changed `Next.js 15` to `Next.js 16`
- Line 37: Replaced trailing `admin` with description of 11 split routes and ADR 0062 reference
- Line 39: Removed non-existent `src/components/remotion/` directory reference
- Line 54: Changed `src/middleware.ts` to `src/proxy.ts` and noted Next 16 renamed the file
- Lines 57–58: Added new gotcha pointing at ADR 0062 with money-only-on-revenue principle

### docs/ops/linear-sentry-observability.md (1 insertion)
- Added new section "In-app error visibility" between "Noise filtering" and "Production environment"
- Describes how the daily error card on `/admin` displays ERROR_SYSTEM notifications and frontend_error telemetry as secondary counts while Sentry remains the evidence source

### docs/audits/2026-09-12-performance-audit.md (2 edits to Thai summary, lines 5–31)
- Line 29–30: Replaced "จะแก้ยังไง:" (how to fix) section with acknowledgment that Phase B deployed 2026-09-12 14:37Z with measured results showing slow-tx reduced from 42/98/71 to 1 event in 24h (0 in last 22h), Socket timeout 0, P1008 0
- Line 31: Reframed final targets as "สมบูรณ์หลังจาก Phase C" with slow-tx target confirmed ✓, shifting from hypothetical "ถ้าทำครบ" to measured completion status

Thai summary consistency with §8: ✓ Updated to reflect measured improvements from round 2 deployment and acknowledge Gate B completion. Targets now state measured achievements rather than planned fixes.

## Verification
```bash
npm run verify:sentry-config
```
**Result:** `38/38 passed` (exit code 0)

## Commit
- SHA: `85b45d9e`
- Branch: `mew/perf-c6-docs`
- Pushed to `origin/mew/perf-c6-docs` ✓

## Notes
- No source code changes made
- No reformatting of untouched lines
- All edits are mechanical documentation updates aligning stale facts with measured reality
- Thai summary updated to reflect that round-2 audit findings have been measured and partially achieved
- Commit attribution includes Haiku model ID as per system reminder
