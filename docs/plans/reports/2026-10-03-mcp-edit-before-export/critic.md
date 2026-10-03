# Critic report: MCP edit-before-export plan (pre-flight)

Plan: `docs/plans/2026-10-03-mcp-edit-before-export.md`. Code verified against the worktree (`origin/main` 71653011).

**Overall: FAIL.** There are 7 blocking findings. Most code anchors are accurate: the line numbers, function names and CI facts check out. The blocking problems are in how the plan connects to the existing chain and charge machinery. As written, `hold` would auto-export. Re-export and window edits cannot be linked to the original jobId. The "free" paths can silently charge. The SSRF guard the plan relies on has a known bypass.

## 1. Acceptance criteria

| AC | Verdict | Evidence / gap |
|---|---|---|
| AC1 hold stops, `held` + previewUrl/editorUrl | Partially met | T2 delivers and tests "hold stops without a burn". But the hold mechanism contradicts the code (B1): with the chain marker it auto-exports; without it, `chainJobStatus` is never reached. No test asserts `previewUrl`/`editorUrl` in the `held` reply. |
| AC2 all edits → one export, no paid call | Partially met | Ops are delivered in T2/T3, but no test asserts that the final `subtitleOverlayConfig` contains every edit (verticalPos, headline, merged/split cards). `regroup_captions` cannot match web semantics with the stated draft shape (B4). The "no charge" claim depends on B3. |
| AC3 window from URL and from upload link, muted, free | Partially met | T7 tests cover free rerender, watchdog, window-0 and restore. No test runs the URL path and the upload-link path end to end, and nothing tests "muted". "Free" is not guaranteed (B3). |
| AC4 clipUrl → finished clip; fillYourself | Partially met | T8 tests the import wait, refund, fillYourself and script-less input. The "portrait" and "clip-duration limits" have no web source to reuse (B6), and nothing tests them. |
| AC5 Media Import refusals + 15-min single-use link | Partially met | T6 lists the right tests. But the guard it reuses has a loopback bypass and a DNS-rebinding TOCTOU (B5), and ffprobe is exposed to playlist SSRF (B7). |
| AC6 gate hides tools; default create unchanged | Partially met | T2 tests hidden + `feature_not_enabled` for the new **tools**. No task tests that non-beta calls with the new **fields** (`exportMode`, `clipUrl`, `clipUploadId`, `cutawayLayout`) are refused, and no task adds a regression test for default create. Per-principal hiding is an unproven spike (A1). |
| AC7 CI runs every verify-mcp-* + guard | Partially met | T1 delivers this, but it says to leave failing orphans in place. The guard then fails CI, so "both PRs green" cannot be met (A6). `verify-media-import.ts` does not match the `verify-mcp-*` glob, so the guard does not cover it. |
| AC8 no oneOf/anyOf/allOf; failures carry code+message+next | Partially met | T2 has the schema check. `fontWeight 400\|600\|900` as a literal union emits `anyOf` (A3). The "existing failure-field shape" is `{errorCode, message, userAction, refunded…}`, not `code`/`next` (A4). `runTool`'s own `plan_required`/`internal_error` replies have no `next`. |
| AC9 web loads draft + banner; stale 409; either export clears | Partially met | T4 delivers it. No test covers "MCP export success clears the draft". Clearing unconditionally on success can wipe edits made while the export ran (A8). |
| AC10 re-export free; discard + original restore | Not met as written | The chain key `mcp-chain:<previewId>` is unique per (user, key), so there is exactly one export per preview (B2). No task tests `discard_edits`. |
| AC11 three agents, post-deploy | N/A by design | Manual (Mew); no task needed. |

## 2. Blocking findings

**B1 — `hold` contradicts the chain code.** Every chain trigger keys on `inputJson.mcpChainExport === true`: orchestrator finish (`orchestrator.ts:1270`, `:3021`), poll recovery (`tools.ts:154-158`) and the watchdog (`chain-export.ts:533-563`). Each one auto-enqueues the export whenever none exists. If a held job keeps the marker, the next `get_video_status` or watchdog sweep exports it. If it drops the marker, `resolveMcpChain` returns null (`chain-export.ts:174,190`), so `chainJobStatus` never reports `held` and `get_video_status(jobId)` cannot report the later export.
*Fix:* T2 must specify a separate `mcpHold:true` marker. All three trigger sites and `recoverLostMcpChainExports` must skip it, and T2 must add a test that a held preview survives a poll and a watchdog sweep.

**B2 — No linkage model for re-exports or for rerender → export.**
- `enqueueMcpChainExport` reuses the single unique key `mcp-chain:<previewId>`.
- `resolveMcpChain` recognises only `type:"export"` rows with `sourceJobId === preview.id` under that key (`chain-export.ts:176-193`).
- A second export (AC10) cannot use the key.
- After a broll-rerender, `finishJob` moves `project.activeJobId` to the rerender job, so exporting the original preview fails `assertCurrentEditorExportSource` with `stale_export_source` (`editor-projects.ts:452-471`). The export must then source from the rerender job, which `resolveMcpChain` does not link.

