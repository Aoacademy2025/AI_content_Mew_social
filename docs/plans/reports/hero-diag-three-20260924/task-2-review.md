# Tier 1 review — Task 2 / HERO-41

**Reviewed range:** `3d2c27a65a96f88435bc4e9df45c26b493df0b35...f75ff386ae011873cba2733488cb0ee52e286c0f`  
**Exact reviewed head:** `f75ff386ae011873cba2733488cb0ee52e286c0f` (`fix(cleanup): yield between apply objects (HERO-41)`)  
**Authority:** approved plan `docs/plans/2026-09-24-hero-diag-three.md`, Task 2 package, global constraints, ADR 0006, and the control review criteria.

## Verdict

**Clear of blocking findings.** The change is a narrow correction to the observed default-cadence deferral defect. It forces the pre-existing yield gate immediately *before* each independently recoverable apply object in both runners. It does not introduce a mid-object exit, alter the gate's deadline-first/latched semantics, or change cleanup eligibility and integrity decisions.

## Spec and correctness

- `src/lib/media-local-eviction.ts:459-474` checks the gate before `evictOne`. A busy result returns before quarantine, while an object whose busy state becomes observable during `evictOne` completes its existing quarantine, post-quarantine remote verification, catalog CAS, cleanup, and restoration-on-failure path before the next forced check.
- `src/lib/media-local-missing-reconcile.ts:296-324` likewise checks before the missing-path recheck and CAS. The completed prior row remains committed; the next row is untouched.
- Existing scan polling remains in place. `createYieldGate` was not changed: deadline testing precedes activity testing and a yielded reason remains latched. The active systemd caller includes `--deferWhenBusy`, so it supplies the activity callback on the intended maintenance path.
- The eviction regression (`scripts/verify-media-local-eviction.ts:616-641`) uses default cadence for the apply scenario and establishes that activity arriving during object one completes that object and prevents object two. The missing-local regression (`scripts/verify-media-local-missing-reconcile.ts:155-180`) establishes the corresponding persisted-CAS/untouched-next-row behavior.
- Diff inspection found no changes to checksum validation, fresh catalog reads, remote pre/post verification, CAS, quarantine/restore, retention, object/byte limits, or rollout guards. Existing failure and restoration coverage remains exercised.

## Standards and scope

No documented-standard violation or material Fowler-baseline smell found. The change stays within Task 2's five owned files, adds no dependency, production instrumentation, budget increase, production access, customer data, or log payload. `git diff --check` is clean.

## Advisory

- **A1 — benchmark label can overstate the baseline (advisory).** `scripts/benchmark-media-local-eviction.ts:203-307` runs the current (fixed) runner in both arms. Its `preFixDefaultPollingSimulation` arm returns `false` without running SQLite activity reads at safe apply boundaries; it does not execute the prior commit's post-object default gate behavior. The JSON field and Task 2 report disclose this control, and the separate default-cadence regressions prove the behavior, so this is not a correctness blocker. Rename the arm/fields to e.g. `withoutSafeBoundaryActivityQuery` and describe it as an overhead control, reserving “pre-fix” for an actual prior-revision run.

## Independent verification

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run verify:media-local-eviction` | 0 | PASS: eviction, rollback, busy-yield, exit code |
| `npx tsx scripts/verify-media-local-missing-reconcile.ts` | 0 | PASS: checksum-gated, fail-closed reconciliation |
| `npx eslint scripts/benchmark-media-local-eviction.ts scripts/verify-media-local-eviction.ts scripts/verify-media-local-missing-reconcile.ts src/lib/media-local-eviction.ts src/lib/media-local-missing-reconcile.ts` | 0 | clean |
| `npx tsx scripts/benchmark-media-local-eviction.ts` | 0 | three disposable SQLite/local-file runs; identical idle outcomes; activity-query timing captured |
| `npx tsx scripts/verify-media-remote-gc.ts` | 0 | PASS: expiry/grace, deletion, restoration safeguards |
| `npx tsx scripts/verify-media-r2-orphan-gc.ts` | 0 | PASS: retention, reference, manifest and SHA guards |
| `git diff --check 3d2c27a...f75ff386` | 0 | clean |

`npm run verify:media-storage` was started independently, but this executor detached its aggregate child after its 30-second return window; it completed without a captured aggregate exit, so it is not claimed as independently passed here. The directly relevant suites above, plus the remote-GC/orphan integrity suites, passed. No full build was run; that remains the coordinator's combined-build gate.

## Limits

The benchmark uses 18,865 local 4 KiB files, disposable SQLite, and zero-latency fake remote I/O. It measures local operation shape and the added activity-query cost only; it cannot explain or certify an improvement to the observed 90-minute production runs. No production action was performed. HERO-41 remains open pending natural production evidence and final correctness/security review.
