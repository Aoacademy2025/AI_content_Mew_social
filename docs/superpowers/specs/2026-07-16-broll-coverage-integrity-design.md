# B-roll Coverage Integrity Design

**Date:** 2026-07-16

**Status:** Approved in conversation; written-spec review pending

## Problem

Window mode creates one semantic B-roll window roughly every four seconds. The stock pipeline independently caps per-window downloads at 36 assets. When a video needs more than 36 windows, `fetch-stock` returns only 36 assets and `generate-config` maps them to only the first 36 windows. Its gap filler then stretches the final asset to the end of the audio, even when that requested span is much longer than the asset can play.

The render route probes the real file and shortens overlong segments to a safe duration. It repairs gaps only between existing segments, not the uncovered tail after the final segment. Remotion therefore renders the composition's black background for the remainder while the job still finishes as `DONE`.

The confirmed production case requested 53 windows for a 278.44-second video, received 36 assets, stretched the last asset to 95.88 seconds, and then clamped it to 17.30 seconds. The base render was black from 198.23 seconds through the end.

## Goals

- Every successful short-video render has playable B-roll coverage from frame 0 through the full composition duration, except the intentional end fade.
- Window cadence and the number of distinct downloaded assets are separate concerns. A capped asset pool may be reused without dropping windows.
- No emitted segment requests more playable time than its source can provide.
- Asset probing cannot turn a previously complete timeline into an incomplete successful render.
- A job that cannot produce complete coverage fails explicitly instead of returning a black-tail video as `DONE`.
- Production telemetry exposes requested windows, available assets, coverage ratio, repaired gaps, and uncovered tail duration.
- The existing `duckyhero` preview can be re-rendered from retained assets after rollout without generating new AI images.

## Non-goals

- Removing the 36-asset safety cap without a separate load and cost study.
- Changing subtitle timing, avatar composition, BGM behavior, or the four-second target cadence.
- Re-ranking all stock search results or redesigning the B-roll editor UI.
- Automatically rewriting historical exported videos during the code rollout.

## Considered Approaches

### 1. Raise the asset cap

Raising the cap to the maximum possible number of windows would fix this particular 53-window job, but it increases search, download, normalization, render, and AI-generation costs. It also leaves the same correctness bug for any video that exceeds the new cap. This is not the selected solution.

### 2. Stretch or loop only the final asset

Looping the final clip would hide the black tail, but it would show one unrelated visual for a long period and would not repair internal gaps or missing middle windows. It also keeps the planner and renderer coverage models inconsistent. This is acceptable only as a last-resort renderer fallback, not as the primary assignment model.

### 3. Tile all windows from a capped pool, then validate after probing

This is the selected approach. The planner assigns an asset to every requested window, reusing the capped pool when necessary. A shared coverage utility splits overlong spans so each emitted segment stays within the asset's playable duration. The render route runs the same coverage repair after it knows actual file durations, then enforces a full-coverage invariant before enqueueing the render.

For quality, representative source assets are distributed across the entire window list rather than allowing the tail to receive no candidates. Explicit window ordinals remain available so repeated or identical keyword text cannot corrupt ordering.

## Architecture

### Pure coverage module

Create `src/lib/broll-coverage.ts` as the single owner of timeline tiling and validation.

It consumes:

- ordered target spans in seconds;
- an ordered pool of playable assets with `src`, `clipDuration`, `clipOffset`, and optional metadata;
- composition duration and FPS.

It produces:

- normalized `BrollVideo[]` covering the target duration;
- coverage metrics including first start, effective end, gap count, repaired segment count, and uncovered tail seconds.

The module must:

- sort and clamp target spans to the composition duration;
- assign every target span an asset, cycling through a smaller pool;
- split a target span when the assigned asset cannot play for its full length;
- reset or wrap clip offsets without requesting past the playable duration;
- keep segments contiguous to within one frame;
- preserve source metadata on every generated segment;
- reject an empty pool or a non-positive duration;
- never silently claim complete coverage when the invariant fails.

### Config generation

Window mode in `generate-config` will pass all B-roll windows and the returned stock pool to the pure coverage module. It will no longer use `Math.min(brollWindows.length, pool.length)` or extend one final asset across the missing tail.

Legacy scene-aware and even-split paths will keep their assignment behavior, but their final output will pass through the same validation so every path shares the successful-render invariant.

