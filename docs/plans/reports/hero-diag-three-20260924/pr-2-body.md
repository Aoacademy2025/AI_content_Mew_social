When customer work starts during a cleanup operation, default polling can allow the next object to begin before rechecking activity. Force an activity check at safe per-object boundaries in local eviction and missing-local reconciliation, after the preceding object has completed. Checksum, remote verification, catalog CAS and quarantine/restore behavior remain intact.

[HERO-41](https://linear.app/mew-social/issue/HERO-41) stays open for production verification and the remaining scan/apply cost investigation.

Validation: observed RED/GREEN for both real runner seams under default polling; media-storage integrity suite, TypeScript, scoped ESLint and diff checks pass. A three-run disposable SQLite/files benchmark records phase/operation costs and identical cleanup outcomes; 326 added activity queries cost 32–35 ms locally versus a same-head polling-suppressed overhead control (not execution of the prior revision). The 4 KiB/fake-remote fixture does not explain or certify improvement over production's 90-minute runs. Independent task, whole-branch correctness and security/privacy reviews are clear. Integrated production build passed; exact-head GitHub CI passed (13m38s).

No retention, runtime-budget, schema or deployment changes. Rollback is reverting this PR. No production cleanup was triggered.
