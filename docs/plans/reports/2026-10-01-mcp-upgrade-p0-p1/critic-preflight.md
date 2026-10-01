# Pre-flight critique: 2026-10-01-mcp-upgrade-p0-p1

Plan: `docs/plans/2026-10-01-mcp-upgrade-p0-p1.md`. Checked against the worktree code (origin/main `8c6560d2` plus the plan), CONTEXT.md, ADR 0056/0063, and the audit and recon files.

**Overall: FAIL (8 blocking, 14 advisory).** P0 is close: most of the fixes are a sentence or a fixture. P1's chain contract (B3–B6) needs about half a page of spec before a worker can build it without guessing.

## 1. Acceptance Criteria coverage

| # | Criterion | Covered by | Verdict | Evidence / gap |
|---|---|---|---|---|
| AC1 | 48-card fixture at 80/60: no over-budget card, no mid-word/grapheme break, joined text = fullText, valid timings | T1 (+T2) | **Not met as written** | The fixture data doesn't exist anywhere a worker can read (B1). Under the plan's own budget it is already green before any fix (B2). "No break falls mid-word" is T2's job, but T2's test isn't tied to the fixture. |
| AC2 | `card_exceeds_line_budget` warns, never fails | T3 | Partially met | Testable. The single-finding report shape forces a precedence choice the plan doesn't make (A6). Size and mode inputs only arrive with T4 (B8). |
| AC3 | create accepts style params; burn uses resolved design; options list caller's brands | T4 | Partially met | Testable. The mapping from brand/V2 config to `HeroSubtitleDesign` and the precedence of `position`/`cardLen` are unspecified (A4). Changing the default rung breaks an existing assertion (A5). |
| AC4 | geminiVoiceStyle forwarded / warning | T5 | Met | Gate signature matches `internal-ai-access.ts:79` and the web usage at `jobs/route.ts:585-590`. Collision on the `warning` key: see A9. |
| AC5 | failed job → non-null errorCode, userAction, refunded | T6 | **Not met** | `refunded` has no defined derivation (B7). The 29 legacy NULL-code rows need a read-time `internal` fallback, which T6 doesn't state (A10). |
| AC6 | audit rows record user-agent | T7 | Met | `ToolCallAudit.userAgent` exists (schema.prisma:1099). `verifyToken(_req…)` already receives the Request (route.ts:317). |
| AC7 | flag on → Agent-created Project opens in Post, one video, editorUrl, one charge; flag off unchanged | T8 | **Not met** | Chain link, status, receipt and recovery are undefined (B3). The trigger misfires on web re-renders (B4). The reopened project loses the MCP style (B5). The origin marker is wiped on first autosave (B6). No test asserts "opens in Post". |
| AC8 | cancel matches web for both halves | T10 | Partially met | Feasible; web DELETE is at `jobs/[id]/route.ts:115-221`. Cancel-by-original-id while the chain sits between halves is undefined (B3). The charge outcome of cancelling during export isn't stated (A12). |
| AC9 | suites, tsc, build, CI green on both PRs | all | Partially met | New `verify-*` scripts don't run in CI unless added to `ci.yml`/`package.json`, and the plan never says to add them (A2). Moving code out of the routes breaks source-grep suites the plan doesn't list (A3). |
| AC10–11 | post-deploy checks | Mew | n/a | Not merge gates. Fine. |

## 2. Blocking findings

**B1. The T1/AC1 fixture data isn't available.**
- The plan says "Mew's 48 cards from the audit". The audit (`/private/tmp/heroai-mcp-upgrade-audit-2026-10-01.md`, copied to `reports/.../audit.md`) contains one card string only, with no texts, timings, words or fullText.
- Global Constraints forbid prod access.
- Fix: before execute, Mew exports job `cmuoikpho004klc1z90uccxtv`'s `subtitleEvidence` (captions, words, fullText, audioDurationMs) read-only into `scripts/fixtures/mcp-48-cards.json`, and the plan points at that file. Alternative: replace it with a synthetic fixture and say so.

