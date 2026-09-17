# Final correctness re-review

Base: `edb2fd09`  
Head: `9d4293c5`

## Verdict

**Focused fixes: PASS. Final branch: BLOCK.**

The two reported paths are corrected. `saveLatest()` now drains snapshots added while an awaited save is in flight and returns false when a newer follow-up write fails; the mounted cases cover New, row open and create-new handoff. Active and library “เปิดงานตัดต่อเดิม” actions now use the page save/discard guard and retain zero handoff POSTs. The added active-editor handoff owner rejects stale generation, regeneration, handoff success, failure and finalizers.

## Blocking finding

1. **[medium, high confidence] Library create-new for a non-active row still bypasses the workspace and handoff owner.** `page.tsx:252-272` uses the guarded editor path only when `draftRef.current?.id === item.id`; every other library “สร้างงานตัดต่อใหม่” directly POSTs and navigates. If another Script has a pending autosave, or the writer contains a pre-generation topic/Hook, this navigation can lose that workspace without save/discard handling. It also does not invalidate or share ownership with an active editor handoff, so switching to the library during that POST can start a second non-idempotent handoff and leave two responses able to navigate. The focused verifier covers active create-new and library open-existing, but not library create-new while another workspace/handoff is active. Route this action through the same page-level guard and one handoff owner; add pending-save, unsaved-brief and competing-handoff mounted cases.

## Independent verification

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `git diff --check edb2fd09..9d4293c5` — PASS

The complete suite/build already recorded after this commit were not repeated.
