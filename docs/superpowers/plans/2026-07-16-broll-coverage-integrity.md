# B-roll Coverage Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent successful renders from containing an unintended black tail when B-roll windows outnumber distinct assets or probed media is shorter than planned.

**Architecture:** Add one pure coverage module that assigns a capped asset pool across every requested window, splits spans to remain within playable media, summarizes coverage, and rejects incomplete timelines. Use it in config generation and again after render-time media probing. Preserve semantic quality by carrying source-window ordinals and selecting capped assets evenly across the full timeline.

**Tech Stack:** TypeScript, Next.js route handlers, Remotion 4, Prisma/SQLite telemetry, `tsx` verifier scripts, FFmpeg/FFprobe.

## Global Constraints

- Keep the default distinct-asset cap at 36.
- Keep the configured B-roll window cadence at four seconds.
- Do not change subtitle timing, avatar composition, BGM behavior, quota charging, or export naming.
- A successful render must cover `[0, durationSec]` within one frame after real media probing.
- No emitted segment may request more playable time than its source provides.
- Telemetry must not include script text, stock URLs, email addresses, API keys, or provider secrets.
- Follow red-green-refactor for every production behavior change.

---

## File Structure

- Create `src/lib/broll-coverage.ts`: pure assignment, splitting, repair, metrics, and representative-selection helpers.
- Create `scripts/verify-broll-coverage.ts`: production-shaped pure regression verifier.
- Modify `src/app/api/videos/generate-config/route.ts`: assign all windows and enforce the coverage result.
- Modify `src/app/api/videos/fetch-stock/route.ts`: carry `sourceIndex` and cap per-window results across the whole timeline.
- Modify `src/app/api/videos/render/route.ts`: retain desired spans after probing, repair from probed assets, reject incomplete coverage, and emit sanitized telemetry.
- Modify `src/remotion/ShortVideoComposition.tsx`: stop re-merging intentionally split same-source segments.
- Modify `src/remotion/types.ts`: allow optional `sourceIndex` metadata on B-roll items.
- Modify `scripts/verify-preview-mode.ts`: lock the 53-window/36-asset orchestrator contract.
- Modify `scripts/verify-broll-windows.ts`: retain cadence/window tiling coverage.
- Modify `package.json`: add a stable `verify:broll-coverage` command.

---

### Task 1: Pure coverage module

**Files:**
- Create: `scripts/verify-broll-coverage.ts`
- Create: `src/lib/broll-coverage.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `BrollVideo` from `src/remotion/types.ts`.
- Produces:
  - `coverBrollTimeline(desired, pool, durationSec, fps): BrollCoverageResult`
  - `assignBrollWindows(windows, pool, durationSec, fps): BrollCoverageResult`
  - `selectRepresentativeItems(items, limit): items`
  - `BROLL_SEQUENCE_GUARD_FRAMES`
  - `BrollCoverageMetrics` and `BrollCoverageResult`.

- [ ] **Step 1: Write the failing production-shaped verifier**

Create `scripts/verify-broll-coverage.ts` with assertions that describe the intended API:

```ts
import assert from "node:assert/strict";
import {
  BROLL_SEQUENCE_GUARD_FRAMES,
  assignBrollWindows,
  coverBrollTimeline,
  selectRepresentativeItems,
} from "../src/lib/broll-coverage";

const durationSec = 278.439;
const fps = 30;
const windows = Array.from({ length: 53 }, (_, i) => ({
  startMs: (durationSec * 1000 * i) / 53,
  endMs: (durationSec * 1000 * (i + 1)) / 53,
}));
const pool = Array.from({ length: 36 }, (_, i) => ({
  src: `/asset-${i}.mp4`,
  start: 0,
  end: 0,
  clipOffset: 0,
  clipDuration: i === 35 ? 17.3 : 4.5,
  sourceIndex: i,
}));

const assigned = assignBrollWindows(windows, pool, durationSec, fps);
assert.equal(assigned.complete, true);
assert.ok(assigned.segments.length >= windows.length);
assert.ok(Math.abs(assigned.metrics.effectiveEndSec - durationSec) <= 1 / fps);
assert.equal(assigned.metrics.gapCount, 0);