**B2. The fixture is green before the fix, so RED can't be observed and AC1 can pass without fixing the reported bug.**
- Budget math: `maxCardCharsFor(80)` = 24 and `maxCardCharsFor(60)` = 32. A sentence card may use 2 lines, so the budget is 48 or 64 base graphemes.
- The longest fixture card is 46 code units. The cited card "กระจุกอยู่ที่เด็กซึ่งทำการบ้านเสร็จเร็วผิดปกติ" has 13 Mn marks, so it is 33 base graphemes.
- Every sentence card is therefore already within budget at both sizes. The audit names the actual defect as "ตัดคำผิด": Chromium picks the wrap point (renderSubtitle.tsx:358-362). Only T2 fixes that, and T2 is low-risk, has no reviewer and no fixture test.
- Fix:
  - (a) Add a synthetic RED fixture for T1: an LLM-accepted unspaced Thai run of 60+ base graphemes, plus a word-mode group over budget.
  - (b) Move "no break mid-word" in AC1 onto T2's break chooser, run over every fixture card at 80 and 60: each line ≤ the one-line budget, and every break on a `wordBoundaries` index.
  - (c) Raise T2 to medium risk with mew-reviewer.

**B3. The P1 chain contract is undefined. A worker must invent all of the following.**
- **Link.** How `get_video_status(originalJobId)` and `cancel_video_job` find the export job without a schema change. Suggest: export `idempotencyKey = "mcp-chain:<previewJobId>"`, looked up by `(userId, idempotencyKey)`. That key also gives the "idempotent on source job id" guarantee through `@@unique([userId, idempotencyKey])`.
- **Status mapping.** The preview row becomes `done` (video-job.ts:309) while the chain is still running. Define:
  - preview done with no export yet → `processing`
  - export failed or canceled → `failed`/`canceled`, with the T6 fields from the export row
  - progress split, e.g. preview 0–85 and export 85–100.
- **Receipt.** `getVideoJobBillingReceipt` is per VideoJob via `RenderJob.parentJobId` (billing-receipt.ts:46-104). The base charge sits on the preview job and the burn RenderJob sits on the export job with `reservedQuota=false`. Define the chain receipt as the sum over both jobs, which must equal exactly 1. Also decide whether today's release gate (orchestrator.ts:2948-2953, throw unless settled) applies to the export half.
- **Lost enqueue.** A crash between the preview commit and the enqueue leaves the clip stuck in `processing` forever. Specify recovery, e.g. `get_video_status` or the watchdog idempotently enqueues when it finds a done chain-marked preview with no export.
- **Admission.** The web export path refuses at `inflight >= 3` (jobs/route.ts:418-419). State whether the server chain bypasses that cap, which it should, or else define the refusal outcome.
- Also state that the enqueue runs after the finish transaction commits, not inside `onTransition`. `onTransition` runs before the project `activeJobId` update (video-job.ts:331-353).

**B4. Keying the chain trigger on "Agent-created Project" would auto-export later web re-renders.**
- Preview finishes come from five sites: orchestrator.ts:1201, 1518 (B-roll rerender), 1754, 2158 and 2894.
- Once the creator opens the Agent-created Project on the web and re-renders, that is "a preview job finishing for an Agent-created Project". It would trigger an unrequested export: a gallery video and the project moved to `exporting`.
- Fix: trigger only on a job-level marker set by MCP create, e.g. `inputJson.mcpChainExport: true`, on `type: "create"`. Add a test that a web preview on an MCP project does not chain.

**B5. The reopened project won't show the style that was burned.**
- The Post phase initialises the style from `editSnapshot.subtitleConfig`, or else `brandSubtitleDefault` (usePostPhaseEditor.ts:225-227, 241).
- T8 builds only `subtitleOverlayConfig` and no `editorSnapshot`. A creator who reopens and re-exports therefore gets `DEFAULT_V2_SUB` (or the brand default) at the default `cardLen`. That silently changes the size, style and colors the agent chose, which defeats "refine instead of regenerate".
- Fix: T8 builds `editorSnapshot` via `createEditorExportSnapshot` with `subtitleConfig` = the resolved V2SubConfig, `cardLen` = subtitleMode and `originalCaptions` = the preview captions. Add a test that the reopened project's initial config equals the resolved design.