*Fix:* before T2, define:
- the key scheme for exports n≥2 (e.g. `mcp-export:<previewId>:<draftRevision>`);
- how the rerender row links to the preview;
- which row `get_video_status(originalJobId)` reports.

T3 and T7 must then implement and test that scheme.

**B3 — The "free" paths can silently charge.** The Money constraint fails here.
- `rerenderSkipCharge` is rate-capped at 10/user/hour (`render/route.ts:272-277,449`). Past the cap, or on any mismatch, it "falls through to NORMAL charging (never an error)" (`:427-428`).
- `isBurnAlreadyPaid` returns false whenever a `ChargedClip` row is missing (`clip-charge.ts:98-112`; `recordChargedClip` is fire-and-forget `.catch(()=>{})`), and a false result charges the burn.
- An agent looping "free" re-exports or window edits will hit this.

*Fix:* `export_video` must pre-check `isBurnAlreadyPaid(base)` and the rerender rate before enqueueing. When either check fails, refuse with a code (e.g. `export_not_free`) instead of charging. Tests must cover the 11th rerender in an hour and a missing `ChargedClip`.

**B4 — The draft shape cannot represent web state.**
- Web regroup always regroups from `originalCaptions` plus preview `words`/`fullText` (`usePostPhaseEditor.ts:238-241`; `regroupCaptions(original, len, words, fullText, size)` at `subtitle-style.ts:186`). The draft has only `captions`.
- `editSnapshot` (`editor-export-snapshot.ts:25-37`) has no `headlineHook`, so "seed headline from latest export's editSnapshot" is impossible. The web gets the headline, logo and layer visibility from project props, not the snapshot.
- The draft also omits `captionOverrides` and `logoOverlay`, so an MCP re-export of a web-exported project silently drops per-card colours and the logo.
- The preview seed has no subtitle config. The auto path uses `resolvedMcpSubtitleDesignFromInput(previewInput)` (`chain-export.ts:319`).

*Fix:* add `originalCaptions` to the draft and name the seed source of every field: headline/logo from `EditorProject.draftJson`, style from the resolved MCP design. Carry `captionOverrides` and the logo through unchanged.

**B5 — `assertSafeFetchUrl` is not a sufficient guard.**
- The WHATWG URL parser serialises `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`. That form misses the dotted-quad regex at `safe-fetch.ts:44`, falls through every IPv6 check and returns "public": a loopback bypass.
- The guard does not cover NAT64 `64:ff9b::/96`, 6to4 `2002::/16` or IPv4-compatible `::a.b.c.d`.
- It resolves DNS, then `fetch` resolves again (rebinding TOCTOU).
- T6's "exactly as Global Constraints" bakes all of this in.

*Fix:* T6 must harden `ipIsPrivate` for those forms and connect to the vetted IP. One stdlib option is `https.request` with a `lookup` that rejects private addresses at connect time. Add tests for `[::ffff:7f00:1]` and for a rebinding resolver.

**B6 — T5's extraction source does not exist, and "byte-for-byte unchanged" contradicts the presenter limits.**
- `upload-avatar/route.ts` streams the file to `public/renders` and probes duration only (`:204-241`).
- It has no ffprobe type check, no normalisation, no portrait or 4096 px check, no duration limit and no admission.
- So "presenter normalisation (audio kept)" cannot be extracted from it, and the presenter limits in Global Constraints are not "same as web".
- I found no server-side "web clip-duration limit".

*Fix:* state that the presenter checks are new and apply only to MCP imports. Give the duration limit as a number with its source. Keep the web route unchanged.

**B7 — ffprobe/ffmpeg on attacker files is an SSRF and file-read vector.** By default ffmpeg auto-detects HLS and concat playlists. An `.m3u8` saved as `x.mp4` makes ffprobe fetch internal URLs or read local files. The web path has the same exposure, but URL import makes it remote and automatable.
*Fix:* every ffprobe/ffmpeg call on imported files gets `-protocol_whitelist file` plus a demuxer allowlist (mov/mp4/matroska/webm, image demuxers). Add a test with a disguised playlist.

## 3. Advisory findings

