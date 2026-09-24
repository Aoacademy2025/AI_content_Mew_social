# Task 4 — build memory sampler

Implementation SHA: `9c6a7793`

## Summary

Added an opt-in standard-library Linux sampler for the next necessary build. It writes bounded mode-0600 JSONL, follows PID/start-time identities, stops on root reuse, marks child exit/reuse races without zero fabrication, and records allowlisted roles, stages, numeric compiler heap, `smaps_rollup` memory, and host availability/swap. Raw command lines, environments, and log text never leave memory; even CLI errors are fixed strings. The runbook covers systemd/nohup persistence. No build, SSH, deploy integration, default activation, heap change, or production workload occurred. Copied environment files were quarantined unread before checks.

## Changelist

- `scripts/build_memory_sampler.py`: sampler and CLI.
- `scripts/test_build_memory_sampler.py`: privacy, PID reuse/race, lifecycle/bounds, and synthetic CLI fixtures.
- `docs/runbooks/build-memory-sampler.md`: guarded operator procedure.

## Commands

- `env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/python3 -m unittest scripts.test_build_memory_sampler` — 9 passed.
- `env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/python3 -m py_compile scripts/build_memory_sampler.py scripts/test_build_memory_sampler.py` — passed.
- `git diff --check` — passed.

RED was observed before each parser, reuse/lifecycle, summary, stage, CLI, and static-error implementation slice.
