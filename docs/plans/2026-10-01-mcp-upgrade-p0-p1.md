# Public HeroAI MCP upgrade — P0 (first render right) + P1 (every MCP clip editable)

## Goal and authorization
This plan raises the Subscription North Star (MAPC, CONTEXT.md) for creators working through Public HeroAI MCP:
- An MCP clip is right on the first render: readable Thai subtitles, controllable size and style, and visible failure reasons.
- When the clip is not right, the creator refines it instead of regenerating it.

Mew approved the scope and every interview decision on 2026-10-01 (Q1–Q15 and Q5b).

Evidence lives in `docs/plans/reports/2026-10-01-mcp-upgrade-p0-p1/`:
- `audit.md`: redacted prod usage over 60 days. 220 MCP jobs, about 18% same-script re-creates, and 29 failures with NULL errorCode.
- `recon.md`: code facts with file:line references.
- `critic-preflight.md`: the pre-flight critique this revision answers.

Fixture: `scripts/fixtures/mcp-48-cards.json` holds Mew's own clip `cmuoikpho004klc1z90uccxtv` (sentence mode, size 80, 48 captions, fullText, audioDurationMs). It has no `words[]`; tests synthesize word timing from caption spans.

**Defect finding.** In Mew's clip, the longest card (46 code units) is 33 base graphemes, so it already fits two lines at size 80. The visible "ตัดคำ/เว้นวรรคผิด" comes from **where Chromium wraps** (renderSubtitle.tsx:358-362). T2 fixes that, and T1 prevents cards that are genuinely oversized.

Terminology (reference, do not restate): Card Line Budget, Agent-created Project, Preview Mode, Base Render, Burn / Export, Subtitle QA Report, Blocking Subtitle Code, Job Failure Class (CONTEXT.md). Relevant ADRs: 0001, 0053, 0056, 0063.

Worktrees (Orca only; the repo root stays read-only):
- PR-A: `AI_content_Mew_social-mcp-upgrade-p0p1`, branch `mew/mcp-upgrade-p0p1`.
- PR-B: a new Orca worktree, branch `mew/mcp-upgrade-p1`, stacked on PR-A.

## Global Constraints

**Card Line Budget**
- Use a new pure module `src/lib/card-line-budget.ts` that imports neither orchestrator nor Remotion code. It exports `maxCardCharsFor(size)`, `baseGraphemeCount(text)` (excluding Unicode Mn) and `fitsCardLineBudget(text, mode, size)`.
- `orchestrator-steps.ts` re-exports `maxCardCharsFor`. Every other task uses this module.
- Word-count modes ("1"–"4") may use one line. "sentence" may use two.
- Text over budget is split into another Caption at a Thai word boundary, using the existing `thaiWordSegmenter` / `wordBoundaries` / `findCut` in tts-timing.ts. Never split mid-word or mid-grapheme.

**Caption text**
- Caption text stays exact to the authored text. Compare it the way the `textExact` QA does: NFC, with whitespace normalized the same way.
- The `spacing_mismatch` and `broken_thai_grapheme` checks must keep passing.
- Line breaks are display-only and are never written into caption text.

**ADR 0056 stands**
- QA blocks only on `empty_script` / `empty_captions`. The line-fit finding is a warning.
- Keep `alignNarrationOnce`. Add no regen or retry, and do not make transcribe the primary path.

**Shared core (decision Q2)**
- The web editor's initial cards change exactly as MCP's do.
- Web `regroupCaptions` "sentence" mode keeps returning server cards unchanged.

**Subtitle style resolution**
- Order: explicit MCP args → Brand Subtitle Style → `DEFAULT_V2_SUB` (web default).
- The Brand Subtitle Style is the **active** revision's `brandSubtitleDefault` of `brandProfileId`. With no id given, use the brand automatically when the account has exactly one active Brand Profile.
- Active brand means `activeRevisionNumber > 0 && archivedAt == null && frozenAt == null`. Reuse the semantics of `resolveBrandProfileRevisionForNewProjectInTransaction` (brand-profile-library.server.ts:683-692).
- Explicit `subtitleMode` / `subtitlePosition` args beat a brand's `cardLen` / `verticalPos`.
- From a brand, this round reads only the subtitle style. It never binds the project to the brand's voice, visuals or logo.
- The default rung adopts `DEFAULT_V2_SUB`. This is a deliberate visual change for MCP: `shadow: true`, plus the web font-family form. Update `verify-mcp-orchestrator-steps.ts:64-72` on purpose.

