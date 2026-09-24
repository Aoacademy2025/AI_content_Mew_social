# HERO-10 natural phase follow-up — 2026-09-24

## Scope

This is a read-only follow-up against the deployed `fdc4b984a64592a15f35821023d7dbdb8655f2f9` build. It did not change production files, PM2/systemd state, databases, queues, financial state, providers, or customer data. Production log content, environment values, paths, and payloads remain private; the observations below contain only aggregate counters, static bundle provenance, and numeric timings.

## Offset-based production observation

The existing private baseline starts at `2026-09-24T07:41:40.729700Z`. A read-only scan through `2026-09-24T12:35:31.493436Z` found no rotation or oversized-offset truncation. Its counters were:

| Signal | Count |
| --- | ---: |
| `[prisma-slow-tx]` at least 5,000 ms | 4 |
| `P2028` | 0 |
| SQLite busy/locked | 0 |
| Transaction already closed | 0 |
| application heap OOM | 0 |
| Socket timeout | 0 |
| `P1008` | 0 |
| `OUTPUT_INVALID` (and therefore no `OUTPUT_INVALID` expiry subset) | 0 |

The four slow events are all interactive transactions in the web app's error log:

| Natural event group | Static bundle provenance | Elapsed | Before callback | Callback | Entered |
| --- | --- | ---: | ---: | ---: | ---: |
| `2026-09-24T10:17:05Z` (first) | `app/api/videos/fetch-stock/route.js:72` | 29,782 ms | 29,782 ms | 0 ms | 0 |
| `2026-09-24T10:17:05Z` (second) | `app/api/videos/fetch-stock/route.js:72` | 29,794 ms | 29,794 ms | 0 ms | 0 |
| `2026-09-24T10:17:05Z` (third) | `app/api/videos/fetch-stock/route.js:72` | 30,158 ms | 20,063 ms | 10,090 ms | 1 |
| `2026-09-24T10:59:46Z` | `app/api/videos/jobs/route.js:1` | 20,048 ms | 2 ms | 20,037 ms | 1 |

For each event, an additional read-only classifier examined timestamped lines from the same log file in `[T−2 s, T]` and returned only an allowlist of process/operation labels (`orchestrator`, `story-film`, `render-worker`, `cron`, `fetch-stock`, `jobs`, Socket timeout, `P1008`, and `OUTPUT_INVALID`). All four classifications were empty. This says only that this bounded log context supplied no correlating label; it does not say that no other database writer existed.

The phase meaning is limited by the diagnostic's documented semantics. The first two fetch-stock calls did not receive a Prisma callback before completing. The third waited before entry and then spent about 10.1 seconds in its callback. The jobs call entered almost immediately and spent about 20.0 seconds in its callback. A callback may itself wait on its first write, and neither duration is a SQLite write-lock duration. None identifies the holder.

## Static bundle and source-map attribution

The live deployed build contains the matching server bundles and source maps:

| Bundle | Generated shape | Source map | Direct `$transaction` literal in route TypeScript |
| --- | --- | --- | --- |
| `app/api/videos/fetch-stock/route.js` | 73 generated lines; line 72 is a 90,650-byte bundled line | present, 608,096 bytes, 92 sources with `sourcesContent` | no |
| `app/api/videos/jobs/route.js` | 2 generated lines; line 1 bundles the route | present, 513,816 bytes, 106 sources with `sourcesContent` | no |

The production diagnostic intentionally emits a generated **line** but omits its generated column. That means the source map verifies the route bundle, but cannot select one original expression from either very large generated line. The map therefore cannot turn either event into a specific business operation.

Static source still narrows the safe candidate set without asserting an owner:

- The fetch-stock route has no direct interactive transaction. It can reach transactional credit/funding paths during selected AI-image flows, while its `walletFundingForCurrentRequest` call is a read at route line 3402. The deployed fetch-stock source map contains direct transaction callsites in `src/lib/mcp/video-job-funding.ts` at lines 167, 296, and 335, and `src/lib/minute-credits.ts` at lines 192 and 228. Which one, if any, was active in these requests cannot be recovered from the line-only stack provenance.
- The jobs route also has no direct interactive transaction. It can call `createVideoJob` at route lines 297, 415, and 1036; that helper's transaction creates the durable job and may reserve funding. Its deployed bundle also includes transactional code in `runpod-image-cost.server.ts:208`, `brand-assets.server.ts:342,382`, and `editor-projects.ts:248,350`. The source map cannot choose among those operations for the `route.js:1` event.

This establishes that `fetch-stock/route.js:72` and `jobs/route.js:1` are bundled caller provenance only. It refutes interpreting either route label, the 20-second callback, or the 30-second pre-entry delay as the SQLite lock holder.

## Feedback-loop status and smallest next measurement

There is no red-capable loop for the actual holder. The deployed verifier's disposable one-connection SQLite contention case proves that `beforeCallbackMs` and `callbackMs` separate two phase shapes, but it deliberately does not identify a production lock holder. Static maps and completed log lines cannot reconstruct a lock that no longer exists. Per the diagnosing-bugs loop, no holder hypothesis or production fix is justified from this evidence.

The next measurement candidate has two privacy-safe parts. Validate its lock interpretation on a disposable WAL database before adding production instrumentation:

1. Preserve the generated stack **column** with the existing static route/line provenance, so the deployed source map can recover the exact original static callsite instead of an entire bundled line.
2. When an in-flight transaction crosses the slow threshold, inspect `/proc/locks` for the actual WAL database and shared-memory inodes and relevant lock-byte ranges, map the engine PID only to its PM2 app/process class, and retain content-free numeric/static evidence. Prove with a known disposable holder that the observed range represents the writer lock; an arbitrary SQLite lock entry is insufficient. No SQL, customer IDs, paths, request contents, or environment values are needed.

The snapshot must happen while the transaction is still slow; tailing the current completion-only log cannot recover a past holder. A bounded on-host watcher or threshold timer could provide that timing, but neither was started during this read-only evidence pass. Even a validated holder PID identifies only a process: a waiting call's source map does not establish the holder's business operation, particularly when several transactions share one process. Exact operation attribution still needs independently correlated in-flight transaction evidence. No approval question is required for the reversible local validation already within the authorized diagnosis scope.

## Decision

Keep HERO-10 in progress. The post-release offset has four natural slow transactions and no concurrent Socket timeout, `P1008`, `P2028`, SQLite busy, closed-transaction, OOM, or `OUTPUT_INVALID` marker. It is too early for the seven-day acceptance window, and it does not establish a holder. No production code change follows from this observation.
