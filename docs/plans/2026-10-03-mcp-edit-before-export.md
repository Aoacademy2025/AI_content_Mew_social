# MCP edit-before-export — plan

## Goal

An AI agent using Public HeroAI MCP can stop a clip at its Base Render, fix it (caption text and word breaks, subtitle style and position, headline hook, B-roll windows with its own media), and export **once**, instead of re-creating the whole clip. On 2026-10-03 one agent re-created a single clip 5×, which ran HeyGen and TTS 5 times. The same agent can also start a clip from a HeyGen video the creator rendered themselves. Every tool must work for any MCP client: Grok bot, claude.ai, Codex, Claude Code, OpenClaw, Hermes, Muse AI.

Vocabulary: CONTEXT.md → Held Preview, Pending Edit Draft, Media Import, Agent-neutral Tool, Agent-created Project, Uploaded Presenter Video, Preview Mode, Burn / Export, Cutaway Mode. Decisions: ADR 0063 (preview then server-chained export), **ADR 0064** (Pending Edit Draft), **ADR 0065** (Media Import from any public HTTPS host + upload link), ADR 0056 (subtitle QA is a report).

Interview source: memory `mcp-edit-before-export-2026-10-03`. Pre-flight critic: `docs/plans/reports/2026-10-03-mcp-edit-before-export/critic.md` (B1–B7 / A1–A17). This revision resolves every blocking finding; the finding ids are cited inline.

## Architecture

```
PR-0  security hardening (ships first, independent)
      safe-fetch IP forms + pinned-IP connect · ffprobe/ffmpeg protocol+demuxer whitelist

PR-A  create_video_job(exportMode:"hold")
        └─ P1 path → Preview Mode job carrying mcpHold:true  (no chain trigger fires on it)
      get_edit_state / set_caption_text / merge_captions / split_caption / regroup_captions
      set_subtitle_style / set_headline_hook / discard_edits
        └─ read draft → pure op → validate → CAS write (EditorProject.pendingEditRevision)
      export_video
        └─ free-path pre-check (refuse, never charge) → enqueueEditorExport(base = project.activeJobId)
           linked by mcpRootJobId → get_video_status(rootJobId) reports the latest descendant

PR-B  Media Import: url (guarded fetch) | create_upload_url → PUT /api/mcp-uploads/<token>
        └─ MediaImport row → import lane in mcp-video-worker → shared B-roll / presenter pipeline
      replace_broll_window → draft.windowEdits → export_video = broll-rerender → chained export
      create_video_job(clipUrl|clipUploadId, cutawayLayout) → waiting_import → mode:"upload"
```

Existing code anchors (origin/main `71653011`, verified by the critic):
- MCP server: `src/app/api/[transport]/route.ts` (`createMcpHandler((server)=>…)` L88, `runTool` L66-86, auth L401-440; a stateless new server per POST).
- Chain: `src/lib/mcp/chain-export.ts`:
  - `mcpEditorProjectEnabledFor` L45-47;
  - `createMcpVideoJob` L89-126;
  - `resolveMcpChain` L174-193;
  - `planChainExport` L302-360 (design from `resolvedMcpSubtitleDesignFromInput` L319);
  - `enqueueMcpChainExport*` L420-519;
  - watchdog `recoverLostMcpChainExports` L533-563.
- Chain triggers on `inputJson.mcpChainExport`: `orchestrator.ts` L1270, L3021 · `tools.ts` L154-158 · the watchdog. Status merge: `tools.ts` `chainJobStatus` L151-244.
- Create input: `src/lib/mcp/create-video-input.ts` L26-50 (`script` `.min(1)` L28). Instructions: `src/lib/mcp/onboarding.ts` L88+. Audit in-band error detection: `src/lib/mcp/audit.ts` `isInBandError` L8-13 (keys on `error`).
- Pure caption ops: `src/app/(dashboard)/video-editor/_v2/subtitle-style.ts`:
  - `mergeCaptionWithNext` L111;
  - `splitCaption` L125;
  - `regroupCaptions(original, len, words, fullText, size)` L186;
  - `buildV2BurnConfig` L228;
  - `V2SubConfig` L53.
- Web regroup source: `usePostPhaseEditor.ts` L220-241 (`originalCaptions`, preview `words` / `fullText`).
- Validators:
  - `src/lib/editor-style-preset-contract.ts`;
  - `src/lib/headline-hook.ts` `normalizeHeadlineHook` L159;
  - `src/lib/editor-export-snapshot.ts` L25-37 (snapshot has no headline or logo).
- Export / rerender:
  - `src/app/api/videos/jobs/route.ts` broll-rerender L290-364, export L370-499 (inline logic), clip allowlist L516-523;
  - `src/lib/editor-projects.ts` `assertCurrentEditorExportSource` L452-471;
  - `src/lib/broll-rerender.ts` `rerenderSkipEligible` L343;
  - `src/app/api/videos/render/route.ts` rerender skip cap 10/user/hour L272-277, L427-449;
  - `src/lib/clip-charge.ts` `isBurnAlreadyPaid` L98-112.
- Uploads:
  - `src/app/api/videos/broll-window/upload/route.ts` (limits L43-50, 4096 px L107);
  - `src/app/api/videos/upload-avatar/route.ts` (500 MB, duration probe only; no type / portrait / normalise);
  - `src/lib/broll-upload-admission.ts` (per-process memory).