const guardSec = BROLL_SEQUENCE_GUARD_FRAMES / fps;
for (const seg of assigned.segments) {
  assert.ok(seg.end - seg.start <= (seg.clipDuration ?? 10) - (seg.clipOffset ?? 0) - guardSec + 1e-6);
}

const one = coverBrollTimeline(
  [{ src: "/one.mp4", start: 0, end: 30, clipOffset: 0, clipDuration: 5 }],
  [{ src: "/one.mp4", start: 0, end: 0, clipOffset: 0, clipDuration: 5 }],
  30,
  fps,
);
assert.equal(one.complete, true);
assert.ok(one.segments.length > 1);

const selected = selectRepresentativeItems(Array.from({ length: 53 }, (_, i) => i), 36);
assert.equal(selected.length, 36);
assert.ok(selected[0] <= 1);
assert.ok(selected[selected.length - 1] >= 51);

const empty = coverBrollTimeline([], [], 30, fps);
assert.equal(empty.complete, false);
assert.ok(empty.metrics.uncoveredTailSec >= 30 - 1 / fps);

console.log("All broll-coverage checks passed.");
```

- [ ] **Step 2: Run the verifier and confirm RED**

Run:

```bash
npx tsx scripts/verify-broll-coverage.ts
```

Expected: failure because `src/lib/broll-coverage.ts` does not exist. This proves the verifier targets the new seam.

- [ ] **Step 3: Implement the minimal pure module**

Create `src/lib/broll-coverage.ts`. The implementation must:

```ts
import type { BrollVideo } from "@/remotion/types";

export const BROLL_SEQUENCE_GUARD_FRAMES = 10; // 8 crossfade + 2 decoder end guard

export type BrollCoverageAsset = BrollVideo & { sourceIndex?: number };
export type BrollCoverageWindow = { startMs: number; endMs: number };
export type BrollCoverageMetrics = {
  requestedSpanCount: number;
  availableAssetCount: number;
  outputSegmentCount: number;
  repairedSegmentCount: number;
  gapCount: number;
  coveredSec: number;
  effectiveEndSec: number;
  uncoveredTailSec: number;
  coverageRatio: number;
};
export type BrollCoverageResult = {
  segments: BrollCoverageAsset[];
  metrics: BrollCoverageMetrics;
  complete: boolean;
};

