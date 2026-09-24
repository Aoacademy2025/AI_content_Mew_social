# Task 4 — build memory sampler

Implementation SHAs: `9c6a7793`, corrective `affab99c`

## Summary

Added an opt-in standard-library Linux sampler for the next necessary build. It writes bounded mode-0600 JSONL, follows PID/start-time identities, and records allowlisted roles, stages, effective numeric compiler heap, `smaps_rollup` memory, and host availability/swap. The corrective change applies Node command-line precedence, both supported heap-flag spellings and entrypoint boundaries; ambiguous values become null. A final root identity read makes each sample atomic across child reads. Raw command lines, environments, and log text never leave memory; CLI errors are fixed strings. No build, SSH, deploy integration, activation, heap change, or production workload occurred. Copied environment files were quarantined unread before checks.

## Changelist

- `scripts/build_memory_sampler.py`: sampler and CLI.
- `scripts/test_build_memory_sampler.py`: privacy, heap precedence, PID reuse/race, lifecycle/bounds, and synthetic CLI fixtures.
- `docs/runbooks/build-memory-sampler.md`: guarded operator procedure.

## Commands

- `env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/python3 -m unittest scripts.test_build_memory_sampler` — 14 passed.
- `env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/python3 -m py_compile scripts/build_memory_sampler.py scripts/test_build_memory_sampler.py` — passed.
- `git diff --check` — passed.

RED was observed for command-line heap precedence, unsupported/after-entrypoint forms, underscore spelling, and root reuse during a later child read before the corrective implementation.
