# Task 3 independent review

Latest verdict: **PASS after fix round 1** at `f62f532a`. The originally reproduced P2 blocker below is resolved; see the appended re-review. Initial review verdict at `2c47fa4f`: changes required.

Reviewer: gpt-6-astra, medium (explicit execution override). Reviewed base `23039d07` → head `2c47fa4f` in dedicated Orca worktree `mcp-budget-review3` / branch `review/mcp-budget-review3`. Read the approved plan, Task 3 package/worker report, external reconnaissance, complete production diff, relevant unchanged completion/import paths and scoped fixtures. No production source edits, shared databases, environment copying, production operations, deployment, external messages or subagents.

## Blocking finding

### P2 — CAS miss during web Apply still activates the stale render and hides newer edits

Changed location: `src/lib/mcp/pending-edit-draft.ts:664–666`, called by `src/lib/mcp/orchestrator.ts:1626–1629`.

An accepted web Apply records revision N. If a newer pending edit is saved before that Apply completes, `rebaseWebPendingMedia` cannot find revision N and silently returns. `finishJobWithTransition` nevertheless marks the rerender done and unconditionally updates `EditorProject.activeJobId` to it (`src/lib/mcp/video-job.ts:352–369`). The newer draft retains the previous base ID. `pendingEditForWeb` rejects precisely this mismatch (`pending-edit-draft.ts:619–620`), so reopening the same project returns no pending draft and hides the newer captions/media from the web. The database still contains the edits and MCP can read them: this is shared-client divergence and stale activation, not physical deletion.

Independent reproduction: `scripts/review3-cas-probe.ts`, a reviewer-only copy of the external integration fixture. It uses isolated SQLite, real quote/create, real shared enqueue and real orchestrator completion; media normalization is real, while rendering/TTS/composition stay fixture stubs. For presenter mode, after accepted web Apply, it saves `NEWER USER CAPTION` using the actual `savePendingEditDraft` CAS, then executes the queued worker. The expected web-visible newer caption assertion fails.

Command: `node --conditions=react-server --import tsx scripts/review3-cas-probe.ts` — **exit 1**. Log `/tmp/review3-cas.log`:

```text
REVIEW injected newer caption revision after accepted Apply 6
PASS presenter: rerender preserves policy and imported assets
REVIEW post-completion {"activeJobId":"cmv6w4aqa0034q6hbts38kqrl","draftBase":"cmv6w4anp0027q6hbs2ov29j5","webProjection":null,"caption":"NEWER USER CAPTION"}
AssertionError [ERR_ASSERTION]: accepted web Apply completion must preserve newer pending captions in web projection
```

Required correction: make draft rebase and project activation one coherent CAS decision. A stale Apply must not replace the active source while leaving the newer draft pointed at the old source. Either refuse stale completion without promotion, or safely preserve/rebase newer edits without consuming replacements not actually rendered. Cover changes arriving after enqueue and before completion, including same-window replacement, caption-only edits, and newer active source.

## Independent passing evidence

Own dependencies: `npm ci --ignore-scripts` — exit 0 (`/tmp/review3-npm.log`). Initial `npx prisma generate` exited 1 because DATABASE_URL was absent; corrected with `DATABASE_URL=file:/tmp/mcp-review3-generate-only.db npx prisma generate` — exit 0. This generation command does not initialize/use a shared database. DB fixtures initialize their own unique temporary SQLite databases.

Commands below use `node --conditions=react-server --import tsx scripts/<name>`:

| Fixture | Exit | Evidence |
|---|---:|---|
| `verify-mcp-external-media.ts` | 0 | 78 assertions; script/presenter held previews, actual generate-config route, all four URL/upload × image/video normalization paths, foreign/missing/pending/failed imports, root policy, direct enqueue and worker refusal, shared web projection, normal Apply/export/reexport, free ledger/budget lineage, zero stock/image calls |
| `verify-external-media-policy.ts` | 0 | Root-authoritative states, real presenter ownership, optional historical behavior, same-revision merge preserving local edits/clears, maximum-duration planner and cap+1 |
| `verify-external-web-upload.ts` | 0 | Actual authenticated route/validation/admission/DB registration; hostile form metadata ignored, invalid input and failed normalization mint no identity; normalizer stubbed here |
| `verify-broll-rerender.ts` | 0 | 146 checks, including shared bound and range validation |
| `verify-media-import-fetch.ts` | 0 | 814 checks; existing fetch/SSRF/byte guards |
| `verify-media-import-upload.ts` | 0 | 161 checks; existing upload/token/validation guards |
| `git diff --check` | 0 | No whitespace errors |

