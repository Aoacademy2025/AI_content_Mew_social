# HERO-54 — HeyGen Avatar IV/V support

## Goal and authorization
Mew approved the proposed work on 2026-09-24 with “ok approve งานทั้งหมดทำยังไงต่อ”, after the explanation that real support requires compatible engine selection, IV/V generation and clear external-cost disclosure, while keeping III where supported. This approval covers implementation, tests, independent review and PR delivery. Mew subsequently authorized real avatar QA with “ให้เจน avatar qa test ได้เลย”; the owner account was identified privately and verified through Chrome. Mew then requested immediate empirical generation while review continued. The first IV result completed but failed source-background removal; a second distinct IV experiment changed only the documented removal flag and passed source-background removal for this look, under the existing QA authorization. The separate explicit approval to merge/deploy PR539/540/541 was completed at production release55eced5b; it does not silently deploy this new feature. Existing approval satisfies the development front gate; do not restart the session or re-ask routine implementation choices. Session writes spec/copy/routing; workers own production code.

Canonical issue: https://linear.app/mew-social/issue/HERO-54

Base: origin/main55eced5bf74557dcabdfae731c7b5198ce6e6a4c (includes the three approved fixes). Worktree: hero-heygen-iv-v-20260924, branch codex/hero-heygen-iv-v-20260924, created with Orca. Repository root remains read-only. Read CLAUDE.md, CONTEXT.md and relevant ADRs; terminology is referenced rather than copied.

Primary-source evidence: docs/research/2026-09-24-heygen-avatar-iv-v-api.md, especially the green-screen appendix. Confirm schemas against linked official docs if a field is uncertain. No unsupported billing rate or avatar eligibility may be invented.

## Global Constraints
- No production deploy, config/database mutation, cleanup apply, customer send/closure, or Stripe/Sentry mutation for this feature. Automated checks use disposable fixtures and mocked provider boundaries. Mew authorized real paid avatar QA and then requested immediate empirical testing. The coordinator scoped it to the verified owner/default private look and short synthetic narration: one initial IV create plus one distinct corrected IV background-removal experiment after the first completed, each with a new logical key. No automatic paid retries, III/V comparison, fallback or further create is included. Account/avatar identity and positive engine support are required before paid calls.
- Preserve HeyGen BYOK. Do not charge HERO credits for HeyGen, share managed keys, change entitlements/refunds/reservations, add automatic paid engine/avatar/output fallback, or claim an exact external price. Existing billing disclosure remains authoritative.
- Preserve the narration master, bookend/full semantics, 1080x1920 opaque green-screen MP4 and local chromakey/composite behavior. No TTS regeneration, subtitle clock/threshold change, automatic splitting into extra paid jobs, or WebM/alpha redesign.
- Explicitly pin the chosen engine and API version per new VideoJob/provider checkpoint. Missing fields in existing drafts/jobs/checkpoints mean legacy Avatar III/v2. Never reinterpret an in-flight legacy job as IV/V or resubmit an unknown paid outcome.
- Resolve compatibility from fresh selected-look supported_api_engines before a paid create. Names and IDs are not capability evidence. Only private completed looks belong in the picker; no public catalog or other account leakage. Unknown capability fails clearly, never guesses a paid model.
- Keep credentials, account identifiers, raw provider bodies, scripts/audio/media URLs and payment metadata out of public errors, telemetry, logs, reports and PRs. Preserve existing authorization, account ownership and local-media path protections; no new SSRF surface.
- Use the existing dependencies and JSON draft/checkpoint storage. No schema migration or new dependency without a demonstrated necessity and coordinator decision. Work only in the assigned Orca worktree; other agents are working and their edits must not be reverted.
- Observed RED before each behavioral fix, meaningful production-path regressions, scoped lint/types and one full final build; independent spec, whole-branch correctness and security review required. Do not claim live provider success from mocks.