**B6. `createdVia: "mcp"` in draft JSON is erased on the first web autosave.**
- `buildDraft()` (useV2Project.ts:794-806) lists known keys only, and autosave writes it back (useV2Project.ts:2224-2226).
- The T9 label and the only origin record (no migration allowed) disappear as soon as the creator opens the project.
- Fix: add `createdVia` to `V2Draft`, `applyDraft` and `buildDraft` (a pass-through), with a test. If that's unacceptable, the "no schema migration" rule has its proof case.

**B7. The `refunded` derivation is undefined, and the obvious field is wrong.**
- `VideoJob.fundingState` covers only pre-render wallet funding. Per project memory, `transferred` is a stale label, and the real money record is `RenderJob.reservedQuota` (parentJobId), with `reservationRefundPending` for refunds still in flight. HeyGen BYOK spend is never refundable.
- Fix: define it exactly, e.g. `refunded = !reservationRefundPending && fundingState ∈ {none, refunded} && no RenderJob{parentJobId ∈ chain, reservedQuota: true}`. Add `refundPending: boolean`, or document that pending reads `false`. State the HeyGen caveat in `userAction`. Test each state.

**B8. Blocked-by doesn't guard the real file conflicts, yet the plan names it as the conflict guard.**
- Wave 1 (no blockers) runs T1 and T6 together, and both edit `orchestrator.ts`.
- It also runs T5 and T7 together, and both edit `[transport]/route.ts`.
- T3 (wave 2) and T6 both edit `tools.ts`.
- T3 needs T4's resolved size to evaluate the budget "at the burned size", but depends only on T1.
- The conflict note pairs T6 with T7 on route.ts, but T6's file list doesn't include route.ts.
- Fix: add T6←1, T7←5 and T3←4 (and T3←6, or move the tools.ts surfacing into T6), and correct the note. Alternatively, mandate one Orca worktree per task with rebase onto the PR-A branch. The per-task worktree route costs more.

## 3. Advisory findings

- **A1. Where the budget helper lives.**
  - `renderSubtitle.tsx` (Remotion and client bundle) and `tts-timing.ts` must import it. `orchestrator-steps.ts` pulls in broll-preferences and style-pack modules, and `tts-timing` → `orchestrator-steps` would invert layering.
  - Put `cardLineBudget` / `fitsCardLineBudget` / `maxCardCharsFor` in a new pure module (e.g. `src/lib/card-line-budget.ts`) and re-export from orchestrator-steps.
- **A2. CI wiring.** CI runs an explicit list of scripts (`.github/workflows/ci.yml`). Each task must add its new `verify-*` to `package.json` and `ci.yml`, or "CI green" proves nothing about it.
- **A3. Source-grep suites break when code moves.**
  - `verify-mcp-audit-status.ts:56` asserts `...VIDEO_JOB_INFLIGHT_STATUSES` inside `jobs/[id]/route.ts`, which T10 extracts.
  - Many scripts regex `jobs/route.ts` (T8).
  - Tell T8 and T10 to grep `scripts/` for the file path and update those assertions deliberately. Remind them of both editor-harness symbol tables.
- **A4. Style resolution details.**
  - Brand `SubtitleStylePresetConfig` also carries `cardLen` and `verticalPos`. Say whether the existing `subtitlePosition`/`subtitleMode` args beat them (they should, as explicit args).
  - Name the converters V2SubConfig/brand config → `HeroSubtitleDesign`: font-family string, `verticalPos`→`positionTopPercent`, `textColor`→`color`.
  - Define "active brand" as `activeRevisionNumber > 0 && archivedAt == null && frozenAt == null`, reading the **active** revision (not "latest"). Reuse `resolveBrandProfileRevisionForNewProjectInTransaction` semantics (brand-profile-library.server.ts:683-692).
  - Define the "hint" field. `get_video_options` should list active brands only.
