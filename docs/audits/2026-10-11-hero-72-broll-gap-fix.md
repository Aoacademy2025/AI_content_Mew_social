# HERO-72: generated one-frame B-roll gap blocks unrelated edits

Branch: `codex/broll-gap-fix-20261011`.
Baseline: `149efd9647911821ba90f1eede601e141afb2f67` (latest origin/main when created).
Workspace: Orca `broll-gap-fix-20261011`.
Scope: local numeric reproductions and source changes only. No customer media, production writes, deployment, provider calls, or paid generation.

## Reproduction and cause

The sanitized production fixture has 21 windows. Window 19 ends at 88.8 seconds; window 20 starts at 88.83333333333333 seconds. Seven timing edits change other edges and leave this boundary untouched. `mergeWindowEdits` rejected every timing edit because it checked every boundary for exact millisecond continuity. HERO-21's previous floating-point fixture passes because its difference is only representation error; this is a real frame.

Minimal audit reproduction (three windows, an unrelated shared-boundary edit): exit **1**, `AssertionError: Editing an unrelated shared boundary should not be blocked by an existing generated one-frame gap`. Returned error: `เส้นแบ่ง B-roll ต้องต่อเนื่องและห้ามซ้อนกัน`.

Ranked hypotheses before probing: last-window shortening; separately rounded starts/durations; editor milliseconds conversion. The saved source already disproves editor conversion as the origin. Inspection and a local numeric probe isolated a coverage-policy mismatch: `coverBrollTimeline` → `makeTargets` fills gaps only when greater than one frame, but previously retained `Math.max(cursor, span.start)` for smaller gaps. `summarizeCoverage` consequently reports complete=true, gapCount=0 and coverageRatio=1 even while emitted geometry contains the one-frame hole. The probe with end=88.8/start=88.83333333333333 reproduces this exact output. Both generate-config and render preparation use that helper.

This establishes the source acceptance/emission defect. It does not claim to reconstruct every earlier stock-selection operation that first supplied the gap; no media is needed to reproduce the erroneous accepted output.

Permanent regression: `scripts/verify-broll-source-frame-gap.ts`, using the sanitized 21-window source and all observed edits. Before implementation:

- `npx tsx scripts/verify-broll-source-frame-gap.ts legacy`: exit **1**, `an untouched generated frame gap must not veto valid shared-boundary edits`.
- `npx tsx scripts/verify-broll-source-frame-gap.ts generation`: exit **1**, `generation must emit a shared boundary at 20`; actual 88.83333333333333, expected 88.8.

Reviewers can reproduce RED on baseline by copying only the new regression script into a baseline worktree and running those commands. It imports only existing pure helpers and uses no database or network.

## Fix

1. `src/lib/broll-coverage.ts`: emit each target at the shared cursor. Larger gaps still receive repair targets; <= one-frame gaps extend the next target backward, subject to the existing playable-duration/splitting checks. Timeline-aligned presenters continue to use the target's timeline time as clipOffset. No frame-rate support, gap metric threshold, probe margin, duration, audio, or caption policy changes.
2. `src/lib/broll-rerender.ts`: accept only an unchanged legacy gap whose two stored edges lie on consecutive 30fps ticks. Thirty fps is the existing editor/orchestrator render rate. Both merged edges must exactly equal their source values; no editor-provided geometry can create, move, or resize a gap through this exception. The tiny frame-tick epsilon addresses numeric representation only. Arbitrary gaps, non-frame-aligned gaps and overlaps still fail. Existing strict shared-boundary tolerance is unchanged.
3. The new regression is imported by the existing boundary-drift verification, so `verify:broll-timeline` and the existing CI window-management path execute it without package/CI ownership changes.

Legacy config geometry remains unchanged during merge, including its one-frame gap. This avoids silently changing stored source playback or boundary ownership when the customer edits elsewhere; the render coverage stage fills the accepted hole using its existing playback safeguards. The preexisting gap itself can be repaired by an explicit two-sided boundary edit. This change does not redesign the editor UI or make that old gapped pair directly draggable; the existing drag helper still requires a shared edge. Newly generated configs have a shared edge.

The merge copies only requested window fields, preserves array ordering, sources, source indices, clip offsets/durations, untouched edges, first start and final end, and never mutates its input. The orchestrator continues copying narration, captions, duration and QA evidence from the original preview unchanged.

## Verification

All commands run locally in this workspace:

| Command | Exit | Evidence |
| --- | --- | --- |
| `npx tsx scripts/verify-broll-source-frame-gap.ts` | 0 | Complete 21-window fixture; generation→merge; identity/outer bounds/immutability; 24/30/50/60fps generation; presenter playback clock; changed/new frame gaps, arbitrary gaps and overlaps rejected |
| Original audit reproduction after fix | 0 | Same unrelated shared edit succeeds; temporary copied harness removed after verification |
| `npm run verify:broll-timeline` | 0 | Timeline drag rules, new frame-gap fixture, old HERO-21 regression |
| `npm run verify:broll-coverage` | 0 | Coverage/playable-media invariants and render-route checks |
| `npm run verify:broll-rerender` | 0 | 146 merge/source-binding checks, staged preview, scene reroll Apply |
| `npx eslint src/lib/broll-coverage.ts src/lib/broll-rerender.ts scripts/verify-broll-source-frame-gap.ts scripts/verify-broll-boundary-drift.ts` | 0 | No output |
| `npx tsc --noEmit --incremental false` | 0 | No output |
| `git diff --check` | 0 | No whitespace errors |

The final added one-sided exact-frame guards were rechecked by `npm run verify:broll-timeline` (exit 0). Dependencies are an ignored symlink to the existing October 7 operator worktree installation; no dependency mutation was required. Full application build and independent review remain the coordinator's integration gates. No PR opened by this worker.