### Render asset resolution

The render route will continue probing local files and calculating conservative playable durations. After probing, it will call the pure coverage module to repair any gaps introduced by shorter real durations, including a missing final tail.

If complete coverage cannot be constructed from at least one usable asset, the route throws a typed, user-safe coverage error before creating or enqueueing a render job. It must not return `DONE` for an incomplete timeline.

### Representative asset selection

The download cap remains 36 by default. When more window candidates exist than the cap, selection will use evenly distributed window indices across the full list instead of taking only the first 36. Returned stock results will carry their originating window ordinal. Config generation will use ordinals when available and fall back to deterministic cycling for older callers and cached payloads.

This keeps later sections represented without requiring more distinct downloads. All render windows still exist; the capped pool is reused as needed.

### Telemetry

Add or extend server telemetry with:

- `requestedWindowCount`;
- `availableAssetCount`;
- `distinctAssetCount`;
- `coverageSegmentCount`;
- `coverageGapCount`;
- `coverageRepairCount`;
- `coverageRatio`;
- `uncoveredTailSec`;
- `coverageRejected`.

Do not include script text, stock URLs, user email, or provider secrets.

## Data Flow

1. Captions are grouped into ordered four-second windows.
2. Keyword extraction produces one keyword unit per window.
3. `fetch-stock` selects at most 36 representative source units across the whole window list and returns assets with their source ordinals.
4. `generate-config` assigns the available pool across every target window and splits spans that exceed playable metadata duration.
5. The render route resolves URLs and probes actual durations.
6. Coverage is repaired using the probed durations.
7. The route validates that effective coverage tiles `[0, duration]` within one frame.
8. Only a valid payload is enqueued and allowed to finish as `DONE`.

## Error Handling

- No usable assets: retain the existing Thai no-stock error.
- Invalid or zero composition duration: reject as a non-retryable configuration error.
- Coverage cannot reach the end despite a non-empty pool: throw a typed coverage error containing only counts and durations.
- Missing individual asset: remove it from the pool, repair with remaining assets, and emit repair telemetry.
- Coverage repair succeeds: render normally and record repair metrics; do not surface a user error.
- Coverage validation fails after repair: do not render and do not charge or retain a completed result.

## Testing

### Pure regression tests

- The production-shaped fixture `278.439s / 53 windows / 36 assets` covers the full duration with no gap over one frame.
- A window longer than its asset is split across playable segments.
- One asset can tile a longer composition without any segment exceeding its playable duration.
- Missing middle and final assets are repaired deterministically.
- Repeated keywords do not change source ordering when ordinals are present.
- Empty pools and invalid durations return explicit failure results.

### Pipeline tests

- The orchestrator passes 53 windows through even when stock returns only 36 assets.
- Fetch-stock cap selection includes the first and final window regions.
- Generate-config never emits a single 95-second segment backed by a 17-second asset.
- Render resolution still covers the full duration after probe durations shorten multiple assets.
- Incomplete coverage cannot enqueue a render job or reach `DONE`.

### Artifact verification

- Re-run the original deterministic production-artifact harness.
- Render a local fixture and run `ffmpeg blackdetect` to prove no unintended black tail remains.
- Re-run existing B-roll, preview-mode, render-queue, and editor-project verifiers.

## Rollout and Recovery

1. Deploy the code with telemetry enabled and the asset cap unchanged.
2. Run a production canary render longer than 200 seconds and verify full payload coverage before inspecting the artifact.
3. Re-render the current `duckyhero` base preview from retained assets and update the project only after black-tail verification passes.
4. Query the existing payload audit for jobs with more than one second of uncovered tail. Prioritize the 29 severe jobs over ten seconds and notify or offer re-render rather than silently replacing user exports.
5. Monitor coverage rejection and repair counts for at least one full day before considering any cap or concurrency change.

## Success Criteria

- The 53-window/36-asset regression is red before the fix and green afterward.
- Effective B-roll coverage ends within one frame of the composition end for every successful test fixture.
- No segment exceeds its source's playable duration.
- The original black-tail reproduction no longer detects a tail caused by missing B-roll coverage.
- Existing relevant verifiers, lint, type/build checks, and the production canary pass.
- No AI image generation is required to repair the current retained-asset preview.
