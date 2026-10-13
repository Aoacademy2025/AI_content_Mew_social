# External media source reconnaissance — Task 3 preparation

Date: 2026-10-13. Model: gpt-6-astra, medium. Source checkpoint: `4509eb01dd05cdefba0a3afe2bdea8464eff0012`. Dedicated Orca worktree: `mcp-budget-external-recon`. Task 2 is not approved; this is source mapping only, not Task 3 execution. No production code changes, database/provider access, environment copying, tests/build, push, or deployment occurred.

## Finding

Reuse the existing fill-yourself planner, placeholder config, Media Import, Pending Edit Draft, and free B-roll re-render/export chain. Script-only empty editable windows already exist at this checkpoint. `fillYourself` is sufficient for optional empty visuals, but insufficient for REQUIRED external media: it has no durable required-slot policy, no unfilled export refusal, and presenter fill-yourself assigns every span to the presenter. Web projection currently omits pending B-roll replacements entirely. These are the bounded shared-model gaps.

## Existing source and execution path

- `src/lib/mcp/broll-source.ts`: `MCP_BROLL_SOURCES` already contains all four public choices; `mcpBrollJobFields(external)` maps to `stockSource: none`.
- `src/lib/mcp/create-video-input.ts`: shared input accepts external; `cutawayLayout` still describes presenter-only auto/fillYourself.
- `src/lib/mcp/video-quote.server.ts`: `resolveQuoteExecution` builds external jobs with `stockSource: none` and forces `exportMode: hold` (around lines 155–171). Presenter input independently retains `cutawayLayout: auto` by default. No explicit external-source marker is copied into `VideoJobInput`; none also means historical optional fill-yourself. Quote normalized input preserves the public source.
- `src/lib/mcp/video-budget.server.ts`: `consumeVideoQuote` creates `EditorProject.draftJson` with only `createdVia: mcp` (line 65). Therefore project draft currently does not preserve external source for the web. Do not derive external-required behavior solely from none, which would change historical/web optional behavior.
- `src/lib/mcp/orchestrator.ts`: `brollDisabled` is stockSource none (1042). Script path plans windows even if ordinary window mode is off (2852), caps fill-yourself windows at five seconds (2868), skips extract-keywords and fetch-stock (2875/2901), and sends `brollDisabled`, brand background palette, and planned windows to generate-config (2959).
- `src/lib/broll-windows.ts`: `buildBrollWindows`, `buildFixedCountBrollWindows`, `capFillYourselfBrollWindows` supply current timing and stable ordered windows. Reuse them; no second planner.
- Presenter path uses the same cap (2104), `planCutaway(..., {fillYourself: brollDisabled})` (2115), zero visible B-roll ranges, and consequently no stock/image request (2239). It still calls `ensureUploadContentPreflight` to plan scene context; that is not image generation. `buildCutawayBackgroundTimeline` makes a distinct presenter-backed asset per window, preserving sourceIndex and timeline offset. `cutawayPersonRanges` persists the actual presenter spans.
- Both paths may do scene/text preflight; requirement is zero automatic stock/image-generation, not zero narration/planning/render work. Preserve the quote's render disclosure and funding.

## Preview rendering and missing assets

`src/app/api/videos/generate-config/route.ts:728` calls `buildPlaceholderBgVideos` from `src/lib/broll-placeholders.ts` when B-roll is disabled. Every empty slot has `src: ""`, explicit start/end, `brollEnabled: false`, and its own sourceIndex. Distinct windows survive even when empty.

`src/app/api/videos/render/route.ts:931` recognizes the neutral-background config from backgroundColors and uses `prepareFilledWindowRenderAssets`. Empty/disabled windows contribute no asset, so the brand background remains visible. Filled windows are covered separately; one replacement is not stretched across all remaining empty slots. A filled missing/unplayable local file still causes `BrollCoverageError`. `src/remotion/ShortVideoComposition.tsx:689,729` also renders no media for disabled/empty segments. Presenter mode overlays the original clip on presenter ranges, so an intentionally presenter-owned span is valid footage.

This is adequate Held Preview behavior. Do not globally reject placeholders at preview render: required readiness belongs at final-export admission, with renderer asset validation retained for files that disappear later.

## Existing editing and import seams

`src/lib/mcp/edit-tools.ts`:

- `replaceBrollWindowTool` (1214) resolves owner-held root/current base, validates window, rollout eligibility, and hook lock; URL creates `createUrlImport`, upload uses `findOwnedMediaImport` with BROLL_IMPORT_PURPOSES; only import ID is persisted in the Pending Edit Draft.
- `rerenderEditsFor` (1520) owner-scopes imported rows, refuses failed/missing (`import_failed`) or pending/processing (`imports_pending`), then resolves local resultSrc, image/video kind and duration. These useful errors apply only to windows with a stored edit. A never-filled window is never checked.
- `exportVideoTool` (1720) directly exports if `draftHasBrollChanges` is false. This is the primary unfilled-slot bypass. `exportWithWindowEdits` checks imports, makes the free B-roll rerender, then hops to export.
- `editWindows` (601), `reportableWindowEdits`, `mergedBgVideosForReport` already combine base and pending changes for get_edit_state. Add required/readiness observations through shared validation, without treating the report's tolerant merge fallback as export authority.
- `originalWindowEdit` restores root media or presenter ownership. Empty external originals need explicit handling: a reset should restore the empty slot while keeping it required; today's broll/presenter inference can misclassify the reset.

`src/lib/broll-rerender.ts::mergeWindowEdits` spreads each server-owned base window then edits validated fields. It preserves unknown window metadata, activates an empty placeholder on replacement, and clears obsolete presenter timelineAligned/clip offsets. This is the smallest natural carrier for durable per-window requirement/ownership metadata; validate any new field at server creation, never accept caller-provided flags to waive requirements.

Reuse `src/lib/mcp/media-import-tools.ts::createUploadUrlTool`, `src/app/api/mcp-uploads/[token]/route.ts`, `src/lib/media-import/imports.ts::{createUrlImport,findOwnedMediaImport,issueUploadToken,admitUpload}`, `lane.ts::createMediaImportLane`, and `broll-pipeline.ts`. URL fetching remains `fetch.ts::fetchMediaToTempFile` with per-hop pinned safe resolution; upload retains hashed one-use tokens, TTL, byte/disk/admission limits and owner/purpose checks. No new fetch path or daemon is needed.

## Actual presenter ownership and required-slot policy

Current `edit-tools.ts::windowOwner` returns presenter immediately when brollEnabled is false (416–429), even for a faceless empty placeholder. Thus it cannot be used unmodified to exempt required slots: faceless empty visuals would appear presenter-owned. Require actual presenter media/ranges or trusted explicit ownership, distinguishing neutral background from presenter.

`presenterHookLocked` (1175) checks upload-cutaway plus root.cutawayLayout != fillYourself; replaceBrollWindowTool applies that to index zero. External default auto currently locks zero despite the no-provider planner assigning every span to presenter. Resolve hook protection from the actual planned presenter-owned opening span, preserve ordinary auto's actual hook, and allow index zero in faceless projects. Avoid a universal index-zero prohibition or simply unlocking every external opening.

Smallest proposed shared extension: server-authored external source policy plus stable required/owner metadata in the original preview window plan, mirrored in project draft for web loading. Keep requirements across derived preview configs, rerenders, exports, discard and source-original restoration. A required window remains required after being filled; satisfaction is derived from effective owned/ready/enabled media. Do not put the only copy in pendingEditJson, since success clears it. Do not trust an unvalidated web draftJson overwrite to disable requirements; enforce from owned root/chain state and server-authored original plan.

Presenter auto external needs an explicit required B-roll subset while retaining presenter-owned spans. Reuse `planCutaway`'s normal ownership plan to designate that subset and use presenter footage as temporary held-preview backing for unfilled required cutaways; never count that temporary backing as fulfillment. Existing fillYourself assigns ALL spans to presenter, so blindly exempting presenter-owned spans would make external presenter export immediately ready. For explicitly chosen fillYourself, preserve its ownership meaning and designate only actual required cutaway slots; do not convert all presenter footage into mandatory B-roll. This is the narrow semantic decision Task 3 must encode and test, not a reason to invent another planner.

## Authoritative export and persistence seams

Use one shared required-slot validator to combine immutable source/requirement policy, current server preview and the Pending Edit Draft's owner-resolved imports. Refuse empty/disabled required slots, pending/failed/missing imports and missing usable media with window indices and next actions. Style-only edits, discard, original restore, and re-export must not satisfy or erase a requirement. Presenter-owned spans remain valid. Keep no-required historical projects unchanged.

Call that validator from MCP export admission AND `src/lib/editor-export-enqueue.ts::enqueueEditorExport` (88), after owned source/current-project validation (`assertCurrentEditorExportSource`, 154) and before enqueue/funding. Web `/api/videos/jobs` uses this function; a check only in exportVideoTool is bypassable. Keep expectedPendingRevision/pendingEditRevision CAS semantics. A final worker-side check before burn is appropriate defense against queued/direct export and state races; inspect the export branch in orchestrator alongside enqueue validation. Free rerender itself must be allowed to apply replacements, but chain export must validate the resulting authoritative base. Never trust only submitted overlay config.