- Guards and limits:
  - `src/lib/safe-fetch.ts` (`ipIsPrivate` L43);
  - `src/proxy.ts` L27 (`/api/mcp(.*)` public matcher);
  - web clip-duration check = client-side `audioDurationLimitViolation(ms, plan)` (`_v2/Step1Script.tsx` L53-55).
- Worker: `scripts/mcp-video-worker.ts`. nginx streaming pattern: `deploy/nginx.conf` L60-72.

## Global Constraints

**Gate**
- G1. Every new tool is available only when `mcpEditorProjectEnabledFor(user)` is true (same gate and flag as P1: `MCP_EDITOR_PROJECT_PUBLIC`). For other accounts the tools **must not appear in `tools/list`**, and a direct call is refused with `feature_not_enabled`. Task 2 proves per-principal registration first; if it is impossible, execution stops and the session asks Mew (A1).
- G2. The new `create_video_job` fields (`exportMode`, `clipUrl`, `clipUploadId`, `cutawayLayout`) sit in the shared schema, so every account sees them. Non-beta accounts sending any of them are refused with `feature_not_enabled`. `script` stays required unless `clipUrl` / `clipUploadId` is present, which is validated server-side. `create_video_job` without the new fields behaves exactly as today, and a regression test proves it (A2).

**Money**
- G3. No edit tool, `export_video` or Media Import may call HeyGen, TTS, Gemini or any other paid provider, or reserve minutes or credits. No new charge or refund path is created.
- G4. **A refusal never becomes a charge (B3).** Before enqueueing, `export_video` pre-checks that the Burn will be free (`isBurnAlreadyPaid(base videoUrl)`). When window edits are pending it also checks that the re-render is free: `rerenderSkipEligible`, plus the per-user hourly rerender-skip budget from `render/route.ts`.
  - If either check fails, refuse with `export_not_free` (Thai message + `next`).
  - Defence in depth: the MCP-enqueued render carries a server flag. The render route **fails** a flagged job instead of falling through to normal charging.
  - Mew decided 2026-10-03 (Q19 a): refuse, never charge.
- G5. A failed Media Import behind `create_video_job({clipUrl})` leaves zero net charge. Minutes are reserved only after the import is ready and the duration is known, through the existing funding path (`reconcileVideoJobFunding`). No script-based estimate is used for clip jobs (A14).

**Chain linkage (B1, B2, A17)**
- G6. `exportMode:"hold"` sets `inputJson.mcpHold = true` and **not** `mcpChainExport`.
  - All chain triggers skip `mcpHold` jobs: orchestrator L1270 / L3021, `tools.ts` L154-158, `recoverLostMcpChainExports`.
  - `resolveMcpChain` recognises held roots.
- G7. Every job spawned from an Agent-created Project after its root preview (rerender or export) carries `inputJson.mcpRootJobId = <root preview id>`.
  - Idempotency keys: `mcp-export:<rootId>:<draftRevision>` and `mcp-rerender:<rootId>:<draftRevision>`.
  - The existing auto key `mcp-chain:<previewId>` is unchanged.
- G8. `get_video_status(rootJobId)` reports the newest descendant by `createdAt`. Statuses: `held` → `rerendering` → `exporting` → `done` (`videoUrl` of the newest export) or `failed` / `canceled` with failure fields. `previewUrl` and `editorUrl` appear whenever the root is held or done.
- G9. The export source is always `project.activeJobId`: the root preview, or the newest completed rerender. This satisfies `assertCurrentEditorExportSource`. A re-export after an export uses the same base.

**Pending Edit Draft (B4, A8)**
- G10. Storage: new nullable `EditorProject` columns only: `pendingEditJson String?` and `pendingEditRevision Int @default(0)`. Additive, safe for `prisma db push`. Every write is compare-and-swap on `pendingEditRevision`. MCP tools retry once internally, then return `stale_revision`.
- G11. Draft shape and seed source of each field:

| Field | Seeded from |
|---|---|
| `rootJobId`, `baseJobId` | the root; `project.activeJobId` |
| `captions` | latest export `editSnapshot.captions`, else preview captions |
| `originalCaptions`, `words`, `fullText` | latest export snapshot `originalCaptions`, else the preview |
| `cardLen` | snapshot, else the preview / MCP design default |
| `subtitleConfig` | snapshot `subtitleConfig`, else `resolvedMcpSubtitleDesignFromInput(rootInput)` mapped to `V2SubConfig` |
| `captionOverrides` | snapshot (carried through unchanged; MCP never edits it) |
| `headlineHook`, `logoOverlay` | the project's `draftJson` (MCP edits the headline and never the logo) |
| `windowEdits` `[{index, src \| null, importId?, replacementKind}]` | empty |

- G12. Export records the `pendingEditRevision` it applied. On success it clears the draft **only if the revision still matches** (CAS), so edits made while the export ran survive (A8).

**Agent-neutral Tool contract (A3, A4)**
- G13. Clients use only `tools/list` and `tools/call` (no resources, prompts, sampling or elicitation). Inputs are flat zod objects of primitives and string enums, with at most one array of flat objects. The emitted JSON Schema has **no `oneOf` / `anyOf` / `allOf`**. Numeric choices are string enums (`fontWeight: "400" | "600" | "900"`) or ints checked server-side. "Exactly one of" is checked server-side and fails with `invalid_input`.
- G14. The failure envelope for every new tool is `{ error: <code>, code: <code>, message: <Thai>, next: <what to call next> }`. `error` keeps `isInBandError` auditing correct; existing tools keep their shape. Success replies are compact JSON with `next`. No reply requires the client to render an image.
- G15. Exact tool names: `get_edit_state`, `set_caption_text`, `merge_captions`, `split_caption`, `regroup_captions`, `set_subtitle_style`, `set_headline_hook`, `replace_broll_window`, `discard_edits`, `export_video`, `create_upload_url`.