**New MCP inputs (all optional)**
- `subtitleSize`: integer 30–160.
- `subtitleStyle`: one of the `V2_QUICK_STYLES` ids (viral | shadow | outline | clean).
- `subtitleColor` / `subtitleAccentColor`: `#RRGGBB`.
- `brandProfileId`: owner-checked. A foreign or inactive id returns an in-band error and never leaks.

**Warnings**
- The create response carries `warnings: string[]` (Thai).
- The existing single `warning` (HeyGen readiness, route.ts:290) moves into it. Keep `warning` as the first element for one release so older agents still read it.

**`geminiVoiceStyle`**
- Gate it like web: `isInternalAiBetaEnabledFor(user, process.env.GEMINI_TTS_38_PUBLIC === "1")`.
- When the gate denies it, use "neutral" and add a warning. Never drop it silently.

**Failure fields**
- Every failed MCP job surfaces `{errorCode, message, userAction, refunded, refundPending}` through `get_video_status`.
- Map `errorCode == null` (including the 29 historical rows) to `internal` at read time.
- `refundPending = reservationRefundPending`.
- `refunded = !reservationRefundPending && fundingState ∈ {none, refunded} && no RenderJob{parentJobId ∈ chain jobs, reservedQuota: true}`.
- HeyGen BYOK spend is never refundable. Say so in `userAction` when the job had an avatar.

**P1 gating**
- P1 sits behind `isInternalAiBetaEnabledFor(user, process.env.MCP_EDITOR_PROJECT_PUBLIC === "1")`, evaluated at create time only.
- Chain-following keys on job data, never the live flag, so in-flight chains survive a flag flip.
- With the flag off, create behavior is unchanged apart from P0.

**P1 billing**
- Exactly one charge per delivered clip across the chain. The export burn must hit `isBurnAlreadyPaid`, and the HeyGen BYOK boundary is unchanged.
- Failure or cancel settles exactly once through the existing idempotent paths.
- Cancel during the export half follows web semantics: the completed base render stays charged. This is decision Q10, and the T11 copy must say so.

**Security and data**
- Apply ownership and IDOR guards on every new lookup: job, chain, project and brand. Add no new SSRF surface.
- Keep secrets, scripts, raw provider bodies and media URLs out of logs and telemetry. The audit stores only client name, version and user-agent.

**Storage**
- No schema migration.
- The Agent-created Project origin lives in draft JSON as `createdVia: "mcp"`, with a pass-through added to `V2Draft` / `applyDraft` / `buildDraft` (useV2Project.ts:794-806) so autosave keeps it.
- The chain marker lives in job `inputJson`.

**Harness and test-suite gates**
- Any new import into `src/app/api/videos/jobs/route.ts` goes into both editor runtime harness symbol tables. CI fails while `tsc` stays green otherwise.
- Code moved out of a route breaks source-grep suites. Grep `scripts/` for the moved file's path and update those assertions deliberately (e.g. `verify-mcp-audit-status.ts:56`).

**MCP instructions and tool registration**
- They are static and the same for every user. Instructions and tool descriptions stay in Thai.
- They say "relay `editorUrl` when present", describe every new param and the `warnings` array, and keep the no-API-keys-in-chat rule.

**Tests**
- Use the repo pattern: `scripts/verify-*.ts` against a throwaway SQLite with mocked providers. Observe RED before each behavioral fix.
- Each new verify script is added to `package.json` and `.github/workflows/ci.yml`.
- Existing suites must stay green: `verify:mcp-perfect`, `verify-mcp-*`, `verify-subtitle-*` (including `verify:subtitle-karaoke`), `verify-split-*`, `verify-caption-card-editing`, `verify-subtitle-fit-v2*`, `verify-editor-projects`.
- The final gate also runs `npx tsc --noEmit` and one full `npm run build`.