## Product behavior and exact copy
1. Keep current avatar presentation modes (off/full/bookend/bookend-both). Add a separate explicit HeyGen motion-engine choice: labels “Avatar III (เดิม)”, “Avatar IV”, “Avatar V”; heading “รุ่นการสร้าง Avatar”. Legacy missing values stay III. Do not automatically upgrade an existing selection or silently substitute another engine. Display only provider-advertised supported choices (or visibly disable unsupported choices); changing the Avatar must invalidate an incompatible choice and require explicit selection before submit.
2. Reuse the existing private-look picker and account key. Use v3 private look metadata/cursor pagination so the picker has per-look supported engines; preserve completed-look filtering and current cache/auth/error contracts. Do not add a new profile/account default column; persist the engine in project/job JSON.
3. Compatibility helper text: “เลือกรุ่นที่ Avatar นี้รองรับ”. Unknown metadata: “ยังตรวจสอบรุ่นที่ Avatar นี้รองรับไม่ได้ กรุณาลองใหม่”. Incompatible selection: “Avatar นี้ไม่รองรับรุ่นที่เลือก กรุณาเลือกรุ่นที่รองรับหรือเปลี่ยน Avatar”. Missing key/quota/workspace messages keep current owned copy.
4. Extend the existing Render Receipt and regeneration disclosure: selected engine line “HeyGen · Avatar IV” (or III/V), plus “ใช้ HeyGen API key ของคุณ”. External-cost text: “HeyGen คิดค่าบริการแยกตามบัญชีและระยะเวลาที่สร้าง ไม่รวมอยู่ในเครดิต HERO กรุณาตรวจสอบอัตราในบัญชี HeyGen ก่อนยืนยัน”. Do not display a fabricated currency estimate or web-subscription credit rate as an API price. Keep HERO reservation/credit line items exactly as before. Avatar-off paths have no new engine/cost gate. MCP video_options must expose the same capabilities/disclosure and accept explicit engine selection without a hidden upgrade.
5. New IV/V requests use POST/v3/videos with type=avatar, selected look ID, explicit engine.type, uploaded audio_asset_id, resolution1080p, aspect_ratio9:16, output_formatmp4, background{type:color,value:#00FF00}, remove_background=true, documented fit preserving neutral framing. Live QA proved the color alone only paints the canvas; source-background removal is required and depends on matting-trained video avatars. Engine support does not establish matting capability. Upload via POST/v3/assets using MP3 multipart; enforce documented32MB upload and conservative600s audio maximum before paid submission. Unsupported long input copy: “เสียงสำหรับ Avatar รุ่นนี้ต้องยาวไม่เกิน 10 นาที กรุณาเลือกช่วงต้น/ท้ายคลิปหรือใช้เสียงที่สั้นลง”. Oversize input copy: “ไฟล์เสียงสำหรับ Avatar ใหญ่เกินขนาดที่ HeyGen รองรับ กรุณาใช้ไฟล์เสียงที่เล็กลง”. Do not auto-segment or change audio/provider.
6. Keep III generation/status on the current legacy path while supported. IV/V poll GET/v3/videos/{id}; normalize completed/failed/queued states into existing durable checkpoint/resume behavior. Persist engine/API routing for every intro/tail slot. Use stable server/account/job/slot-bound idempotency keys for a logical v3 create, never reuse a key with a changed body; generation retry count remains0, unknown submission remains recoverable/manual, and completed IDs are never resubmitted. Do not add webhooks; existing polling is sufficient.
7. Preserve green MP4 compositor path; v3 has no documented v2numeric scale/offset/matting fields. Do not send invented fields. User layout remains local composite geometry, not provider framing. A provider rejection gets owned actionable error and existing reservation settlement; never retry as another engine/output/resolution to hide incompatibility.

## Implementation task — one vertical slice
Heavy worker owns implementation across catalog/metadata, types/input validation, project draft/UI receipt, provider request/poll adapter, checkpoint/resume and existing verifiers. Expected seams: src/lib/heygen-own-avatars.ts; heygen poll/error helpers; src/app/api/heygen/my-avatars and generate-with-bg; src/app/api/videos/poll-avatar and jobs; src/lib/mcp/{create-video-input,avatar-steps,avatar-provider-checkpoint,avatar-provider-resume,orchestrator}; editor hooks/picker/project/input/receipt; MCP video_options; scripts/verify-* and CI scoped registrations where necessary. Reuse a small shared engine contract rather than duplicate enum/validation across layers. No legacy video-creator redesign.

Accepted test seams: mock only HeyGen transport with official-shape fixtures; drive real private-look loader, job input/persistence, generator mapper, polling/checkpoint resume and V2 receipt/classifier against disposable SQLite where needed. Test both IV and eligible V, and retain III/missing-field legacy behavior. Include private-only pagination, unknown/incompatible engine before paid request, off mode, per-account keys/ownership, actual request body/audio preservation, no duplicate create on park/resume, body/key safety, two bookend slots, malformed errors and bounded public data, confirmed failure settlement and unknown-outcome no-refund/retry semantics, existing composite guards. Tests must exercise real production paths, not reimplement functions. Record RED/GREEN commands and failures.

## Assurance and Budget
- Profile: high-assurance; risk high due paid-provider submissions, account keys and durable recovery.
- Automatic fix rounds:5 maximum, reassess spec after2 heavy-worker failures; escalate after3.
- Maximum child runs:16 for this feature (research/map runs count); three live children maximum plus coordinator. Numeric usage counters unavailable: do not invent them.
- Final scoped suite/types/lint/build and independent task + heavy correctness/security reviews; no redundant full builds by reviewers.

## Execution Directive
| # | Task | Agent | Mode | Blocked by | Review gates |
|---|---|---|---|---|---|
| 1 | Official API facts + local integration map | mew-worker / explorer | subagent | — | source-grounded facts, complete constraints |
| 2 | Complete explicit IV/V vertical slice | mew-worker-heavy | subagent | 1 | RED/GREEN, types/lint/build, independent task review |
| 3 | Whole-branch correctness and security | mew-reviewer-heavy (two independent) | subagent | 2 | all blockers resolved, exact-head CI |
| 4 | Authorized short real-avatar QA | mew-worker-heavy | subagent | 2 | identified account/avatar, bounded calls, inspect media/status; user explicitly allowed QA alongside review |
| 5 | PR/Linear/report delivery | (session model) | inline | 3, 4 | concrete reviewable result, evidence-based live result |

## Acceptance Criteria
- [ ] User can explicitly select a compatible III/IV/V engine for a private look; old projects remain III and incompatible/unknown capabilities are blocked before paid create.
- [ ] Selected engine survives project→job→checkpoint→resume/poll→receipt without silent fallback; III and Avatar-off regressions pass.
- [ ] IV/V use the official v3audio/greenMP4 contract, bounded duration/file size, correct account key and durable provider IDs; unknown submit never triggers another paid job.
- [ ] Receipt names the chosen engine and external BYOK cost, with unchanged HERO accounting and no false exact quote.
- [ ] Per-account ownership, private catalog, path/auth, idempotency and privacy checks pass; no customer data or secrets emitted.
- [ ] Existing source/credits/subtitles/compositor semantics are preserved; no schema/dependency addition.
- [ ] Reviewed PR with canonical Linear issue, passing exact-head CI, red/green evidence, independent correctness/security verdicts, migration deadline and live-smoke limitations.
- [ ] After the required account/avatar identity is supplied, run the authorized short paid QA through the reviewed provider path, inspect video/audio/status and report exact engine, duration and outcome without secrets or customer media exposure.

## Out of scope
Deployment of this new feature, paid rendering outside the explicitly authorized bounded QA, numeric account-specific price quotation, OAuth/managed HeyGen billing, alpha/WebM redesign, new webhook platform, automatic paid fallback, and full removal of every legacy v1/v2 caller. The 2026-11-01 legacy sunset is recorded; remaining legacy III/other routes need a distinct retirement decision rather than silent behavior change.

## Status
approved:2026-09-24 user approved direction and execution | executed:in progress | delivered:pending

## Paid QA authorization — follow-up

Mew explicitly approved actual avatar generation for QA. The owner account was identified privately and verified in Chrome. Its default private completed look advertises III/IV/V. The user explicitly asked to generate immediately while review continued. Test1 used an8.333second synthetic Thai narration and exactlyoneIVcreate: it completed but left source-room pixels inside a green letterbox. Test2 is one distinct controlled IV experiment adding remove_background=true, with the same owner/look/audio and a new logical key after the first completed. No automatic paid retry, III/V comparison, avatar substitution, further create or segmentation is included. Use the reviewed local feature path and read/poll/download only its generated test output. Do not deploy the new feature merely to perform QA. Public/Linear/GitHub reports contain sanitized dimensions/duration/engine/status and assessment, not keys, account IDs or provider/media URLs. Actual account-specific charge must not be inferred from public rates.


Paid QA completed: both distinct IV jobs completed. Test2 removed the source-room background in all four sampled frames and passed a simple chromakey sanity check (1080×1920 H.264 MP4, 8.322seconds, AAC). It used an immutable reviewed-helper snapshot with only the remove_background field changed at the fetch boundary, so it proves that provider parameter for this look rather than final revised application integration. No III/V or other-look live success is claimed. See the sanitized orchestration report hero54-live-qa.md. No further paid creates are included.
