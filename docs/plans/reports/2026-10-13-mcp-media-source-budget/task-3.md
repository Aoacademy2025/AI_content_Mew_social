# Task 3 — External media Held Preview and shared editor/export enforcement

Base: accepted Task 2 `23039d07`. Worktree `mcp-budget-task3`, branch `codex/mcp-budget-task3`. Model: gpt-6-astra, medium, explicit user override. No delegated agents. No production writes, deploy, restart, customer/Linear action, shared database or copied environment.

## Implementation

External quote execution and project drafts retain `brollSource: external` and `stockSource: none`. Both real script and presenter planners author immutable root slot ownership/requirements. Script placeholders are editable B-roll including index zero. Presenter ownership comes from the actual normal cutaway plan before placeholder splitting, preserving real presenter hooks and explicit presenter-owned spans. Temporary presenter backing never fulfills a required cutaway. Historical optional fill-yourself jobs have no new requirement.

A shared server validator resolves the owned quote-bound root across descendants and checks effective pending/applied windows against same-owner ready B-roll MediaImport rows. MCP export, shared `enqueueEditorExport` (web), and final export worker use this authority. Client draft/source/overlay booleans cannot erase requirements. Missing, failed, pending and unfilled windows return actionable indices and next steps. Replacement ownership is also checked before enqueue and in the rerender worker. The existing mergeWindowEdits and import transport/normalization are reused. Original reset/discard retain root policy; final checks prevent incomplete exports. Budget quote lineage and free eligible rerender/export are retained.

The server web projection exposes owner-resolved pending/failed/ready replacements, transition and required-window states. Both desktop/mobile use the same post-phase hook. Readiness polling refreshes existing project GET only while imports are pending; it launches no provider or import worker. Same-revision refresh preserves local changes/clears. Applied web media is promoted with revision CAS and rebased to the new source; stale writes fail. Project GET restores external source from server root even if mutable draft fields request stock.

### Native web upload trust seam

The existing authenticated native upload route registers a ready MediaImport only after its existing B-roll pipeline succeeds. Owner comes from `getCurrentUser`; result path, media kind and duration come from the server pipeline; bytes come from File.size. No client source/path/status/owner field is accepted. Existing paid-plan/feature admission, early content-length limit, image20MB/video200MB limits, MIME/extension validation, disk admission, ffprobe file-only protocol/demuxer guards, pixel limit and server-named output remain in place. No additional fetch/provider/daemon path exists. Native-route fixture proves hostile form metadata cannot mint arbitrary ready media, invalid type is rejected before normalization and failed normalization creates no row. The route fixture stubs normalization; the four-lane integration runs the real normalizer on synthetic bytes.

### Shared bounded edit count

The old export/MCP limit40 stranded external plans whose required slots must all be fulfilled before final export. The parser limit200 also excluded valid BUSINESS600s fast-pacing plans. One shared `MAX_BROLL_WINDOW_EDITS=1500` now bounds validation, MCP draft edits and stored-draft parsing. Public plan duration is at most600s; the existing minimum cadence is500ms (at most1200 raw windows). Five-second placeholder splitting adds at most120 pieces over that conservative raw bound.1500 therefore covers valid public planner output with margin, without changing duration, pricing, provider, upload-byte or disk limits. Source-authoritative export policy rejects missing/oversized root slot plans. Existing validation still deduplicates indices last-wins and merge rejects out-of-range indices. Real planner fixtures cover maximum duration at normal/fast/minimum cadence and one oversized caption; cap+1 is rejected. No broad provider limit was changed.

## Tests-first evidence

Initial pure policy test failed on missing module. Initial real script/presenter fixture then recorded10 intended failures: absent durable requirements, faceless ownership, required export refusal (MCP and shared web), and missing web replacement projection. Fixture setup issues were corrected before recording that behavioral baseline. Later >40 regression failed before the shared bound change. Logs were captured in `/tmp/task3-red.log` and `/tmp/task3-long-red.log` during execution.

## Verification (commands run in this isolated worktree)

Environment: `npm ci --ignore-scripts` exit0; `npx prisma generate` exit0. Fixtures create throwaway SQLite/TMPDIR state. Installed Next route-handler/server-client docs read before route/hook changes.

Each script command below uses `node --conditions=react-server --import tsx scripts/<name>`:

- `verify-external-media-policy.ts`: exit0. Script/presenter ownership, reset/hostile flags, web local-race preservation, >40 and maximum-duration actual planner bounds.
- `verify-mcp-external-media.ts`: exit0,78 assertions. Ordinary USER actual quote approval/consume; actual shared generate-config route/planner; script and presenter Held Preview; URL-image, URL-video, upload-image, upload-video using real upload PUT/token, MediaImport worker and ffmpeg normalization; missing/foreign/pending/failed imports; hook/ownership; direct web export bypass; hostile overlay/draft; actual final worker refusal; original/discard; shared web projection/readiness and CAS/reopen; rerender/export/reexport budget/free ledger preservation; zero image/stock calls and zero AiGenerationJobs.
- `verify-external-web-upload.ts`: exit0. Native normalized-output ownership registration and hostile/failed-input guards.
- `verify-broll-rerender.ts`: exit0,146 checks, including adjusted bounded-count regression.
- `verify-media-import-fetch.ts`: exit0,814 checks.
- `verify-media-import-upload.ts`: exit0,161 checks.
- `verify-media-import-capacity.ts`: exit0,73 checks.
- `verify-mcp-budget-orchestrator.ts`: exit0, ordinary AutoMix/resume regression.
- `npx tsc --noEmit`: exit0.
- Changed-file ESLint plus new files: exit0 (existing unused-variable warnings remain).
- `git diff --check`: exit0.

Evidence boundary: TTS, paid provider, render and compositor work are stubbed in the external integration. Render output bytes are synthetic and are not a real exported video or visual-quality claim. URL transport/provider responses are fixture-controlled; upload PUT, import worker, normalization, database state, quote and shared enqueue/worker code execute. No full build, browser visual pass or live provider run was performed; Task5 owns broad integration and CI wiring for the three new scripts.

## Known legacy fixture failure / Task5 obligation

Exact command: `node --conditions=react-server --import tsx scripts/verify-mcp-edit-draft.ts` => exit1,21 passed/13 failed. Representative output: `FAIL non-beta default create queues` with `{ error: "confirmation_required", code: "confirmation_required" }`; a later fixture throws at `prisma.videoJob.findUniqueOrThrow` because no job was created. These fixtures still assume pre-Task2 unquoted creation and old beta semantics. They must migrate to actual prepare/Studio-approve/consume setup and the full suite must pass in Task5; this failure is not suppressed or presented as passing. Full log `/tmp/task3-verify-mcp-edit-draft.ts.log`.

## Review focus

Root-lineage authority and pending edit CAS, presenter plan ownership, native normalized-upload registration, and web same-revision/local-edit merging deserve independent review. The public import lane and existing budget authority remain the shared implementations. All four sources remain stock, hero-ai-image, automix, external; this task adds no fallback generation.
