# Final security and privacy review — discriminating probes

## Verdict

**PASS — no blocking security, privacy, or data-integrity findings.**

- Base: `fdc4b984a64592a15f35821023d7dbdb8655f2f9`
- Exact reviewed head: `720106d068f8183a00c4da50dd8e805bd4fe8830`
- Scope: Tasks 1, 2, and 4 from `docs/plans/2026-09-24-hero-discriminating-probes.md`

## Findings

### Blocking

None.

### Advisory — bind initial WAL validation to the pinned database inode

`scripts/observe-sqlite-locks.py:261-263` reads and closes the database header,
then obtains the database and `-shm` identities in separate path operations. A
path replacement in that small startup window can therefore pin a replacement
database whose WAL header was never validated. The later pre/post-snapshot
identity checks are sound for the identity they pin, so this is an
evidence-integrity hardening item rather than a privacy exposure under the
documented serialized operator use. A future revision can read the header and
derive the identity from one open descriptor, then compare that identity to
the path before every snapshot.

### Advisory — cap work used to construct one sample if hostile host scale is in scope

The 1,000-record observer cap and sampler JSONL byte cap bound retained output,
but one observer snapshot can still scan every non-targeted `/proc/locks` line,
and one sampler sample can enumerate all PIDs and materialize every descendant
before checking the file and duration limits. Normal Linux host limits and the
operator-only use make this acceptable here. A future hostile-scale version
should cap inspected lock lines/process rows and check the monotonic deadline
inside those scans.

## Assessment

- Prisma adds only the generated numeric column to the existing sanitized
  relative source. The diagnostic still emits no SQL, arguments, rows, errors,
  URLs, environment values, or absolute deployment paths.
- The SQLite observer reads only the 20-byte database header, file metadata,
  `/proc/locks`, and numeric `/proc/<pid>/stat` start times. It buffers until a
  successful observation, emits numeric/fixed fields, rejects unsupported
  targeted formats and identity changes with static errors, and retains at
  most 1,000 lock intervals. It never reads command lines or environments.
- Cleanup instrumentation emits aggregate numeric counts, byte totals, and
  durations. Default deletion remains `unlink`; graph freshness, staged-file
  hash verification, remote verification, catalog CAS, quarantine manifests,
  restoration, operation locks, and manifest/state hashes are unchanged. The
  graph callback is exception-contained, including rejected graph builds.
- The build sampler reads bounded prefixes of `cmdline`, `environ`, build log,
  and memory pseudo-files only to derive allowlisted roles, stages, compiler
  target/heap, and numeric memory fields. Raw input cannot reach JSONL or CLI
  errors. Output uses `O_EXCL`, Linux `O_NOFOLLOW`, and `fchmod(0600)`, has hard
  duration/file-size limits, and stops on root exit or start-time reuse.
- Repository search found no application, deploy, service, or startup caller
  for either standalone probe. The only package entry is an explicit SQLite
  verification command; the sampler remains manual and opt-in.

## Independent verification

| Check | Result |
| --- | --- |
| Blank-environment build-sampler unittest | PASS, 14/14 |
| Blank-environment SQLite observer fixture | PASS |
| `git diff --check fdc4b984...720106d0` | PASS |
| Exact-head and clean-worktree check | PASS |

No SSH, build, environment inspection, production/customer data access,
natural observation, or implementation mutation was performed.
