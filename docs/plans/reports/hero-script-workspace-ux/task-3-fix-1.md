# Task 3 fix 1 — Async workspace ownership

## Delivered

- Full-script generation and Hook/body/CTA regeneration now capture a monotonic workspace request token. Topic, duration, profile, Hook, manual section edits, New, and record replacement invalidate that token before changing the workspace.
- Stale success and failure paths return without changing the draft, error/toast state, or the loading state owned by a newer request. Full generation and section regeneration are mutually disabled so starting one operation cannot orphan the other operation's loading state.
- The mounted browser fixture uses held local responses, releases each response only after the tested context change, and waits for the matching request/response. It covers full generation across New/open and topic/duration/profile changes; all three section targets across replacement/reset; stale failures; and stale finalizers while a newer request remains active.

## RED → GREEN evidence

With the delayed full-generation/New assertion added before the product fix, the mounted test failed because the old response populated the reset workspace:

```text
npx tsx scripts/verify-hero-script-workspace-browser.mts
AssertionError [ERR_ASSERTION]: delayed full generation cannot overwrite New
true !== false
```

After the request-token guard and invalidation wiring, the same mounted suite passes:

```text
verify-hero-script-workspace-browser: PASS recovery, save/handoff, and generation/regen workspace ownership races
```

## Scoped checks

- `npx tsx scripts/verify-hero-script-workspace-browser.mts` — PASS
- `npx tsc --noEmit --pretty false` — PASS
- Scoped ESLint for `ScriptEditorStep.tsx`, `page.tsx`, and the mounted browser fixture — PASS
- `git diff --check` — PASS

## Limits

The fixture uses fictional local data and held provider-free responses. It performs no production writes or billable generation. Full build and broader suites remain reserved for Task 4.