export function selectRepresentativeItems<T>(items: T[], limit: number): T[] {
  const count = Math.max(0, Math.min(items.length, Math.floor(limit)));
  if (count === 0) return [];
  if (count === items.length) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / count)]);
}
```

`coverBrollTimeline()` must normalize the pool, walk desired spans in time order, fill leading/internal/final gaps, split every interval at `clipDuration - clipOffset - BROLL_SEQUENCE_GUARD_FRAMES / fps`, reset exhausted single assets to offset zero, cycle through the pool, and stop with `complete=false` if a full pass finds no playable asset. It must compute union coverage metrics using a one-frame tolerance.

`assignBrollWindows()` must select the exact `sourceIndex` match when present, otherwise the nearest indexed asset, otherwise deterministic `windowIndex % pool.length`, then delegate to `coverBrollTimeline()`.

- [ ] **Step 4: Add the package command and verify GREEN**

Add to `package.json`:

```json
"verify:broll-coverage": "tsx scripts/verify-broll-coverage.ts"
```

Run:

```bash
npm run verify:broll-coverage
```

Expected: `All broll-coverage checks passed.` and exit 0.

- [ ] **Step 5: Refactor names only while staying green**

Run the verifier again after any cleanup. Do not add route behavior in this task.

- [ ] **Step 6: Commit**

```bash
git add src/lib/broll-coverage.ts scripts/verify-broll-coverage.ts package.json
git commit -m "test: define b-roll coverage invariant"
```

---

### Task 2: Window config assigns every requested span

**Files:**
- Modify: `scripts/verify-broll-coverage.ts`
- Modify: `src/app/api/videos/generate-config/route.ts`
- Modify: `src/remotion/types.ts`

**Interfaces:**
- Consumes: `assignBrollWindows()` and `coverBrollTimeline()` from Task 1.
- Produces: complete `config.bgVideos` for every generate-config path and optional `sourceIndex` on `BrollVideo`.

- [ ] **Step 1: Extend the failing verifier**

Add a source test that reads `generate-config/route.ts` and rejects the old truncation:

```ts
import fs from "node:fs";
const configSource = fs.readFileSync("src/app/api/videos/generate-config/route.ts", "utf8");
assert.ok(!configSource.includes("Math.min(brollWindows.length, pool.length)"));
assert.ok(configSource.includes("assignBrollWindows("));
assert.ok(configSource.includes("coverBrollTimeline("));
```

- [ ] **Step 2: Run and confirm RED**

Run `npm run verify:broll-coverage`.

Expected: assertion failure because the route still truncates at the smaller count.

- [ ] **Step 3: Add `sourceIndex` to the Remotion type**

In `src/remotion/types.ts`, extend `BrollVideo` with:

```ts
sourceIndex?: number;
```

- [ ] **Step 4: Replace window truncation with complete assignment**

Import Task 1 helpers. Replace the window-mode loop with:

```ts
const assigned = assignBrollWindows(brollWindows, validStocks.map((sv) => ({
  src: (sv.localUrl ?? sv.videoUrl) as string,
  start: 0,
  end: 0,
  clipOffset: 0,
  clipDuration: sv.duration > 0 ? sv.duration : 10,
  sourceIndex: sv.sourceIndex,
  keyword: sv.keyword,
  title: sv.title,
  query: sv.query,
  provider: sv.provider,
  contentProfile: sv.contentProfile,
  selectionReason: sv.selectionReason,
  relevanceScore: sv.relevanceScore,
})), audioDurationSec, fps);
bgVideos.push(...assigned.segments);
```

After legacy normalization, call `coverBrollTimeline(bgVideos, bgVideos, audioDurationSec, fps)` and reject an incomplete result instead of relying on `fillBgGaps()` to stretch the last clip. Log only counts and numeric metrics.

- [ ] **Step 5: Verify GREEN and existing config tests**

Run:

```bash
npm run verify:broll-coverage
npx tsx scripts/verify-broll-even-split-fallback.ts
npm run verify:broll-windows
npm run verify:broll-spans
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/videos/generate-config/route.ts src/remotion/types.ts scripts/verify-broll-coverage.ts
git commit -m "fix: cover every b-roll window from capped pools"
```

---

### Task 3: Representative capped selection and source ordinals

**Files:**
- Modify: `scripts/verify-broll-coverage.ts`
- Modify: `src/app/api/videos/fetch-stock/route.ts`
- Modify: `src/app/api/videos/generate-config/route.ts`

**Interfaces:**
- Consumes: `selectRepresentativeItems()` from Task 1.
- Produces: `sourceIndex?: number` on `FoundVideo`, `CandidateVideo`, and returned stock results.

- [ ] **Step 1: Add failing source and behavior checks**

Extend the verifier:

```ts
const stockSource = fs.readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
assert.ok(stockSource.includes("sourceIndex"));
assert.ok(stockSource.includes("selectRepresentativeItems"));
```

Retain the first/final representative assertions from Task 1.

- [ ] **Step 2: Run and confirm RED**

Run `npm run verify:broll-coverage`.

Expected: source assertions fail because fetch-stock has no ordinal metadata.

- [ ] **Step 3: Thread ordinals through selection**

Add `sourceIndex?: number` to `FoundVideo`. When candidates are created for keyword index `ki`, attach `sourceIndex: ki`. Preserve it through `addFoundClip()`, AI/photo result objects, cache-hit objects, downloaded result objects, and JSON responses.

For direct KIE generation, replace the leading slice with representative indexed jobs:

```ts
const directJobs = selectRepresentativeItems(
  keywords.map((keyword, sourceIndex) => ({ keyword, sourceIndex })),
  clipsToGenerate,
);
```

For per-subtitle `capFoundClips`, sort by `sourceIndex` and call `selectRepresentativeItems(sorted, limit)` rather than taking the first keyword buckets. Keep the existing bucket behavior for non-per-subtitle calls.

Sort Auto Mix results by `sourceIndex` first, using the existing keyword order only as a legacy fallback.

- [ ] **Step 4: Make config prefer the nearest representative ordinal**

Extend the local `StockVideo` type with `sourceIndex?: number`. `assignBrollWindows()` already chooses exact or nearest ordinals, so no route-specific matching logic is allowed.

- [ ] **Step 5: Verify GREEN and fetch-stock regressions**

Run:

```bash
npm run verify:broll-coverage
npm run verify:broll-cadence
npx tsx scripts/verify-automix-plan.ts
npx tsx scripts/verify-broll-source-quality.ts
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/videos/fetch-stock/route.ts src/app/api/videos/generate-config/route.ts scripts/verify-broll-coverage.ts
git commit -m "fix: spread capped b-roll assets across the timeline"
```

---

### Task 4: Render-time repair after real media probing

**Files:**
- Modify: `scripts/verify-broll-coverage.ts`
- Modify: `src/app/api/videos/render/route.ts`
- Modify: `src/remotion/ShortVideoComposition.tsx`

**Interfaces:**
- Consumes: `coverBrollTimeline()` and `BROLL_SEQUENCE_GUARD_FRAMES` from Task 1.
- Produces: a complete `resolvedShortConfig.bgVideos` or a pre-enqueue coverage error.

- [ ] **Step 1: Add failing render-source checks**

Extend the verifier:

```ts
const renderSource = fs.readFileSync("src/app/api/videos/render/route.ts", "utf8");
assert.ok(renderSource.includes("coverBrollTimeline("));
assert.ok(renderSource.includes("broll_coverage_rejected"));
const compositionSource = fs.readFileSync("src/remotion/ShortVideoComposition.tsx", "utf8");
assert.ok(!compositionSource.includes("last.src === v.src && Math.abs(last.endFrame - startFrame) <= 1"));
```

- [ ] **Step 2: Run and confirm RED**

Run `npm run verify:broll-coverage`.

Expected: render and composition source assertions fail.

- [ ] **Step 3: Preserve desired ends while probing**

In the render route, keep `v.end` as the target span. Probe each asset and reduce `clipDuration` to the conservative `safeMax`, but do not set `safeEnd = v.start + safeMax`.

After all usable assets resolve, call:

```ts
const durationSec = durationInFrames / fps;
const coverage = coverBrollTimeline(resolvedBgVideos, resolvedBgVideos, durationSec, fps);
if (!coverage.complete) {
  await recordTelemetryEvent(userId, {
    name: "broll_coverage_rejected",
    category: "error",
    source: "server",
    step: "render.coverage",
    status: "error",
    properties: coverage.metrics,
  }).catch(() => {});
  throw new Error("B-roll coverage ไม่ครบหลังตรวจไฟล์จริง — กรุณาลองเรนเดอร์ใหม่");
}
```

Use `coverage.segments` in `resolvedShortConfig`. Emit `broll_coverage_repaired` only when `repairedSegmentCount > 0`, with numeric metrics and counts only.

- [ ] **Step 4: Preserve deliberate same-source splits in Remotion**

Remove the adjacent same-source merge in `ShortVideoComposition`. Push each configured segment as its own `Seg` so a reset clip offset is not collapsed back into one overlong `OffthreadVideo`.

Import `BROLL_SEQUENCE_GUARD_FRAMES` and assert in development that its value remains at least `CROSSFADE_FRAMES + 2`, keeping the coverage safety margin aligned with the renderer.

- [ ] **Step 5: Verify GREEN and render queue tests**

Run:

```bash
npm run verify:broll-coverage
npm run verify:render-queue
npm run verify:render-duration-bill
npx tsx scripts/verify-composite-quality.ts
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/videos/render/route.ts src/remotion/ShortVideoComposition.tsx scripts/verify-broll-coverage.ts
git commit -m "fix: repair b-roll coverage after media probing"
```

---

### Task 5: Orchestrator contract and sanitized metrics

**Files:**
- Modify: `scripts/verify-preview-mode.ts`
- Modify: `src/lib/mcp/orchestrator.ts`
- Modify: `src/app/api/videos/generate-config/route.ts`
- Modify: `src/app/api/videos/fetch-stock/route.ts`

**Interfaces:**
- Consumes: coverage metrics from Tasks 1–4.
- Produces: locked 53-window/36-asset behavior and sanitized server telemetry.

- [ ] **Step 1: Add a failing 53-window pipeline case**

In `scripts/verify-preview-mode.ts`, create 141 contiguous captions spanning 278,439ms, enable window mode, stub `fetch-stock` to return 36 short assets, and assert:

```ts
ok((stockBody?.keywords?.length ?? 0) === 53, "long preview requests all 53 semantic windows");
ok((cfgBody?.brollWindows?.length ?? 0) === 53, "config retains all 53 target windows");
ok(((cfgBody?.stockVideos as unknown[])?.length ?? 0) === 36, "config accepts the capped 36-asset pool");
```

- [ ] **Step 2: Run and confirm RED if the stub exposes truncation**

Run:

```bash
npx tsx scripts/verify-preview-mode.ts
```

Expected before completing the route integration: the long-window assertion fails or the config path drops windows.

- [ ] **Step 3: Add numeric telemetry fields**

Record the approved fields at fetch/config/render boundaries:

```ts
{
  requestedWindowCount,
  availableAssetCount,
  distinctAssetCount,
  coverageSegmentCount,
  coverageGapCount,
  coverageRepairCount,
  coverageRatio,
  uncoveredTailSec,
  coverageRejected,
}
```

Reuse existing `recordTelemetryEvent()` calls where possible. Do not add raw windows, filenames, URLs, or user fields.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx tsx scripts/verify-preview-mode.ts
npm run verify:broll-coverage
npm run verify:mcp-parity
npm run verify:subtitle-invariant
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-preview-mode.ts src/lib/mcp/orchestrator.ts src/app/api/videos/generate-config/route.ts src/app/api/videos/fetch-stock/route.ts
git commit -m "test: lock long-video b-roll coverage contract"
```