**Edit semantics**
- G16. Captions:
  - `set_caption_text(index, text)` changes text only.
  - `merge_captions(index)` = `mergeCaptionWithNext`.
  - `split_caption(index, leftText)`: `leftText` must be a non-empty proper prefix of the trimmed card text, else `split_text_mismatch`. The cut is proportional to characters, like `splitCaption`.
  - `regroup_captions(cardLen)` = `regroupCaptions(originalCaptions, cardLen, words, fullText, size)`, exactly as the web.
  - **No** per-card colour edits. **No** timing edits.
- G17. `set_subtitle_style` takes flat optional fields: `fontFamily` (12), `fontSize` 30-160, `fontWeight`, `textColor` / `accentColor` `#RRGGBB`, `preset` (the 17 UI presets), `effect` (10), `shadow`, `outline`, `outlineSize` 1-8, `verticalPos` 10-95. Validate with the strict contract in `editor-style-preset-contract.ts`. Keep the web's locked-preset colour rule.
- G18. `set_headline_hook` takes the `HeadlineHookConfig` fields flat, normalised by `normalizeHeadlineHook`. **No** suggestions tool.
- G19. `replace_broll_window(windowIndex, url | uploadId | source:"original")`. The media is muted.
  - Window 0 of a Cutaway Mode clip with `cutawayLayout:"auto"` is refused with `window_locked_presenter_hook`.
  - `export_video` refuses with `imports_pending` while any referenced import is not ready, and with `import_failed` (naming the window) if one failed.
  - A missing window or one belonging to another project fails with `invalid_input`.
- G20. Re-export after any completed export is allowed, within the existing in-flight cap of 3. `discard_edits` resets the draft to the current base's seed.

**Web ⇄ agent**
- G21. The web Post phase loads the pending draft when the draft's `baseJobId` equals the job the editor opens (`project.activeJobId`). It shows a banner: "มีการแก้จาก AI agent ที่ยังไม่ export".
  - A web export sends `expectedPendingRevision`.
  - The jobs export route returns 409 `stale_revision` on mismatch, and the client reloads the draft.
  - Projects without a draft behave exactly as today.

**Media Import (B5, B6, B7, A9–A13)**
- G22. Limits:
  - B-roll: image jpg/png/webp ≤ 20 MB; video mp4/mov/webm ≤ 200 MB, the same as the web.
  - Presenter clip: mp4/mov/webm ≤ 500 MB, the same as the web.
  - Presenter clip, **server-side, MCP imports only**: the checks the web runs in the browser — portrait, and `audioDurationLimitViolation(durationMs, plan)` — plus a 4096 px maximum. The web upload routes are not changed by these (B6).
  - The type is decided by ffprobe, never by `Content-Type` or extension alone.
