# Independent review criteria

Read approved plan and global constraints; review exact task HEAD only. Author report is evidence to verify, not authority. Reports go in this control worktree. Return <=150 words; findings identify severity, file:line, trigger, impact and smallest correction. Run scoped tests independently; coordinate full builds with root.

## SQLite
- Public $transaction overloads, callback this/options/results/errors and rollback remain intact.
- Before-entry/callback/total timings are honest; never infer write ownership.
- Concurrent overlapping invocations have distinct phase data and real invoking source.
- Disabled diagnostics do not wrap or invoke extra work; logging itself must not alter outcomes.
- No args, SQL, IDs, model/row values, file paths or error payloads leak through diagnostics.

## Cleanup
- Exercise default polling with customer work arriving during expensive apply. Respect safe per-object completion and then stop before next object.
- Preserve fresh catalog inspection, hash, remote verification, CAS and quarantine/restore; test busy changes at meaningful asynchronous boundaries.
- Include partial failures and restoration; optimization must not change retention or selection.
- Benchmark same inputs, declared file sizes/remote latency and comparable operation outcomes; no live speed claim.
- Phase measurements bounded/content-free and no new production side effect beyond explicitly reviewed minimal change.

## Acoustic
- Distinguish actual model from fake/test harness and synthetic audio from Thai speech acceptance.
- Runtime limits include setup and prevent runaway inference; offline mode truly prevents network/download and no customer media.
- If chunking enters production, validate global timestamps, boundary coverage, determinism, process cancellation, caches and quality parity with a meaningful actual-engine fixture.
- Production 180s/60s budgets, text quality thresholds, fallback order and no-export-realignment remain unchanged.
- New benchmark must fail meaningfully if intended mechanism regresses; its inability to establish human perception is stated.

## Final gate
No merge/deploy, Linear Done or customer communication. Package actual limitations and material advisories. Heavy final correctness/security review covers supported changes as a whole, with ownership boundaries explicit.
