A natural render transaction took 20 seconds, but existing diagnostics combine time before callback entry with callback work. Append per-invocation phase timings to the existing sanitized slow-transaction line, preserving transaction behavior and the existing elapsed/source prefix. Array transactions remain total-only. These timings do not identify the SQLite lock holder.

Resolves the diagnostic follow-up for [HERO-10](https://linear.app/mew-social/issue/HERO-10); the parent contention issue remains In Progress.

Validation: observed RED then GREEN with disposable SQLite and independent bundled callers; tested concurrent contention, slow callback, max-wait rejection, array transactions, disabled instrumentation, return/error/options/context preservation and logger failure isolation. Prisma options verification, TypeScript and scoped ESLint pass. Independent task, whole-branch correctness and security/privacy reviews are clear. Integrated production build passed; exact-head GitHub CI passed (14m12s).

No schema, timeout, retry, billing or production configuration changes. Rollback is reverting this PR. No production holder/performance claim, merge or deployment.