- **A5. The default rung changes MCP output.** `DEFAULT_V2_SUB` ≠ `DEFAULT_STYLE`: it has `shadow: true` and fontFamily "Kanit" rather than "'Kanit', sans-serif". `verify-mcp-orchestrator-steps.ts:64-72` asserts DEFAULT_STYLE. State the intended visual delta and update that test on purpose.
- **A6. A QA report holds one finding.** `SubtitleQualityReport` carries a single `code` (subtitle-quality.ts:43-62). Define precedence: line-fit lowest, so `unverified_alignment` and other ADR 0056 measurement codes aren't masked. Alternatively, add a separate `lineFit` field. Name the QA call sites, create and export, and the new `mode`/`size` inputs.
- **A7. T1 enforcement point.**
  - Budget can be exceeded again after the split by `snapCardsToWordBoundaries` (edge moves), `mergeShortCaptions` (tts-timing.ts:977), `mergeUncertainCaptionCards` / `mergeShortAcousticCards`.
  - The rung list omits `partial_forced_alignment`.
  - Simplest: one final pass, `enforceCardLineBudget(captions, capRes.words, fullText, mode, size)`, just before `repairCaptionTiming` (orchestrator.ts:2473). That covers every rung at once.
  - Also: `groupTimedCaptionWords` gains a size param, which touches web `regroupCaptions` (subtitle-style.ts:195) and Story Film (`story-film-editorial.ts:239`). List both.
  - "Joined text equals fullText": specify the comparison (NFC, whitespace-stripped, as `textExact`), because cards are trimmed and whitespace-collapsed.
- **A8. T2 edge cases.**
  - Say what happens to a caption still over 2 lines (old jobs, user-typed cards): one balanced forced break plus natural wrap, or the legacy path.
  - The inserted `\n` changes `tokenLines` (karaoke/highlight). Require the karaoke suite (`verify:subtitle-karaoke`) plus a typewriter check.
- **A9. Several warnings, one key.** The create response's `warning` is a single string already used by HeyGen (route.ts:290). T4's hint and T5's voice warning collide with it. Use `warnings: string[]` or a defined join.
- **A10. Legacy NULL-code rows.** T6 should map `errorCode == null` → `internal` at read time in `getVideoJobStatusTool`. The 29 historical failures will never be rewritten.
- **A11. Flag scope of T10/T11.** `SERVER_INSTRUCTIONS` and tool registration are static, not per-user, so they can't be byte-identical when the flag is off. State that `cancel_video_job` is available to everyone, and that the instructions say "relay editorUrl when present". Chain-following must key on job data, not the live flag, so chains in flight survive a flag flip.
- **A12. Cancel during export.** Web semantics keep the base charge (the preview completed), so an MCP user who cancels during export pays one clip and sees `refunded:false`. Confirm this is the intended product rule and put it in the T11 copy. Web DELETE answers "already finished" for foreign ids too (route.ts:131-133). T10's "foreign id" test should expect that same not-found/not-cancelable shape.
- **A13. "Web create path" vs "today's MCP create" contradiction.** Architecture says MCP runs the web create path; T8 says MCP `createVideoJob` with `previewMode` and `projectId`. Pick one. If MCP, list the web-only fields intentionally omitted (contentPreflight, projectVisualPin). Also make `editorUrl` absolute (app origin), not a relative path.
- **A14. Delivery and process.**
  - Only one branch is named; name PR-B's branch, stacked on PR-A.
  - "Merge is Mew's decision" contradicts the `gh pr merge` instruction. State that the executor does not merge code PRs.
  - The audit and recon copy step is already done (`reports/.../audit.md`, `recon.md`).
  - Add a T8 test asserting the project loads in Post: `getEditorProjectWithMediaState` returns a done job with preview data.

## 4. Unsupported or inconsistent claims

- "Mew's 48 cards from the audit": the audit has no card list (B1).
- The RED premise that the 46-char card exceeds the budget doesn't hold under the plan's 2-line sentence rule (B2).
- "T6 and T7 both edit `[transport]/route.ts`": T6's file list excludes route.ts.
- "Blocked-by column is the conflict guard": false for T1/T6, T5/T7 and T3/T6 (B8).
- The "≤10%" re-create target has no stated basis. It is marked tracked-only, so this is acceptable.

## 5. Risk and assurance

- T2 is rated low, but it is the actual fix for the reported defect and changes every web and MCP burn. Raise it to **medium with mew-reviewer**.
- T6 at medium with a money-facing `refunded` field: keep the reviewer and give them the B7 definition to check against.
- T1/T8 high with an opus reviewer and security review is proportionate.
- PR-level opus whole-branch review is proportionate.
- Global Constraints:
  - Nothing in the plan violates ADR 0056: the warning-only finding, `alignNarrationOnce` kept, no retry.
  - Display-only breaks respect text-exact captions.
  - Billing-once holds only if B3's receipt and B4's trigger are fixed.