- **A1** Per-principal tool hiding is unproven. `createMcpHandler((server)=>…)` (`[transport]/route.ts:88`) gets no auth info, and the gate stop-condition sits mid-T2. *Fix:* make it a time-boxed spike as T2's first step, before any other work.
- **A2** Global Constraints say new `create_video_job` **fields** must be gated, but the shared schema lists them for everyone. T8 also relaxes `script` from `.min(1)` to optional (`create-video-input.ts:28`), which changes the schema for all accounts. *Fix:* state explicitly that fields are "listed, refused with `feature_not_enabled`" for non-beta accounts, and add a test.
- **A3** `fontWeight: 400|600|900` built as a union of number literals emits `anyOf`. *Fix:* use `z.enum(["400","600","900"])` or an int with a server-side check.
- **A4** The failure envelope is ambiguous. The existing tool refusals are `{error, message}`. `isInBandError` (`audit.ts:8-13`) keys on `error`, so a reply with `code` but no `error` is audited as `ok`. *Fix:* fix the envelope as `{error: <code>, code, message, next}` and use it in every new tool.
- **A5** The plan's "same internal function the jobs route and planChainExport use" does not exist. The jobs route inlines its validation, cap, headline normalisation and logo staging (`jobs/route.ts:290-499`), while `planChainExport` calls `createVideoJob` directly. *Fix:* T2 should extract a shared `enqueueExport(...)` that holds `assertCurrentEditorExportSource`, the in-flight cap and the headline normalisation, and name it in the plan.
- **A6** T1 has an internal contradiction: keeping failing orphans and adding a strict coverage guard means red CI. *Fix:* the guard reads a session-approved exclusion list, and the glob also covers `verify-media-import.ts`.
- **A7** T1 and T2 both edit `package.json` and `.github/workflows/ci.yml`, and both are unblocked and run in parallel. *Fix:* add `Blocked by: 1` to T2, or have T2 leave CI wiring to T1's step.
- **A8** "Success clears the draft" is unconditional, so edits saved while the export ran are lost. *Fix:* the export records `pendingEditRevision` at enqueue time, and success clears the draft only on a CAS match.
- **A9** Admission does not work across processes. `brollUploadAdmission` is per-process memory (`broll-upload-admission.ts:16-19`), but imports run in the separate `mcp-video-worker`. Nothing caps pending imports or `create_upload_url` issuance per user, so disk can be exhausted (510 MB per token). *Fix:* use a DB-counted per-user hourly cap plus a pending-import cap, checked in the tool call and in the PUT route.
- **A10** With global import concurrency 1, one slow upstream (slow-loris inside the read timeout) stalls every user's imports. T8's orchestrator also holds a video-job slot while it waits for the import. *Fix:* set a total wall-clock deadline per import and a per-user fair share. Hold the T8 job in a `waiting_import` state instead of blocking a worker slot.
- **A11** Name collision: MCP `clipUrl` (external) vs orchestrator `input.clipUrl` (trusted local path, passed to `/api/videos/transcribe` at `orchestrator.ts:1948`). *Fix:* T8 must store only the import id, set `input.clipUrl = import.resultSrc` after the import is ready, and re-apply the `/api|/renders|/uploads` allowlist (`jobs/route.ts:521`).
- **A12** Import IDOR: the plan never says that `replace_broll_window(uploadId)` and `clipUploadId` must check `MediaImport.userId === caller` and the right purpose. *Fix:* state it and test it.
- **A13** The PUT route is already public only by accident, because `"/api/mcp(.*)"` in `src/proxy.ts:27` also matches `/api/mcp-uploads/…`. Tokens in URL paths also end up in nginx access logs and Sentry. *Fix:* add an explicit matcher entry, and redact the token path segment from logs and Sentry.
- **A14** Script-less upload jobs have no stated preflight or reservation. The MCP create path estimates quota from the script (`estimateClipSecV2`), but a clip's duration is unknown until the import finishes. *Fix:* T8 must say which preflights are skipped and when minutes are reserved (after the import, via `reconcileVideoJobFunding`).
- **A15** The tasks are too large. T6 covers 2 tables, the fetch guard, the tool, the PUT route, nginx, the worker lane, a watchdog and tests, at high-assurance. T2 bundles the schema, the draft library, hold, status, 3 tools, export and the gate spike. *Fix:* split T6 into fetch guard / upload link + PUT + nginx / worker lane. Pull the gate spike and the chain-linkage design out of T2.
- **A16** T4 is blocked by T3 but needs only T2 (the columns and draft library). This is an optional parallelism gain.
- **A17** After an MCP rerender the web shows the rerender job, so the rule "web loads draft when `baseJobId` matches the job shown" stops matching. *Fix:* tie it to the B2 linkage.

## 4. Unsupported claims

- "Presenter clip … portrait, and the web's clip-duration limits", "All files: max dimension 4096 px" (as "same as web"): the presenter route has none of these (B6).
- "`rerenderSkipEligible` makes free" / "`isBurnAlreadyPaid` makes free": only conditionally true (B3).
- "export_video … through the same internal function the jobs route and planChainExport use": no such function exists (A5).
- "seeded from the latest export's `editSnapshot`" for `headlineHook`: the field is not in the snapshot (B4).
- "Failures use the existing failure-field shape … `code` … `next`": the existing shape has neither (A4).

## 5. Readability for the executor

The anchors are accurate and dense: `mcpEditorProjectEnabledFor` L45, `createMcpVideoJob` L89, `planChainExport` L302, the watchdog L533, `chainJobStatus` L151, the caption ops L111/125/186/228, `isBurnAlreadyPaid` L98, `rerenderSkipEligible` L343, the orchestrator modes L1421/1614/1934, `planCutaway` L175, the nginx L63-72 pattern, and ci.yml L66 / L195. The orphan list in T1 is correct. Once B1–B7 are resolved in the text, a worker could execute T1, T3 and T4 without asking. As written, T2, T7 and T8 would each force the worker to design the chain-linkage and charge-guard model on its own.
