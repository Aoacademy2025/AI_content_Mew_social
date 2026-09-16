# Final correctness review

Baseline: `8e7089f3`  
Head: `edb2fd09`  
Task 4 diff: `0ca3d4c8..edb2fd09`

## Verdict

**Task 4 scoped review: PASS. Whole-branch correctness: BLOCK.**

The Task 4 production fix correctly suppresses stale list/empty content while a library error is active. Its mounted check exercises the real client component with compiled application CSS, modeled dashboard offsets, exactly 20 fictional profiles and 500 fictional scripts. Independent runs of the mounted browser verifier and isolated SQLite library verifier passed.

## Blocking findings

1. **[medium, high confidence] `saveLatest()` can return success before the latest visible edit is saved.** In `ScriptEditorStep.tsx:189-248`, `persist()` captures one snapshot, writes it, then returns `true` even when `draftRef.current` changed during the request; line 242 only changes the label to `saving`. Callers treat that `true` as the latest-snapshot guarantee: `page.tsx:212-217` replaces the workspace, and `ScriptEditorStep.tsx:451-462` creates the Editor project. Because textareas stay editable during the request, an edit made after the request starts can be discarded by New/open, or the handoff can use the older saved text before navigation cancels the pending debounce. This violates AC7 and the global latest-text contract. Make the awaited operation continue through the newest serialized snapshot (or otherwise prevent/resolve concurrent edits) before returning success. Add mounted delayed-response cases that type again after replacement/handoff begins.

2. **[medium, high confidence] “Open existing project” bypasses pending-save and unsaved-brief protection.** The active editor button navigates directly at `ScriptEditorStep.tsx:621-624`, and library rows use a direct `Link` at `ScriptHistory.tsx:348-355`. Opening either while the 1.2-second autosave is pending can unmount the save owner and lose the latest Script edit; opening from the library can also abandon an unsaved pre-generation topic/Hook without the discard decision. The zero-handoff-POST test opens without a pending edit, so it misses this path. Route project navigation through the page owner’s save/discard guard while retaining zero handoff POSTs, and cover success/failure plus pre-generation input.

## Advisory / evidence limits

- The QA report accurately records that this is a real-CSS/client fixture with faithful shell dimensions, not authenticated end-to-end browser coverage. Separate isolated owner/access regressions make that limitation acceptable for this review.
- Chromium headless did not prove keyboard mutation of the native status select. The remaining Tab/Enter/typeahead path passed, and the limitation is stated rather than presented as verified.
- `acceptance-evidence.md` should not retain AC7 as PASS until both blockers above are fixed and independently rechecked.

## Independent verification

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `npm run verify:hero-script-library` — PASS
- `git diff --check 8e7089f3...edb2fd09` — PASS

The already-passing full suite and build were not repeated.