`src/lib/mcp/pending-edit-draft.ts`: `seedPendingEditDraft`, `loadPendingEditState`, `savePendingEditDraft`, `updatePendingEditDraft`, `discardPendingEditDraft`, `clearPendingEditDraftIfRevision` own CAS and reseeding. Successful export clears/reseeds draft; preserve requirements in root/base model independently. Rerender copies original config in orchestrator (1474); verify preview/export snapshots retain requirement metadata and source across this hop.

## Web parity gap and minimum readers

ADR 0066 requires shared semantics in both clients. `pendingEditForWeb` deliberately omits windowEdits and brollTransition. `src/app/api/editor-projects/[id]/route.ts` returns this projection. `_v2/pending-edit-view.ts` similarly excludes B-roll; `_v2/usePostPhaseEditor.ts` initializes windowEdits to an empty Map (476) and applies pending caption/style fields around 1165. Therefore current web cannot show/apply the agent's pending B-roll assets before export, although rendered replacements survive in base config.

Extend the shared server projection with owner-resolved replacement readiness/media and required-slot states, keep unavailable imports visible as pending/failed rather than silently absent, consume it in pending-edit-view/usePostPhaseEditor, and use existing BrollWindowInspector controls for image/video replacement. Both PostPhase and PostPhaseMobile share that hook. Persist changes through existing shared draft/CAS rather than adding a separate browser-only required model. Preserve local edit races and do not autosave away server requirements. Source preservation also needs project draft initialization/reader mapping; `page.tsx` restores stockSource from draft around 952 and defaults to both, so createdVia alone is insufficient.

## Fixtures to reuse after Task 2 approval

1. `scripts/verify-broll-placeholders.ts`, `verify-broll-fill-yourself-window-cap.ts`, `verify-cutaway-plan.ts`: deterministic empty windows, independent filled coverage and presenter ownership; add durable requirements and index-zero distinctions.
2. `scripts/verify-broll-fill-yourself.ts`: actual orchestrator call capture for script/presenter none and no stock/image calls. Its header explicitly excludes real composite verification. It deletes fixture tables and expects an isolated database; never run against a shared checkout database.
3. `scripts/verify-mcp-budget-orchestrator.ts`: ordinary USER quote approval/consumption, injected caller and disabled network. Its generate-config stub returns bgVideos empty; replace that stub with real shared placeholder/config behavior in external fixtures or it cannot prove usable windows.
4. `scripts/verify-mcp-broll-window-edits.ts`: best end-to-end import/edit scaffold. Real one-use upload PUT and import lane/broll pipeline, fake URL fetch, image/video bytes; pending/failed/foreign imports, protected hook, original, CAS, free rerender and export hop already covered. Extend full URL-image/URL-video/upload-image/upload-video matrix with external required plan and zero-provider spies.
5. `scripts/verify-mcp-edit-persist-export.ts`, `verify-mcp-edit-draft.ts`, `verify-mcp-edit-tools.ts`: repeated export, rendered vs pending state, clear/reseed and web projection. Add same required policy and pending assets through web reopen/export, no loss on discard/re-render, stale revisions and direct web export refusal.
6. Existing `verify-media-import-{fetch,upload,capacity,lane,broll-pipeline}.ts`: retain security/admission regression coverage; no replacement transport.

## Task 2 interaction and limits of this reconnaissance

Source/hold normalization and zero-image quote estimates already exist. Do not duplicate their introduction. Task 2 `checkpointedBudgetCaller` and `holdVideoBudget` wrap orchestrator work; resume in `video-budget.server.ts` updates the held job using budgetCheckpointRevision. The checkpoint cache covers narration/transcribe/keyword/stock calls, not generate-config or final render. New source/required metadata must survive deterministic config reconstruction, final preview output and resume; zero image ceiling remains authoritative at funding seams. Imports are external media, not additional image-generation reservations. Keep render once-per-video eligibility and approved cap enforcement across re-render/export descendants.

Read CLAUDE.md, CONTEXT.md, ADR 0064, 0065, and 0066 (one-edit-model-two-front-ends), plus the approved plan. Orca creation and source-reading commands exited 0; one exploratory rg included nonexistent filename guesses and emitted file-not-found diagnostics, corrected in subsequent targeted reads. No runtime pass is claimed. Only this report was written. Task 3 remains unstarted pending Task 2 approval.