**Delivery**
- No deploy, no prod access and no merge by the executor. The executor opens the PRs, and Mew merges and deploys.

## Architecture
- **P0 caption core (T1–T3).**
  - T1 adds one final `enforceCardLineBudget(captions, words, fullText, mode, size)` pass just before `repairCaptionTiming` (orchestrator.ts:~2473). That covers every timing rung, including the LLM-accepted cards and any post-merge growth.
  - T1 also adds a size param to `groupTimedCaptionWords`.
  - T2 adds a display-only balanced break in `renderSubtitle.tsx`, which render and the editor preview share.
  - T3 adds a QA line-fit finding.
- **P0 MCP surface (T4–T7).** Inputs, resolved design and options (T4); voice style (T5); failure fields (T6); client capture (T7).
- **P1 (T8–T11), ADR 0063.**
  - MCP create calls `createVideoJob` (not the web route) with `previewMode: true`, a new Agent-created Project and `mcpChainExport: true`. The same MCP admission guards as today apply.
  - Web-only fields are intentionally omitted: contentPreflightId and projectVisualPin (no Brand Visual this round).
  - A finished chain-marked preview enqueues one export job with `idempotencyKey = "mcp-chain:<previewJobId>"`. The unique `(userId, idempotencyKey)` is both the link and the idempotency guarantee.

## Tasks

### T1 — Card Line Budget in the caption core
Files:
- `src/lib/card-line-budget.ts` (new) and `src/lib/tts-timing.ts`.
- The module holding `groupTimedCaptionWords`, plus its callers: `orchestrator-steps.ts` (`cardsByWordCount`), web `regroupCaptions` (`_v2/subtitle-style.ts:195`) and Story Film (`story-film-editorial.ts:239`).
- `src/lib/mcp/orchestrator.ts`: the final pass before `repairCaptionTiming`.