- G23. Fetch guard:
  - `https:` only.
  - Manual redirects, at most 5. Each hop is validated, and the socket **connects to the vetted IP** (custom `lookup` in `https.request` that rejects private addresses at connect time), closing the DNS-rebinding window.
  - `ipIsPrivate` (hardened in PR-0) blocks IPv4-mapped in hex form (`::ffff:7f00:1`), IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`.
  - The body streams with the byte cap enforced while reading.
  - Connect timeout 10 s, idle-read timeout 30 s, total wall-clock deadline 10 min per import (A10).
- G24. Every ffprobe/ffmpeg call on imported or uploaded media runs with `-protocol_whitelist file` and an explicit input demuxer (`-f` per detected container: mov/mp4, matroska/webm, image2 / png_pipe / webp_pipe). No playlist or concat demuxer, ever (B7). PR-0 applies this to the existing web upload routes too.
- G25. Admission is DB-counted and holds across processes (A9). Per user:
  - at most 3 imports `pending` / `processing`;
  - at most 30 imports per hour;
  - at most 10 `create_upload_url` per hour.

  The limits are checked in the tool call **and** in the PUT route. The worker processes imports fair-share across users (oldest first per user, round-robin across users), with concurrency 2. Defaults accepted by Mew 2026-10-03.
- G26. Upload link:
  - `create_upload_url(kind: "image" | "video" | "presenter")` returns a single-use `PUT` URL plus an `uploadId`, and expires 15 min after issue.
  - The token is ≥128-bit random, stored hashed, and bound to the user and the kind.
  - The PUT route enforces the byte cap while streaming.
  - Add an explicit `src/proxy.ts` public-matcher entry for `/api/mcp-uploads/(.*)` (do not rely on the `/api/mcp(.*)` prefix accident).
  - Add an nginx location with `proxy_request_buffering off` and `client_max_body_size 510M`.
  - Redact the token path segment from nginx access logs, app logs and Sentry (A13).
- G27. Every `uploadId` / `importId` / `clipUploadId` is checked for `MediaImport.userId === caller` and the right purpose. On mismatch, reply `invalid_input` and never reveal that the id exists (A12).
- G28. MCP `clipUrl` is external and never reaches orchestrator `input.clipUrl` directly. The job stores `clipImportId`. After the import is ready, the server sets `input.clipUrl = import.resultSrc` and re-applies the `/api|/renders|/uploads` allowlist (A11). Output filenames are server-generated, in the same directories and under the same retention as web uploads.

**Process**
- G29. No new dependency. No change to the default B-roll, subtitle timing or alignment pipelines (ADR 0056 stands).
- G30. Verification runs on **Node 22**, CI's version (`scratchpad/node-v22.23.3-darwin-arm64` or equivalent). Node 26 hides `mock.module` and cache-busting differences.
- G31. Any new import in `jobs/route.ts` must be added to the editor harness symbol tables (memory `jobs-route-import-harness-gate`).
- G32. `onboarding.ts` instructions stay Thai and agent-neutral; they never name a specific agent product.

## Assurance and Budget

- **PR-0 (T1-T2):** Profile `high-assurance`. Risk **high**: it fixes a live SSRF in the shared URL guard and hardens ffprobe on user uploads. Automatic fix rounds per task: 5.
- **PR-A (T3-T8):** Profile `standard`. Risk **medium**: it adds a public API surface and touches the export/charge path, but only through refuse-don't-charge guards. Automatic fix rounds per task: 2.
- **PR-B (T9-T14):** Profile `high-assurance`. Risk **high**: server-side fetch of attacker-chosen URLs, a token-authenticated upload route, and a user-input boundary. Automatic fix rounds per task: 5.
- Maximum subagent runs: 75.
- Concurrency: fill only live harness slots.
- Usage checkpoints: before execute, after each frontier wave, before each PR's final gate.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Harden `safe-fetch` IP classification | mew-worker-heavy | subagent | — | build+test, code review, security review |
| 2 | ffprobe/ffmpeg protocol + demuxer whitelist on upload routes | mew-worker-heavy | subagent | — | build+test, code review, security review |
| — | **PR-0 gate:** whole-branch review (`model: opus`) + `security-review` → PR → CI green → merge → Mew deploys | mew-reviewer | subagent | 1,2 | whole-branch, security |
| 2b | Pre-existing ffmpeg / SSRF paths (PR-0b, added 2026-10-03) | mew-worker-heavy | subagent | 1,2 | build+test, code review, security review, whole-branch |
| 3 | CI covers every MCP verify script | mew-worker | subagent | — | build+test |
| 4 | Spike + implement per-principal tool registration | mew-worker | subagent | — | build+test, code review |
| 5 | Chain linkage prefactor: `mcpHold`, `mcpRootJobId`, shared `enqueueEditorExport`, free-path pre-check | mew-worker-heavy | subagent | 3,4 | build+test, code review |
| 6 | Tracer: draft lib + hold + `get_edit_state` + `set_caption_text` + `export_video` | mew-worker-heavy | subagent | 5 | build+test, code review |
| 7 | Remaining edit tools + discard + re-export + PR-A instructions | mew-worker | subagent | 6 | build+test, code review |
| 8 | Web Post phase loads the draft + stale guard | mew-worker | subagent | 6 | build+test, code review |
| — | **PR-A gate:** whole-branch review → PR → CI green → merge → Mew deploys | mew-reviewer | subagent | 7,8 | whole-branch |
| 9 | Prefactor: shared B-roll media pipeline + presenter checks module | mew-worker | subagent | PR-0, PR-A merged | build+test, code review |
| 10 | Guarded fetch module (pinned-IP connect, redirects, caps, timeouts) | mew-worker-heavy | subagent | 9 | build+test, code review, security review |
| 11 | `MediaImport` + token schema, `create_upload_url`, PUT route, proxy matcher, nginx, DB admission | mew-worker-heavy | subagent | 9 | build+test, code review, security review |
| 12 | Import lane in `mcp-video-worker` (fair share, deadline, watchdog) | mew-worker-heavy | subagent | 10,11 | build+test, code review |
| 13 | `replace_broll_window` + export applies window edits (rerender → chained export) | mew-worker-heavy | subagent | 12 | build+test, code review |
| 14 | `create_video_job` from a HeyGen clip + `cutawayLayout` + PR-B instructions | mew-worker-heavy | subagent | 13 | build+test, code review |
| — | **PR-B gate:** whole-branch review (`model: opus`) + `security-review` → PR → CI green → merge → Mew deploys | mew-reviewer | subagent | 14 | whole-branch, security |

Branches and worktrees (Orca only):
- PR-0: new worktree `ssrf-hardening`.
- PR-A: this worktree `AI_content_Mew_social-mcp-edit-export`, branch `mew/mcp-edit-export`. It also carries this plan, ADR 0064 / 0065 and the CONTEXT.md terms.
- PR-B: new worktree `mcp-media-import` from `origin/main` after PR-0 and PR-A merge.
- PR-0 and PR-A run in parallel; they touch disjoint files. **PR-0 ships first and on its own** (Mew 2026-10-03, Q20 a): open its PR as soon as its gate passes. Mew deploys it immediately, before PR-A. T3 and T4 run in parallel: T3 owns `package.json` / `ci.yml`, and T4 only adds its verify script to T3's step after T3 lands (A7).

### Task 1 — Harden `safe-fetch` IP classification (PR-0)
- [ ] `ipIsPrivate` blocks:
  - IPv4-mapped in dotted and hex form (`::ffff:127.0.0.1`, `::ffff:7f00:1`);
  - IPv4-compatible `::a.b.c.d` / hex;
  - NAT64 `64:ff9b::/96` (embedded IPv4 checked);
  - 6to4 `2002::/16` (embedded IPv4 checked);
  - Teredo `2001::/32`;
  - the existing ranges.
- [ ] Use `net.BlockList` or explicit parsing, not regex alone.
- [ ] Every caller of `assertSafeFetchUrl` / `isSafeFetchUrl` keeps working (11 routes).
- [ ] Tests (`scripts/verify-safe-fetch.ts`, in CI): each form above, as a literal host and as DNS results (mocked `lookup`), plus public controls that must pass.

### Task 2 — ffprobe/ffmpeg whitelist on upload routes (PR-0)
- [ ] Every ffprobe/ffmpeg invocation on user-supplied media in `broll-window/upload`, `upload-avatar` and the helpers they call gets `-protocol_whitelist file` plus an explicit input demuxer chosen from the extension/MIME allowlist (G24).
- [ ] Behaviour for legitimate files is unchanged.
- [ ] Tests: a `.m3u8` and a concat playlist renamed to `.mp4` are rejected without any network or file access outside the temp file; a normal mp4/mov/webm/jpg/png/webp still passes.

### Task 2b — Pre-existing ffmpeg / SSRF paths (PR-0b, added 2026-10-03 by Mew)
Found by the PR-0 security review (`reports/2026-10-03-mcp-edit-before-export/pr0-security-review.md`); all pre-existing on prod. Mew chose: ship PR-0 alone, fix these in a separate PR-0b. Profile `high-assurance`, risk high, 5 fix rounds. Worktree `ssrf-hardening-2`, based on PR-0's branch (reuses `src/lib/media-probe-args.ts`); merges after PR-0.
- [ ] `/api/videos/thumbnail`: never pass a remote URL to ffmpeg. Download through the safe-fetch guard to a temp file (byte cap), then probe/decode it with G24 args. Close the relative-path folder bypass (`thumbnail/route.ts` ~L310-332).
- [ ] Every other ffmpeg/ffprobe over user-supplied or user-fetched media gets G24 args, or rejects: `videos/upload`, `music/upload`, voice samples, transcribe / composite downloads, and the readers that later open those files (trim-audio, etc.). The review report lists the paths.
- [ ] Fix the transcribe path traversal into ffmpeg (`transcribe/route.ts` ~L996-1009).
- [ ] Render route: on fetch failure never hand the raw URL to Chromium (`render/route.ts` ~L112, L121). Fail instead, or re-validate every redirect hop.
- [ ] The report's Low items: fix them when each is a few lines, otherwise list them in the task report.
- [ ] Legitimate behaviour unchanged. No new dependency.
- [ ] Tests extend `verify-upload-probe-whitelist.ts` or add `scripts/verify-ffmpeg-input-hardening.ts` (in CI). Each path: a hostile input is refused with no outside access; a legitimate file passes.

### Task 3 — CI covers every MCP verify script (PR-A)
Most MCP verify scripts already run via `verify:subtitle-audio-sync` → `verify:mcp-perfect` (ci.yml L66). Not run anywhere: `verify:mcp-parity`, `verify-mcp-audit-status.ts`, `verify-mcp-orchestrator-steps.ts`, `verify-mcp-orchestrator.ts`, `verify-mcp-pipeline-timeout.ts`, `verify-mcp-token.ts`, `verify-mcp-videojob.ts`. Also confirm `verify:heygen-avatar-engines` runs.
- [ ] Each orphan that passes on Node 22 → an npm script → one CI step `MCP verify (all)`.
- [ ] An orphan failing because its behaviour no longer exists is **not** deleted or rewritten. It goes in `scripts/mcp-verify-exclusions.json` with a one-line reason, and is listed in the report for the session (A6).
- [ ] `verify:mcp-ci-coverage` fails when any `scripts/verify-mcp-*.ts`, `scripts/verify-media-import*.ts` or `scripts/verify-safe-fetch.ts` is neither reachable from a CI step nor in the exclusion file.

### Task 4 — Spike + implement per-principal tool registration (PR-A)
- [ ] Find a way for the stateless route to register the new tools only for gated principals, e.g. build the handler per request after `verifyToken`, or read auth inside the server factory. Measure the added latency.
- [ ] If it is not possible, **stop and report** (G1); do not ship "listed but refused".
- [ ] Deliver a helper `registerGatedTool(server, principal, …)` used by every new tool, and the `feature_not_enabled` direct-call refusal.
- [ ] Tests: a beta principal's `tools/list` includes a dummy gated tool, a non-beta one does not, and a non-beta direct call is refused.

### Task 5 — Chain linkage prefactor (PR-A)
- [ ] Extract `enqueueEditorExport({ user, project, sourceJobId, subtitleOverlayConfig, editSnapshot, headlineHook, idempotencyKey, rootJobId? })` from the inline export branch of `jobs/route.ts`. It holds `assertCurrentEditorExportSource`, the in-flight cap, headline normalisation and logo staging. The jobs route and `planChainExport` both call it, with behaviour unchanged (A5).
- [ ] The same for `enqueueBrollRerender(...)` from `jobs/route.ts` L290-364.
- [ ] `mcpHold` (G6) is skipped by all chain triggers. `mcpRootJobId` + idempotency keys (G7). `resolveMcpChain` / `chainJobStatus` report root → newest descendant (G8).
- [ ] Free-path pre-check `assertMcpRenderFree({ userId, baseVideoUrl, rerender? })`: `isBurnAlreadyPaid`, `rerenderSkipEligible` and the hourly rerender-skip budget → `export_not_free`. The render route fails a job flagged `mcpMustBeFree` instead of charging (G4).
- [ ] Tests:
  - a held preview survives a `get_video_status` poll and a watchdog sweep without exporting;
  - the existing auto chain is unchanged;
  - a second export of the same root gets a new key;
  - the 11th rerender in an hour and a missing `ChargedClip` both refuse, with no `ChargedClip` / reservation rows written;
  - the jobs-route harness symbol tables are updated (G31).

### Task 6 — Tracer: draft lib + hold + get_edit_state + set_caption_text + export_video (PR-A)
- [ ] Prisma columns (G10).
- [ ] `src/lib/mcp/pending-edit-draft.ts`: seed per G11 (each field from its named source), load, CAS save, `toBurnConfig(draft)` via `buildV2BurnConfig`, conditional clear (G12). If importing `_v2/subtitle-style.ts` pulls client-only code, move the pure functions to `src/lib/` and re-export them from the old path; never duplicate them.
- [ ] `create_video_job` `exportMode:"hold"` (gated, G2).
- [ ] `get_edit_state(jobId)` returns:
  - `status`, `previewUrl`;
  - `captions` `[{index, text, startMs, endMs}]`;
  - `cardLen`, `subtitleStyle`, `headlineHook`;
  - `windows` `[{index, startMs, endMs, owner, replaced, importStatus}]`;
  - `draftRevision`;
  - `allowed` (fonts, presets, effects, ranges);
  - `next`.
- [ ] `set_caption_text`; `export_video` via `assertMcpRenderFree` + `enqueueEditorExport` (no window edits yet).
- [ ] Shared `verifyAgentNeutralSchemas()` (G13) + envelope check (G14), reused by Tasks 7, 13 and 14.
- [ ] Tests (`scripts/verify-mcp-edit-draft.ts`, added to T3's CI step):
  - hold → `held` with `previewUrl` + `editorUrl`;
  - a text edit keeps the timing;
  - `export_video` produces a `subtitleOverlayConfig` containing the edit;
  - no provider call and no reservation;
  - CAS conflict → `stale_revision`;
  - a concurrent edit during an export survives the clear;
  - non-beta: tools hidden + `exportMode` refused;
  - default create unchanged.

### Task 7 — Remaining edit tools + discard + re-export + PR-A instructions
- [ ] `merge_captions`, `split_caption`, `regroup_captions` (web-identical, G16), `set_subtitle_style` (G17), `set_headline_hook` (G18), `discard_edits` (G20).
- [ ] Re-export (G9, G20).
- [ ] `onboarding.ts`, in Thai: use hold when you plan to check → `get_edit_state` → fix with the small tools → `export_video` once. Re-export is free. Explain `export_not_free` and `stale_revision`. Update `verify-mcp-onboarding.ts`.
- [ ] Tests:
  - every op's invariants;
  - every validation code;
  - the final `subtitleOverlayConfig` reflects merge + split + regroup + every style field incl. `verticalPos` + headline;
  - re-export is free;
  - `discard_edits` restores the seed;
  - `captionOverrides` / logo survive an MCP re-export of a web-exported project.

### Task 8 — Web Post phase loads the draft + stale guard
- [ ] `usePostPhaseEditor.ts` / `EditorV2Shell.tsx`: load precedence and banner (G21).
- [ ] `enqueueEditorExport` accepts `expectedPendingRevision` → 409 `stale_revision`. The client reloads.
- [ ] Either side's successful export clears the draft per G12.
- [ ] Tests: the load precedence harness, the 409, a project without a draft unchanged, the harness symbol tables (G31).

### Task 9 — Prefactor: shared B-roll pipeline + presenter checks (PR-B)
- [ ] Move the post-temp-file steps of `broll-window/upload/route.ts` into `src/lib/media-import/broll-pipeline.ts`: type / size, ffprobe guard with the PR-0 whitelist, 4096 px, Ken Burns / `normalizeForRemotion`, server-named output. The web route calls it, and its behaviour and responses are unchanged.
- [ ] `src/lib/media-import/presenter-checks.ts` (**new**, MCP-only, G22): ffprobe type, portrait, 4096 px, `audioDurationLimitViolation`. Keep the audio. Save to the directory `upload-avatar` uses. `upload-avatar/route.ts` is not changed (B6).
- [ ] Tests: the existing upload verify scripts unchanged, plus pipeline/check unit tests.

### Task 10 — Guarded fetch module
- [ ] `src/lib/media-import/fetch.ts`, exactly per G23. Error codes: `url_not_https`, `url_not_public`, `too_many_redirects`, `file_too_large`, `unsupported_media`, `fetch_failed`, `fetch_timeout`.
- [ ] Tests (`scripts/verify-media-import-fetch.ts`):
  - private forms, direct and via redirect;
  - a rebinding resolver (first lookup public, second private) is refused at connect;
  - `http:` refused;
  - over-cap aborted mid-body;
  - slow-loris hits the deadline.

### Task 11 — Schema, upload link, PUT route, admission
- [ ] Prisma `MediaImport`: `id`, `userId`, `purpose` (`broll_image` | `broll_video` | `presenter`), `source` (`url` | `upload`), `status` (`pending` | `processing` | `ready` | `failed`), `resultSrc`, `errorCode`, `durationMs`, timestamps, `deadlineAt`.
- [ ] Prisma `McpUploadToken`: hash, `userId`, kind, `issuedAt`, `usedAt`, `importId`.
- [ ] `create_upload_url` tool and `PUT /api/mcp-uploads/[token]` (G26), DB admission (G25), ownership checks (G27).
- [ ] Explicit proxy matcher, nginx location, log/Sentry redaction. The report states whether `deploy.sh` applies nginx changes or Mew must `nginx -t && systemctl reload nginx`.
- [ ] Tests (`scripts/verify-media-import-upload.ts`):
  - the token is single-use;
  - it expires after 15 min;
  - it is bound to its user and kind;
  - over-cap PUT is aborted;
  - admission caps hold across two simulated processes;
  - IDOR is refused with no existence leak.

### Task 12 — Import lane in mcp-video-worker
- [ ] Claim `pending` imports fair-share (G25), concurrency 2, separate from video-job slots. Run fetch (url source) → pipeline / checks → `ready` / `failed`. A watchdog fails rows past `deadlineAt`.
- [ ] Tests (`scripts/verify-media-import-lane.ts`): one user's slow import does not block another user's; deadline expiry; a restart mid-processing is recovered by the watchdog.

### Task 13 — replace_broll_window + export applies window edits
- [ ] `replace_broll_window` (G19, G27): `url` creates a MediaImport; `uploadId` attaches one; `source:"original"` restores.
- [ ] `export_video` with window edits: import-readiness refusals → `assertMcpRenderFree(rerender)` → `enqueueBrollRerender` (rootJobId, key per G7) → chained `enqueueEditorExport` from the rerender job (the new `activeJobId`). The chain watchdog covers this hop.
- [ ] Tests:
  - URL path and upload-link path, end to end, with the rendered window `src` set and the audio track = narration only (muted);
  - the rerender is free;
  - the chain survives a restart;
  - window 0 is refused;
  - restore to the original works;
  - the web draft reload after a rerender matches `baseJobId` (G21).

### Task 14 — create_video_job from a HeyGen clip + cutawayLayout + PR-B instructions
- [ ] `create_video_job({clipUrl | clipUploadId, cutawayLayout, exportMode})` (G2, G5, G28): the presenter import, then the job waits in `waiting_import` **without holding a worker slot** (A10). When the import is ready, set `input.clipUrl` (allowlisted), reserve via the funding path, and run `mode:"upload"`. `fillYourself` → `planCutaway(…, {fillYourself:true})`.
- [ ] `onboarding.ts`, in Thai: Media Import. Give a public link if you have one, otherwise `create_upload_url` + PUT. Include the limits, the HeyGen-clip flow and the error codes; keep it agent-neutral. Update `verify-mcp-onboarding.ts`.
- [ ] Tests:
  - import → upload-mode job;
  - an import failure has zero net charge;
  - a landscape or over-duration clip is refused with a code;
  - `fillYourself` gives every window to the presenter;
  - script-less input is accepted only with a clip;
  - non-beta clip fields are refused.

## Acceptance Criteria

- [x] AC0 — `assertSafeFetchUrl` refuses IPv4-mapped (dotted and hex), IPv4-compatible, NAT64, 6to4 and Teredo forms that embed private addresses. Upload routes reject playlist-disguised media without outside access. Both are proven by tests in CI and shipped as PR-0. _(Done: PR #569 + #570, prod `917e60c0`.)_
- [x] AC1 — `create_video_job({exportMode:"hold"})` stops at the Base Render. Nothing is burned, the job survives polls and the watchdog, and `get_video_status` returns `held` + `previewUrl` + `editorUrl`. _(Done: PR #571; `verify:mcp-edit-draft`.)_
- [x] AC2 — On a held job, text edit + merge + split + regroup + style (incl. `verticalPos`) + headline, then one `export_video`, give one clip whose burn config contains every edit. It makes no HeyGen / TTS / Gemini call and reserves or charges nothing. When the free path is unavailable, the reply is `export_not_free` and nothing is charged (tests). _(Done: PR #571; `verify:mcp-edit-tools`, `verify:mcp-chain-linkage`.)_
- [x] AC3 — A window replaced from a URL and from an upload link, then exported, gives a clip with the new media in that window, muted, at no charge (tests on both paths). _(Done: PR #572; `verify:mcp-broll-window-edits` 200/0.)_
- [x] AC4 — `create_video_job({clipUrl})` from a portrait HeyGen clip gives a finished clip with subtitles from the clip's own audio. `cutawayLayout:"fillYourself"` gives presenter-only windows. An import failure costs nothing. _(Done: PR #572; `verify:mcp-clip-import-job` 221/0.)_
- [x] AC5 — Media Import refuses `http:`, private addresses (direct, redirect, DNS, rebinding), over-cap files (aborted mid-stream) and type-spoofed or playlist files, each with its code. The upload link is single-use, expires in 15 min and is bound to its user and kind. Admission caps hold across processes. _(Done: PR #572; `verify:media-import-*`.)_
- [x] AC6 — Non-beta accounts do not see the new tools in `tools/list`. Direct calls and the new `create_video_job` fields get `feature_not_enabled`. `create_video_job` without the new fields behaves exactly as before (regression test). _(Done: PR #572; non-beta `{}` now gets an `invalid_input` envelope instead of SDK -32602 (accepted in T14 review: G2/G13 force it, scripted calls unchanged).)_
- [x] AC7 — CI runs every `verify-mcp-*`, `verify-media-import*` and `verify-safe-fetch` script, or lists it in the reviewed exclusion file, guarded by `verify:mcp-ci-coverage`. All three PRs are green. _(Done: `verify:mcp-ci-coverage`; #569–#572 all green.)_
- [x] AC8 — Every new tool's emitted JSON Schema has no `oneOf` / `anyOf` / `allOf`. Every new-tool failure carries `error` + `code` + `message` + `next`, and is audited as an in-band error. _(Done: T6/T13/T14 reviews.)_
- [x] AC9 — Opening `editorUrl` with a pending agent draft shows the agent's edits and the banner, including after a rerender. A web export over a changed draft gets `stale_revision`. A successful export from either side clears the draft only on a revision match. _(Done: PR #571 + T13 fix round (web export keeps agent window edits).)_
- [x] AC10 — Re-export after a completed export works and is free. `discard_edits` restores the seed, and `source:"original"` restores a window (tests). _(Done: PR #571/#572.)_
- [ ] AC11 (post-deploy, Mew, internal beta) — three agents complete the whole flow from the MCP instructions alone: **Grok bot** (URL import), **Claude via the claude.ai connector** (OAuth), **Codex CLI** (PAT + upload link). Then Mew decides on `MCP_EDITOR_PROJECT_PUBLIC`.

## Out of scope

- Vision / frame pre-export audit: the next round, shared by web and MCP.
- Subtitle X position: the next round.
- Starting the tail avatar earlier: skipped, because it needs a new HeyGen render.
- Green-screen / chroma-key: Mew renders HeyGen clips with a real background.
- Per-card colour overrides and caption timing edits via MCP.
- A headline suggestions tool: agents write their own text.
- Server-side portrait/duration checks on the **web** `upload-avatar` route: the web keeps its browser checks (B6); a separate ticket if wanted.
- Flipping `MCP_EDITOR_PROJECT_PUBLIC`: a human decision after AC11. `NEXT_PUBLIC_CLIP_CUTAWAY=1` and `NEXT_PUBLIC_BROLL_WINDOW_EDIT=1` are already set on prod (checked 2026-10-03).
- #567 (Hero AI Image refund on user cancel): a separate kickoff.
- Prod deploys: Mew decides each one.

## Follow-ups (after execute, 2026-10-04)

Sources: the per-task and whole-branch reviews in the execute ledger. None of these block the internal beta.

**Before flipping `MCP_EDITOR_PROJECT_PUBLIC` (after AC11):**
1. Per-user Media Import byte budget. The free-disk floor stops imports at about 5 GiB free, but one user can still drive the disk down to that floor (about 15 GB/h). This is PR-B security S2, the residual of B1.
2. The upload PUT floor should count in-flight bytes, not only bytes already staged (T11 F1).
3. Import lane fairness:
   - slow-drip URLs from two principals can starve the lane, and other users' imports then expire in the queue;
   - give the queue a longer deadline;
   - fail claimed `processing` rows at worker boot (T12 A1/A2, security A1).
4. A few accounts can fill the global staging budget and lock everyone out of imports (security A3).
5. Node's 300 s `requestTimeout` effectively requires about 1.7 MB/s to upload 500 MB. Raise it for `/api/mcp-uploads/`, or document the speed (T11 A8).
6. HTTP rate limit on PUT token probes. Suspended accounts are not re-checked across MCP (T11).
7. Remux presenter bytes before Remotion/Chromium/composite (security A4).
8. Signed agent URLs remain in SQLite free pages, the WAL and nightly backups (security A8).

**Pre-existing, outside this plan (separate tickets):**
- `/api/heygen/composite` records a `ChargedClip` for every output without checking that `bgVideoUrl` was a charged render. A web user could get a free burn of an arbitrary uploaded video.
- In `/api/videos/jobs`, the upload-mode `clipUrl` check is prefix-only and does not check ownership. Names are unguessable.
- CI's ffmpeg 6.1 hangs the voice filter on audio with no edge silence. Prod runs 4.4, so an Ubuntu 24.04 upgrade would expose it.

**Low / housekeeping:**
- T10:
  - chmod an existing temp dir to 0700;
  - make the sweep reuse the symlink/owner checks;
  - set `rejectUnauthorized` explicitly.
- Unused `ready` imports rely on the general media cleanup. A deploy does not drain imports in flight; they fail at their deadline and cost nothing (N5/N6).
- Admin insights does not show `waiting_import` (N4).
- `verify-hero-script-workspace-browser.mts` rewrites a tracked fixture PNG (N7).
- Lane encodes compete with renders for CPU (security A7).
- The clip ETA of 3–6 min in onboarding is optimistic (T14 A5).
- The remaining T13 advisories (A5–A11, R2–R4). Earlier ones:
  - retry when a draft reload fails;
  - the `editorUrl` doc;
  - the dead `jobsRouteReplaysSameUserIdempotentJob`;
  - PR-0b R1-A1 trusted origins.

**Ops notes from the deploy:**
- Prod nginx was patched by hand on 2026-10-03 at ~19:42 UTC. The backup is `/root/nginx-backups/ai-content.bak-20261003-194230`.
- The live file is `/etc/nginx/sites-enabled/ai-content`. It is a regular file, so keep backups out of `sites-enabled/`.
- Certbot's port-80 server-level redirect now lives inside `location /`, so the `/api/mcp-uploads/` 403 location can win.

## Status
interviewed 2026-10-03 | critic: FAIL → revised 2026-10-03 (B1–B7 resolved in text) | approved: 2026-10-03 (Q19 a, Q20 a) | executed: 2026-10-03→04 (PR-0 #569, PR-0b #570, PR-A #571, PR-B #572) | delivered: 2026-10-04 prod `269c50ad` (AC11 pending, Mew)