Logs: `/tmp/review3-{external,policy,native,merge,fetch,upload}.log`.

## Security and spec assessment

Apart from the completion race, scoped inspection and independent fixtures support the implementation's use of the existing normalized import pipeline, immutable quote-root requirements, source preservation, enabled/owned/ready import identity checks, and shared enqueue/final-worker refusal. Caller flags/paths cannot waive required slots or create ready native-upload identities. Native identity fields are derived from authenticated owner and successful server normalization; existing content-length, per-type size, MIME/extension, upload admission, disk/ffprobe and server filename guards remain. No new fetcher, daemon or provider fallback was introduced. Hook protection uses the original planned presenter opening span; faceless index zero remains editable. Temporary presenter backing does not fulfill cutaways.

The shared 1500 limit is consistently used by edit validation and persisted draft parsing; the real planner bound and cap+1 fixtures pass, and existing merge range checks remain. Free rerender/export and inherited budget binding pass the scoped integration. Existing Task 2 advisories remain unchanged.

## Advisories and evidence limits

- Narrow follow-up for this same web lifecycle: `usePostPhaseEditor.ts:1181` returns immediately when `pendingEdit` is null, retaining the new `pendingRevisionRef`. Export clearing or failed reload can therefore leave a stale ref. This was observed in source, not reproduced in a mounted browser hook, so it is not classified as a second blocker. Add a null-projection/re-export regression when correcting this lifecycle.
- No browser visual verification, real TTS/render/compositor, full build or broad suite was run. Task 5 owns integrated four-source final-export composition and CI wiring.
- Worker-reported `verify-mcp-edit-draft.ts` exit 1 (21 pass / 13 fail) has legacy immediate-unquoted-create assumptions. It was not independently rerun here; it remains an explicit Task 5 migration obligation, not passing evidence. This review does not waive runtime regressions.


## Fix round 1 independent re-review — `f62f532a`

Verdict: **PASS**, bounded Task 3 scope; no remaining reproduced medium-or-higher blocker.

Reviewed the complete fix diff (two production files plus worker fixture/report). `StaleWebApplyError` now aborts the existing completion transaction on draft/revision mismatch or zero-row CAS update. This rolls back job completion, asset-promotion changes in the same transaction, draft mutation, and project activation together. The outer orchestrator catch converts it to an actionable `stale_revision` failed job through the existing failure/funding path. Normal success still commits through the same shared transaction.

Preserved the original failing probe and created reviewer-only `scripts/review3-cas-fixed-probe.ts`, adapting its actual-worker assertion to safe refusal. It independently verifies: failed job and actionable Apply guidance; no completed output; unchanged prior active source, stored draft and revision; newer caption visible through the actual project GET and MCP get-edit-state; external source retained; quote record, credit balance and minutes unchanged. It runs the ordinary successful script Apply/export/reexport path before its presenter race.

Executed commands, all exit **0**:

- `node --conditions=react-server --import tsx scripts/review3-cas-fixed-probe.ts` — `/tmp/review3-cas-fixed.log`.
- `node --conditions=react-server --import tsx scripts/verify-mcp-external-media.ts` — 81 assertions, `/tmp/review3-external-fixed.log`. Includes late caption, replacement and clear races, followed by normal presenter Apply/export/reexport success.
- `git diff --check`.

Key independent evidence:

```text
PASS REVIEW independent stale Apply refusal: actionable error, no completion output/promotion, prior active source/draft/revision unchanged, newer caption visible in actual webGET and MCP, budget/credits/minutes unchanged
```

“No promotion” above means the prior project source and completed output remain unchanged; the fixture has no prepared AI reroll assets to directly inspect. Same-transaction rollback of those promotions is established by source inspection. A free render can finish before the final CAS rejects application; this review makes no zero-computation claim. Rendering/TTS/composition remain stubbed as previously documented. No new dependencies, shared DB, production writes, agents, full build or broad suites were used.

The null-projection `pendingRevisionRef` observation remains unverified and advisory for Task 5 mounted lifecycle checks. Existing Task 2 advisories and Task 5 integrated/build/browser/legacy-fixture obligations remain unchanged.