Checklist:
- [ ] Add the budget module. `maxCardCharsFor` keeps its current formula, re-exported.
- [ ] `enforceCardLineBudget` splits only over-budget cards at word boundaries. It interpolates split timing from word timing when present, and otherwise proportionally by base graphemes within the card span. It never reorders or merges.
- [ ] The resolved size defaults to 80 until T4 passes it.
- [ ] **RED synthetic fixtures** (Mew's fixture is already within budget, so it is not the RED case):
  - (a) an LLM-accepted unspaced Thai run of 60+ base graphemes in sentence mode;
  - (b) a 3-word group over the one-line budget in word mode;
  - (c) a Thai string with heavy combining marks, to prove base-grapheme counting.
- [ ] **GREEN invariants on `mcp-48-cards.json` plus the RED fixtures, at sizes 80 and 60:**
  - every card fits its budget;
  - every split index is a `wordBoundaries` index;
  - joined text equals fullText under the textExact comparison;
  - timings are monotonic, non-overlapping and within audioDurationMs.
- [ ] Mew's fixture stays byte-identical, because nothing in it is over budget.

### T2 — Display-time balanced line break (the reported defect)
Files: `src/remotion/renderSubtitle.tsx`.

Checklist:
- [ ] When a Caption exceeds one line at the rendered size, insert one display-only break at the `wordBoundaries` index that minimizes |line1 − line2| in base graphemes, with each line ≤ the one-line budget.
- [ ] Keep `protectSubtitleWordBreaks` (no break inside protected spans) and keep-all.
- [ ] A caption that cannot fit two lines (old jobs, user-typed cards) gets the most balanced single forced break, and natural wrap handles the remainder. No third forced break.
- [ ] RED first: a unit test on the break chooser using the fixture cards that wrap at 80 (e.g. "กระจุกอยู่ที่เด็กซึ่งทำการบ้านเสร็จเร็วผิดปกติ", "ผลสำรวจของ Rocket Media Lab", "กับมูลนิธิแพธทูเฮลท์ พบว่า").
- [ ] Every fixture card at 80 and 60: each line ≤ the one-line budget, every break on a word boundary, and no break inside a `protectSubtitleWordBreaks` span.
- [ ] Karaoke, highlight and typewriter keep working. Their `tokenLines` must handle the inserted break. Required: `verify:subtitle-karaoke`, a typewriter check and `verify-subtitle-fit-v2-remotion`.
- [ ] Evidence: render Remotion stills of 3 fixture cards at size 80, before and after, into the reports folder.

### T3 — Line-fit QA finding
Files: `src/lib/mcp/subtitle-quality.ts` and its create and export call sites.

Checklist:
- [ ] Add `card_exceeds_line_budget` as a warning. It has the **lowest precedence**: it never masks `unverified_alignment` or any other ADR 0056 measurement code.
  - Alternatively add a separate `lineFit` field on the report. The worker picks one, documents it in the PR, and the reviewer checks no other code is masked.
- [ ] Inputs: mode and resolved size, with the size coming from T4.
- [ ] Surfacing it in MCP `get_video_status` `subtitleQa` happens in T6.
- [ ] Tests: the finding fires on an over-budget card, never fails a job, and does not mask a higher-precedence code.

### T4 — MCP subtitle style, Brand Subtitle Style and options
Files: `src/lib/mcp/create-video-input.ts`, `src/app/api/[transport]/route.ts`, `src/lib/mcp/orchestrator-steps.ts`, `src/lib/mcp/orchestrator.ts`, `src/lib/mcp/video-options.ts`, `src/lib/brand-profile-library.server.ts`.

Checklist:
- [ ] Add the inputs and resolution order from Global Constraints.
- [ ] Add named converters:
  - `V2SubConfig` → `HeroSubtitleDesign` (fontFamily string, `verticalPos` → `positionTopPercent`, `textColor` → `color`, `accentColor`, `preset` → `stylePreset`, `effect` → `textEffect`, shadow/outline).
  - Brand `SubtitleStylePresetConfig` → `V2SubConfig`.
- [ ] Persist the resolved `V2SubConfig` and `cardLen` in job `inputJson`. The burn (`buildBurnConfig` now takes a design), T1's budget and T3 all read it.
- [ ] `get_video_options.subtitle` returns `{ sizeRange: [30,160], default, styles: [{id,label}], brands: [{brandProfileId, name}] }`. Brands are active ones only, and only the caller's.
- [ ] When the account has several active brands and none is given, add a warning: "มีแบรนด์ให้เลือก N แบรนด์ — ระบุ brandProfileId เพื่อใช้สไตล์ซับของแบรนด์".
- [ ] Create returns `warnings: string[]` per Global Constraints.
- [ ] Tests:
  - each rung;
  - explicit arg beats brand beats default;
  - mode/position precedence;
  - foreign, archived and frozen brand ids are refused;
  - single-brand auto pick;
  - multi-brand warning;
  - the deliberate `verify-mcp-orchestrator-steps` default update.

### T5 — geminiVoiceStyle forwarding
Files: `src/app/api/[transport]/route.ts`.

Checklist:
- [ ] Forward the value through the web gate. When denied, use "neutral" and add to `warnings`.
- [ ] Tests: both gate states, and the value reaching job `inputJson`.

### T6 — Failure transparency and QA surfacing
Files: `src/lib/mcp/tools.ts`, `src/lib/mcp/video-job.ts`, `src/lib/mcp/orchestrator.ts` (remaining codeless `failJob` calls reachable from MCP create), existing error-copy maps.

Checklist:
- [ ] `get_video_status` for a failed job returns `{errorCode, errorProvider?, message, userAction, refunded, refundPending}` per Global Constraints, with a read-time `internal` fallback.
- [ ] Every MCP-reachable create failure path has a code.
- [ ] Surface the T3 line-fit finding in `subtitleQa`.
- [ ] Tests:
  - one per Job Failure Class (system, byok, quota);
  - a legacy NULL row reads as `internal`;
  - each `refunded`/`refundPending` state: none, pending, settled refund, kept charge;
  - the avatar job's `userAction` mentions HeyGen non-refundability;
  - no bare generic copy is returned without a code.

### T7 — Client capture in the MCP audit
Files: `src/app/api/[transport]/route.ts` (`verifyToken` receives the Request), `src/lib/mcp/audit.ts`.

Checklist:
- [ ] Carry the user-agent and, if `mcp-handler` exposes it, the MCP `clientInfo` name and version (spike first; user-agent alone is acceptable) through `authInfo.extra` into `recordToolCall`. Store them in `ToolCallAudit.userAgent`, truncated to 200 characters.
- [ ] No UI.
- [ ] Test: an audit row carries the user-agent.

### T8 — P1 core: Agent-created Project, Preview and server-chained Export (ADR 0063)
Files: `src/app/api/[transport]/route.ts`, `src/lib/editor-projects.ts`, `src/lib/mcp/video-job.ts`, `src/lib/mcp/orchestrator.ts`, `src/lib/mcp/tools.ts`, `src/lib/mcp/billing-receipt.ts`, the MCP watchdog, and `src/app/api/videos/jobs/route.ts` only if export creation is extracted into a shared server function.

**Create (flag on):**
- [ ] Create the EditorProject: title from `title`, draft `{createdVia: "mcp"}`.
- [ ] Then `createVideoJob` with `previewMode: true`, `projectId` and `mcpChainExport: true`. `type` stays "create".
- [ ] Persist the resolved `V2SubConfig` and `cardLen`, per T4.

**Trigger:**
- [ ] Trigger only on a `done` job whose `inputJson.mcpChainExport === true` and `type === "create"`.
- [ ] Web re-renders, B-roll re-renders and exports on an Agent-created Project never trigger it. Test this.
- [ ] The enqueue runs **after** the finish transaction commits (never inside `onTransition`, which runs before `activeJobId` is set; video-job.ts:331-353).

**Export job:**
- [ ] Build the `subtitleOverlayConfig` server-side with `buildHeroSubtitleOverlayConfig` from the resolved design and preview captions.
- [ ] Build an `editorSnapshot` via `createEditorExportSnapshot` with `subtitleConfig` = the resolved `V2SubConfig`, `cardLen` = subtitleMode and `originalCaptions` = the preview captions. This keeps the reopened project's style the same as the burned style.
- [ ] Use `idempotencyKey = "mcp-chain:<previewJobId>"`. It must pass `assertCurrentEditorExportSource`.
- [ ] The server chain **bypasses** the `inflight >= 3` cap. It is one logical job.

**Lost-enqueue recovery:**
- [ ] When `get_video_status` or the watchdog finds a done chain-marked preview with no `mcp-chain:` export, it enqueues the export idempotently.

**Status mapping for `get_video_status(previewJobId)`:**
- [ ] Preview running: `processing`, with progress mapped 0–85.
- [ ] Preview done and export queued, running or missing: `processing`, with progress 85–100.
- [ ] Export done: `done`, with `videoUrl`, `videoId`, `editorUrl` (absolute, built with the existing app-origin helper, `/video-editor?projectId=…`) and `subtitleQa`.
- [ ] Either half failed or canceled: `failed` / `canceled`, with the T6 fields from the failing row.
- [ ] Querying by the export job id also works and returns the same shape.

**Receipt:**
- [ ] The chain `billingReceipt` sums both jobs' RenderJobs (parentJobId) and must equal exactly one active charge.
- [ ] Today's release gate (orchestrator.ts:2948-2953) applies to the chain as a whole before reporting `done`.

**Tests:**
- [ ] Flag on and flag off (off means the existing MCP suites pass unchanged).
- [ ] Avatar and non-avatar.
- [ ] Exactly one charge, with the burn on `isBurnAlreadyPaid`.
- [ ] A failure in each half settles once.
- [ ] A duplicate finish enqueues once.
- [ ] Lost-enqueue recovery.
- [ ] A web re-render on an Agent-created Project does not chain.
- [ ] The project loads in Post: `getEditorProjectWithMediaState` returns a done job with preview data, and the initial subtitle config equals the resolved design.
- [ ] IDOR: another user's job id returns not-found.

### T9 — Agent-created label and draft pass-through
Files: `src/app/(dashboard)/video-editor/_v2/useV2Project.ts` (`V2Draft`, `applyDraft`, `buildDraft`), `_v2/EditorV2Shell.tsx` / `_v2/project-menu.ts`.

Checklist:
- [ ] Pass `createdVia` through `buildDraft` so autosave keeps it.
- [ ] Show the label `สร้างผ่าน AI agent` on those projects in the project menu.
- [ ] Tests: `createdVia` survives a buildDraft→save→applyDraft round trip, and the project-menu label renders.

### T10 — `cancel_video_job`
Files: `src/app/api/videos/jobs/[id]/route.ts` (extract the cancel core into a shared lib function so web behavior stays byte-identical), `src/app/api/[transport]/route.ts`.

Checklist:
- [ ] Add `cancel_video_job({id})`. It is owner-only and accepts the preview or the export job id.
- [ ] Cancel whichever half of the chain is in flight. When the preview is done and the export is not yet enqueued, write a canceled marker so recovery never enqueues it.
- [ ] Refund and project-status semantics are identical to web DELETE, including a charge kept after the preview completed.
- [ ] An already-terminal id and a foreign id both return web DELETE's not-cancelable shape.
- [ ] Update source-grep suites deliberately (e.g. `verify-mcp-audit-status.ts:56`).
- [ ] Tests: cancel during preview, during export, and in the gap between them; terminal ids; foreign ids.

### T11 — MCP instructions and tool descriptions
Files: `src/lib/mcp/onboarding.ts` (`SERVER_INSTRUCTIONS`), tool descriptions in `[transport]/route.ts`.

Checklist:
- [ ] Thai guidance covers:
  - asking about subtitle size and style, or using a brand;
  - that a brand affects only subtitles this round;
  - relaying every item in `warnings` and any `subtitleQa` warning;
  - relaying `editorUrl` when present ("กดลิงก์นี้เพื่อแก้ต่อในเว็บได้");
  - using `cancel_video_job` instead of re-creating;
  - explaining `errorCode` / `userAction` / `refunded` / `refundPending`;
  - that cancelling after the base render keeps that charge;
  - that HeyGen spend is not refundable.
- [ ] Keep the polling-cadence rule and the no-API-keys rule.
- [ ] Set `serverInfo.version` to `0.2.0`.
- [ ] Test: update `verify-mcp-onboarding`.

## Assurance and Budget
- Profile: high-assurance. MCP is a user-input boundary, P1 changes the job and billing chain for paying creators, and T1/T2 change subtitles for every web and MCP render.
- Risk:
  - T1, T8: high.
  - T2, T3, T4, T6, T10: medium.
  - T5, T7, T9, T11: low.
- Automatic fix rounds: 5 (high), 2 (others).
- Maximum subagent runs: 45.
- Concurrency: fill only live harness slots. The Blocked-by column below includes the file-conflict edges, so a task never starts while another task editing the same file is unmerged into the PR branch.
- Usage checkpoints: before execute, after each frontier wave, before the final gate.
- Delivery: two PRs into `main`, CI green on both, and Mew merges.
  - **PR-A** = P0 (T1–T7), branch `mew/mcp-upgrade-p0p1`.
  - **PR-B** = P1 (T8–T11), branch `mew/mcp-upgrade-p1`, stacked on PR-A and rebased after PR-A merges.
  - If Mew asks the executor to merge, wait for the check first: `gh pr merge --auto` merges immediately on this repo.

## Execution Directive
| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Card Line Budget in caption core | mew-worker-heavy | subagent | — | build+test, mew-reviewer (opus) |
| 5 | geminiVoiceStyle forwarding | mew-worker | subagent | — | build+test |
| 2 | Display-time balanced line break | mew-worker | subagent | 1 | build+test, mew-reviewer |
| 4 | MCP subtitle style + brand + options | mew-worker | subagent | 1, 5 | build+test, mew-reviewer |
| 3 | Line-fit QA finding | mew-worker | subagent | 1, 4 | build+test, mew-reviewer |
| 6 | Failure transparency + QA surfacing | mew-worker | subagent | 1, 3 | build+test, mew-reviewer |
| 7 | Client capture in audit | mew-worker | subagent | 4 | build+test |
| — | PR-A whole-branch (T1–T7) | mew-reviewer (model: opus) | subagent | 1–7 | whole-branch + security review |
| 8 | Agent-created Project + chained Export | mew-worker-heavy | subagent | PR-A review | build+test, mew-reviewer (opus), security review |
| 9 | Draft pass-through + label | mew-worker | subagent | 8 | build+test |
| 10 | cancel_video_job | mew-worker | subagent | 8 | build+test, mew-reviewer |
| 11 | MCP instructions + descriptions | mew-worker | subagent | 9, 10 | build+test, mew-reviewer |
| — | PR-B whole-branch (T8–T11) | mew-reviewer (model: opus) | subagent | 8–11 | whole-branch + security review |

Waves for PR-A: {T1, T5} → {T2, T4} → {T3, T7} → {T6}. T2 touches only renderSubtitle.tsx, so it runs beside T4. T7 and T6 both depend on route.ts and tools.ts finishing in order.

## Acceptance Criteria
- [ ] **Card budget (T1).** On the synthetic RED fixtures, over-budget cards are split at word boundaries. On `mcp-48-cards.json` at sizes 80 and 60:
  - every card fits its budget;
  - joined text equals fullText (textExact comparison);
  - timings are valid;
  - Mew's 48 cards are unchanged.
- [ ] **Display break (T2).** On every fixture card at sizes 80 and 60, each displayed line is within the one-line budget, every break falls on a Thai word boundary outside protected spans, and there are at most 2 forced lines. The karaoke, typewriter and fit-v2 suites pass. Before and after stills are attached.
- [ ] **Line-fit QA (T3).** `card_exceeds_line_budget` is a warning, never fails a job, and never masks a higher-precedence code.
- [ ] **Style inputs (T4).** MCP create accepts `subtitleSize` / `subtitleStyle` / colors / `brandProfileId` per Global Constraints. The burned overlay uses the resolved design. `get_video_options` lists the subtitle options and only the caller's active brands. The create response returns `warnings[]`.
- [ ] **Voice style (T5).** `geminiVoiceStyle` reaches the job when the gate allows it; otherwise the response carries a warning.
- [ ] **Failures (T6).** Every failed MCP job, legacy rows included, returns a non-null `errorCode`, `userAction`, `refunded` and `refundPending` per the defined derivation.
- [ ] **Audit (T7).** MCP audit rows record the client user-agent.
- [ ] **Chain (T8).** With the flag on, one MCP create yields:
  - an Agent-created Project that opens in Post with the resolved subtitle style;
  - one finished video;
  - an absolute `editorUrl`;
  - exactly one charge in the chain receipt.
- [ ] **Chain safety (T8).** Web re-renders on that project never auto-export. Lost-enqueue recovery works. With the flag off, the existing MCP suites pass unchanged.
- [ ] **Label (T9).** `createdVia` survives autosave, and the label shows.
- [ ] **Cancel (T10).** `cancel_video_job` matches web cancel semantics for both halves and the gap between them.
- [ ] **Instructions (T11).** The Thai instructions cover every new field. The version is 0.2.0.
- [ ] **Build and CI.** All listed suites, every new verify script (wired into package.json and ci.yml), `tsc` and a full build pass. CI is green on PR-A and PR-B.
- [ ] **Post-deploy, Mew-run (not a merge gate).** Regenerate Mew's script through MCP and visually confirm good line breaks. Use subtitleSize 64 to confirm the smaller font.
- [ ] **14-day watch after the flag opens to all (not a merge gate).** No failed MCP job without errorCode. Track the same-script re-create rate within 24 h, ~18% baseline toward ≤10%.

## Out of scope
- **P2: chat editing tools and preview frames for the agent.** Next plan, once P1 proves the project path.
- **P3: script from Style, Brand Visual binding, upload-by-URL.** Pre-production; needs a separate decision.
- **Hero Voice, B-roll count and region preference through MCP.** Not in the approved P0/P1.
- **Internal Story Film MCP.** Separate transport (ADR 0053).
- **Avatar offset units mismatch** (job X=4/Y=28 against the MCP ±2 cap). Open a Linear ticket to investigate.
- **Admin UI for MCP client stats.** Data capture only this round.

## Status
interviewed 2026-10-01 | critic: revised for B1–B8, A1–A14 | approved: 2026-10-01 | executed: 2026-10-01 (PR-A #565 → 5ff3368f, deployed prod 2026-10-01; PR-B #566 → 2b375aa4, not deployed) | delivered: 2026-10-01 — follow-up #567 (Hero AI Image cancel rule, Mew-approved)
