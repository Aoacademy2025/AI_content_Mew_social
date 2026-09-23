# Execution ledger
Plan: docs/plans/2026-09-24-heygen-avatar-engines.md
Profile: high-assurance; automatic fix rounds max5; child runs max16; numerical usage unavailable.

- User approved IV/V direction/execution; keep existing BYOK disclosure and explicit choice, no new billing policy. Fresh worker contexts satisfy execution separation; no redundant approval/session restart.
- Official research + focused integration map complete; research follow-up establishes v3greenMP4 and private per-look capability metadata. Three substantive research/map runs used.
- Separate existing PR539/540/541 deployment is explicitly authorized and owned by deploy_ops_three; this worktree must not mutate prod or merge newfeature during that release.
