# Task 3 — Safe recovery and explicit Editor actions

## Delivered

- The writing page starts blank and performs one lightweight recent-draft summary request. Recovery is explicit; opening a library row fetches its full owned detail only then, and only the newest detail response may replace the workspace.
- `ScriptEditorStep` remains mounted across tabs and exposes the existing save owner through a small imperative boundary. New script, record replacement, generation replacement, deletion, and handoff await the latest serialized snapshot. A failed save keeps the exact text, shows the required failure state, blocks handoff, and offers retry, cancel, or explicit discard where replacement was requested.
- Pre-generation topic/Hook work prompts only for destructive new/open actions. Cancel preserves it exactly; discard creates no blank Script row. Ordinary tab changes never prompt.
- Sent scripts distinguish navigation-only “เปิดงานตัดต่อเดิม” from explicit “สร้างงานตัดต่อใหม่”. The latter suppresses duplicate clicks and never retries an ambiguous POST. Missing, archived, or foreign linked projects return an honest unavailable state from the owned detail route.
- Integrated `ScriptLibrary`, removed the temporary legacy `ScriptHistory`, retained its search/filter/page state while hidden, refreshed it only on the next relevant visit, and invalidated racing detail/delete responses without clearing a newer writer.
- Hook/body/CTA editors render at 16px, and the mounted fixture verifies no horizontal page overflow at 320px.

## RED → GREEN evidence

The existing mounted fixture passed before the Task 3 assertion. After adding a fictional `status=draft&pageSize=1` response and asserting the explicit shortcut, this command failed after five seconds because “ทำร่างล่าสุดต่อ” did not exist:

```text
npx tsx scripts/verify-hero-script-workspace-browser.mts
TimeoutError: Waiting failed: 5000ms exceeded
```

The same mounted seam is now green and covers explicit recovery, delayed profile preferences, retained tab state, pre-generation cancel/discard for new and open, delayed/failing serialized saves, latest-content handoff, duplicate-click suppression, zero-POST existing-project navigation, missing projects, stale detail responses, delete/restore races, legacy/published profile controls, and 320px text/overflow behavior.

## Scoped checks

- `npx tsx scripts/verify-hero-script-workspace.ts` — PASS
- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `npm run verify:hero-script-library` — PASS
- `npx tsc --noEmit --pretty false` — PASS
- Scoped ESLint for the owned page, editor, library/state, detail route, and both workspace verifiers — PASS
- `git diff --check` — PASS

## Limits

The fixture uses fictional local records and provider-free responses; it performs no production writes or billable generation. Full build, broader Hero Script suites, authenticated real-route browser coverage, and fresh branch/security review remain Task 4. A late guide-preference assertion initially read storage before the native `toggle` event completed; waiting for that public effect made the fixture deterministic and required no product change.
