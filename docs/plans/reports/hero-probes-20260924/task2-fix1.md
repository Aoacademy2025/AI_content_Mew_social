# Task 2 Tier-1 fix — recovery catalog attribution

Status: fixed on `codex/hero41-cost-probe-20260924`.

The Tier-1 medium blocker was correct: recovery `markLocalPresent` after a post-CAS failure was counted as residual apply work. A deterministic injected-clock regression now forces unlink failure after catalog CAS, verifies file and catalog restoration, and requires catalog `3 calls / 15 ms` with residual apply `5 ms`.

RED reproduced the exact mismatch: catalog `2 / 10 ms`, residual `10 ms`. GREEN times `markLocalPresent` through the existing catalog accumulator; cleanup behavior and rollback boundaries are unchanged.

Passed under a blank environment and disposable SQLite: local eviction, reference graph, and `tsc --noEmit`.

The review’s quarantine-verifier failure remains an unrelated base/admin-page assertion about absent `new URLSearchParams`. Both `scripts/verify-media-quarantine.ts` and `src/app/(dashboard)/admin/page.tsx` are unchanged from `fdc4b984`.
