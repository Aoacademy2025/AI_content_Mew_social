# Final library handoff correctness re-review

Base: `9d4293c5`  
Head: `ae2d3deb`

## Verdict

**BLOCK.** The remaining caller is correctly page-owned: non-active library create-new now uses current-workspace save/discard handling, all editor/library create actions share one POST gate, and invalidation keeps that gate until the old request settles. Focused mounted verification passed the pending-save, pre-generation, competing-click, New/open, one-POST and stale-navigation cases.

## Blocking finding

1. **[medium, high confidence] A failed handoff save can still create a project from stale text through “ทิ้งแล้วไปต่อ”.** `requestWorkspaceAction()` stores the failed `{ kind: "handoff" }` at `page.tsx:295-298`. The shared dialog always renders its discard action at `page.tsx:438-443`, which calls `executeWorkspaceAction()` directly; that handoff branch POSTs without another save at `page.tsx:230-265`. This contradicts the binding rule that a failed save must not create a project from stale content. The mounted failure cases cancel or retry, so they do not exercise this button. For a save-failed handoff, remove/disable discard-and-send (or return to the workspace without POST) and add active and non-active library assertions that clicking every available recovery action cannot POST stale content.

## Independent verification

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `git diff --check 9d4293c5..ae2d3deb` — PASS

The already-passing complete suite and build were not repeated.
