# Support-Branches Must-Fix Execution — 2026-07-27

Source of truth for findings: `docs/audits/2026-07-26-support-branches-audit.md` (IDs H1-H8, M1-M20 referenced below).
Approved by Mew 2026-07-27 ("approve ตามที่แนะนำเลย"). Decisions locked:
- H7 fade → option ก: fade in live preview (client-side), export unchanged
- H6 warning → accept silence; primary fix = H5 replay filter
- M9 → strip `enabled` from logo-preset apply (respect current toggle)
- H8 layers B-roll/Background toggle → **deferred to new ticket** (no new feature in this round); tickets `bghxue2g`/`0hwfuq6b` stay open

## Execution Directive
| # | Task (branch) | Agent | Mode | Blocked by | Review gates |
|---|---|---|---|---|---|
| 1 | support-fixes: H5 legacy replay in-flight filter + P2002, M12 harness green + wire verify scripts into package.json + CI, F5 merge test cases | mew-worker-heavy | subagent | — | verify runner, mew-reviewer |
| 2 | history: H4 undo wiring + type guard, M6 empty-card skip in renderSubtitle (preview=export both skip), M4 mobile editingIdx clear, M5 add-card disabled state + honest toast | mew-worker | subagent | — | verify runner, mew-reviewer |
| 3 | broll: H1 empty-ranges → skip composite + fail-closed route, H2/H3 deterministic legacy reconstruct (buildBrollWindows+planCutaway), M3 block AI-gen on hidden window | mew-worker-heavy | subagent | — | verify runner, mew-reviewer |
| 4 | fade: H7ก preview fade (CSS/JS opacity on avatar overlay video per fade windows), M10 indicator only where fade real (exclude cutaway), B-13 mobile hint | mew-worker | subagent | — | verify runner, mew-reviewer |
| 5 | presets: M1 clear per-card overrides on subtitle apply, M2 result-aware toast, M9 strip enabled on logo apply | mew-worker | subagent | — | verify runner, mew-reviewer |
| 6 | wheel: M7 drag/scrub guard, wire verify script into package.json | mew-worker | subagent | — | verify runner, mew-reviewer |
| 7 | Verify runner: per fixed branch — tsc vs baseline, branch verify scripts, prod build (broll+fade) | mew-worker | subagent | 1-6 | session gate |
| 8 | Tier-1 reviews (6, parallel) | mew-reviewer | subagent | 7 | session final gate |

## Acceptance Criteria
- [ ] Each branch: fixes committed on its own branch (no push, no main), tsc 0 new errors vs base `b968afc91`
- [ ] support-fixes: legacy replay returns NEW job after terminal-status duplicate; harness + verify green and wired into package.json + CI
- [ ] history: Timeline Undo works; empty-text cards render nothing in preview AND export; mobile follow survives add-card; add-card button disabled with reason when insert impossible
- [ ] broll: cutaway all-windows-broll produces b-roll video (no person-fullscreen); legacy cutaway edit preserves person layout; AI-gen blocked on hidden windows
- [ ] fade: live preview shows fade matching export windows in full/bookend/bookend-both; cutaway shows no fade indicator
- [ ] presets: apply changes visible result or toasts an error — never silent no-op with success toast
- [ ] Production build passes on broll + fade tips after fixes

## Out of scope
- Layers H8 (b-roll/background toggle) — new ticket; integration-commit items (B-1 visible prop, b-roll eye-button UX, B-12 recovery-prompt check) — done at merge time per audit §E-10; End Scene; all Can-defer findings (M14-M20, Lows)

## Status
interviewed 2026-07-26 (audit) | approved: 2026-07-27 | executed: 2026-07-27 | delivered: 2026-07-27

## Delivery evidence (2026-07-27)
All 6 branches fixed, verified, and Tier-1 APPROVED (fade after 1 revision round):
- support-fixes `30905bb7d` · history `905646259` · broll `38bc72590` · fade `a650c1a26` · presets `58256eb48` · wheel `2f268b1c5` (waveform/logo unchanged — PASS as-is)
- Gates: tsc 0 new errors ×6 · all verify scripts pass (incl. presets 26/26 previously unrunnable, editor-job-runtime now green + wired into CI) · production builds pass (broll, fade, presets, support)
- Merge order + integration-commit items: audit doc §E. Deferred: layers B-roll/Background toggle (new ticket), Can-defer findings.
- Ops note: `NEXT_PUBLIC_BROLL_WINDOW_SEC` must stay unset/default 4 on prod (legacy cutaway reconstruct depends on it).

## Merge train (2026-07-27) — DONE, NOT PUSHED
Local `main` = `6d0c2e3dd` (origin/main still `b968afc91`; feature branches untouched). Order per audit §E; 9 merges + integration commit `7aa6ebd1` (B-1 logoVisible prop into AvatarAdjustOverlay; fade indicator gated by `avatarFadeApplies && layerVisibility.avatar`) + `6d0c2e3d` (build unblock: `LIVE_PREVIEW_MAX_SEC` moved to new `src/lib/preview-bg-constants.ts` — fade revision had made a client component import fs-bearing `preview-bg-params.ts`, caught only by webpack build; + 2 cross-branch verify reconciles: waveform track-list 13→14 with adjacency invariant asserted directly, harness registers `@/lib/editor-layer-visibility` mock).
Final gate on merged main: tsc 0 · verify 15/15 · `npm run build` exit 0.
Remaining for Mew: review merged main in worktree `scratchpad/merge-train` → push → deploy → live QA matrix (audit §F). Deferred: H8 b-roll/background toggle (new ticket), M11 b-roll eye button.