---

### Task 6: Full verification and production-safe handoff

**Files:**
- Modify only if a verifier exposes an implementation defect.

**Interfaces:**
- Consumes: the complete implementation.
- Produces: fresh evidence for code review and rollout.

- [ ] **Step 1: Run focused B-roll verification**

```bash
npm run verify:broll-coverage
npm run verify:broll-windows
npm run verify:broll-spans
npm run verify:broll-cadence
npm run verify:automix-plan
npx tsx scripts/verify-preview-mode.ts
```

Expected: all exit 0.

- [ ] **Step 2: Run render/orchestrator verification**

```bash
npm run verify:render-queue
npm run verify:render-duration-bill
npm run verify:mcp-parity
npm run verify:editor-projects
```

Expected: all exit 0.

- [ ] **Step 3: Run static checks and production build**

```bash
npx eslint src/lib/broll-coverage.ts src/app/api/videos/generate-config/route.ts src/app/api/videos/fetch-stock/route.ts src/app/api/videos/render/route.ts src/remotion/ShortVideoComposition.tsx scripts/verify-broll-coverage.ts scripts/verify-preview-mode.ts
npm run build
```

Expected: exit 0 with no new errors.

- [ ] **Step 4: Re-run the original deterministic production audit command read-only**

Against the historical artifact, retain the known RED baseline:

```text
duration=278.486s coverage_end=199.864s black_start=198.233s black_tail=80.253s
```

Then reconstruct the historical 53-window/36-asset payload through the new pure module and assert computed coverage reaches 278.439 seconds with zero gaps. Do not modify the production database during this check.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review` with the design spec, this plan, the base SHA before implementation, and final HEAD SHA. Resolve every Critical and Important finding before rollout.

- [ ] **Step 6: Prepare rollout checkpoint**

Report:

- commits and changed files;
- red-green evidence;
- focused verifier results;
- build result;
- historical baseline and repaired-payload coverage result;
- exact production canary and recovery commands.

Do not deploy or rewrite the `duckyhero` project until this evidence is reviewed in the session.

---

## Plan Self-review

- **Spec coverage:** The plan covers capped-pool assignment, complete windows, playable-duration splitting, render-time repair, explicit failure, representative selection, ordinals, telemetry, tests, and recovery handoff.
- **Scope:** One subsystem and one invariant; no subtitle, avatar, billing, or editor redesign is included.
- **Type consistency:** `sourceIndex`, `BrollCoverageResult`, and the three exported helper names are identical across tasks.
- **No placeholders:** Every task has exact files, commands, expected outcomes, and concrete implementation behavior.
