# Task 2 — HERO-41 cleanup cost probe

Status: delivered on `codex/hero41-cost-probe-20260924` from `fdc4b984`.

`LocalEvictionReport.applyCosts` now emits only numeric aggregates for graph rebuilds, local SHA-256 bytes/time, catalog calls/time, remote checks/time, and residual apply work. An injectable monotonic clock makes attribution deterministic. No graph reuse, cache, retention, or cleanup decision changed.

RED: `npm run verify:media-local-eviction` failed because `applyCosts` was absent. GREEN: that suite, reference-graph integrity, purge-disabled, cleanup-mode, and `tsc --noEmit` passed under a blank environment and disposable SQLite.

The existing isolated benchmark ran three representative passes: 18,865 files, 938 verified rows, 326 evictions, zero errors. Each pass reported exactly 326 graph rebuilds, 326 hashes, 652 catalog calls, and 326 remote checks. Graph time was 121.8–123.4 ms; synthetic apply time was 590–627 ms. The sparse synthetic graph proves repetition and attribution, not production share; optimize only after a natural diagnostic run.
