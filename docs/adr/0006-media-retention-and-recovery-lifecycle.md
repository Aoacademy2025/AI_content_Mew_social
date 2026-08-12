# ADR 0006: Media retention and recovery lifecycle

Status: accepted  
Date: 2026-08-12

## Decision

Customer-visible Gallery and generated video media follow the tier in force
when the owning `Video` or completed `VideoJob` receives its frozen expiry:

- FREE: 3 days
- PRO: 7 days
- BUSINESS: 14 days

An active editor project retains its script, settings, and ownership pointers,
but does not extend generated media beyond that frozen expiry. Only genuinely
in-flight work (`queued`, `processing`, `waiting_provider`, or active render
jobs) can protect media without a fixed expiry.

After tier retention ends:

1. Gallery and preview APIs stop presenting the media.
2. A verified local replica may be evicted immediately.
3. The verified R2 replica enters `delete_pending` and remains recoverable for
   seven additional days.
4. After the recovery deadline, reference-aware GC rebuilds the graph, verifies
   catalog identity and SHA-256, and physically deletes the R2 object.
5. The catalog keeps a deletion audit record; it does not keep the bytes.

Shared immutable R2 blobs are deleted only after every logical alias is
eligible. Media with an unknown expiry, malformed ownership data, a live
reference, an unverified remote replica, or a graph error fails closed.
The recovery deadline is the latest applicable tier expiry plus seven days; it
is never reset to seven days from the time a GC process first discovers the
object. For unreferenced media, the equivalent deadline is its 14-day
eligibility cutoff plus seven days.
An R2 object with no active catalog identity is treated as an orphan, not as an
immediately deletable object. It remains untouched until its R2 observation is
21 days old (14-day unreferenced retention plus seven recovery days). Before
deletion, legacy v1 identities must also have no live or recovery-window
reference-graph owner, while all identities require stable size, last-modified
time, and SHA-256 metadata.

## Operational policy

- Local eviction and R2 GC share an exclusive lock.
- Catch-up runs are bounded to 500 objects and 50 GiB every four hours.
- A blanket Cloudflare age-based lifecycle rule is prohibited because object
  age cannot represent tier expiry or shared aliases.
- Alert when expired eligible backlog remains non-zero for more than 24 hours,
  `delete_pending` exceeds its seven-day deadline, local disk exceeds 80%, or
  catalog/graph/checksum errors are non-zero.

## Consequences

The maximum expected R2 footprint includes live tier retention plus seven days
of recovery copies. The VPS is not a backup store and should contain only
in-flight media and tier-live media awaiting verified eviction. Project media
can display an expired state while the project itself remains editable and can
be rendered again.
