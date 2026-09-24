# HERO-54 implementation report

## Scope delivered

Implementation commit: `9571f064f363de6bedc697709b6a1d01ecc0e4f5` (`feat: support explicit HeyGen Avatar IV and V`).

- Added one shared III/IV/V engine contract and preserved missing persisted values as Avatar III on the legacy v2 generation/status path.
- Replaced production discovery with cursor-paginated `GET /v3/avatars/looks?ownership=private`, completed-look filtering, provider-advertised `supported_api_engines`, and a user-plus-full-credential-identity cache boundary.
- Persisted the selected engine through the editor draft, job input, intro/tail provider checkpoint, resume/poll route, preview output, receipt, and MCP input/options.
- Added the v3 audio path: local render path containment, MP3 multipart asset upload, 32 MB and 600 second pre-create limits, explicit IV/V request body, stable account/job/slot/body-bound idempotency keys, zero create retries, v3 polling, and bounded public failures.
- Kept the existing opaque green 1080x1920 MP4 and local compositor. No schema, dependency, HERO billing, subtitle, narration, fallback-engine, splitting, or alpha/WebM change was made.
- Added package script `verify:heygen-avatar-engines` and a required CI step so the new v3 verifier cannot remain an ad-hoc local check.

## Observed RED → GREEN

1. Private catalog contract: the first v3 fixture failed because `parseOwnAvatarLookPage` did not exist. The production loader now filters completed private looks, carries only known provider engine names, follows opaque cursors, and refuses a missing cursor.
2. Credential ownership: the same-user, same-six-character-suffix key-rotation fixture returned stale catalog data. The cache key now includes a SHA-256 identity of the full credential; the rotated account fixture passes without logging or returning the credential.
3. V3 provider contract: the initial verifier had no v3 request builder/submitter. It now observes the exact IV and V request bodies, audio asset upload before create, size/duration refusal before any fetch, one upload plus one create, the stable idempotency header, and ambiguous create response classification.
4. Duration probe portability: `npx tsx scripts/verify-heygen-v3-avatar.ts` failed with `TypeError: parseFfmpegDurationMs is not a function`. The route now uses the existing ffmpeg binary and bounded stderr metadata parsing instead of assuming a separate ffprobe binary; the exact 600 second boundary passes.
5. Durable routing: initial checkpoint/resume fixtures lacked engine/API/idempotency routing. New fixtures prove missing fields remain III/v2, mismatched routes are rejected, IV/V keep v3 across restart, stored provider IDs are polled rather than regenerated, and two bookend slots have distinct stable keys.
6. Pre-create error classification: the adapter fixture first failed because a 422 compatibility refusal exposed `avatar_engine_unknown` instead of the approved Thai message. Catalog timeouts now produce the exact known pre-create refusal, while ambiguous paid-create transport outcomes remain parked and never automatically resubmitted.
7. Receipt/MCP/editor: pre-change fixtures lacked the selected engine, BYOK disclosure, explicit MCP engine, and project recovery state. The amended production-path verifiers now pass those contracts, including Avatar-off and legacy missing-engine behavior.

## Final verification before the build

All commands below ran against commit `9571f064` or the report-only working tree that followed it. No real HeyGen request or customer data was used.

- `npm run verify:heygen-avatar-engines` — pass: private catalog 19, v3 submit/preflight, v3 poll 18, MCP avatar input 19.
- `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-avatar-steps.ts` — pass: 28 adapter/compositor assertions, including zero create retries and pre-create versus ambiguous-create outcomes.
- `npm run verify:avatar-provider-checkpoint && npm run verify:avatar-provider-resume` — pass.
- `npm run verify:avatar-generate-outcome` — pass.
- `npm run verify:editor-job-runtime` — pass.
- `npm run verify:render-receipt` — pass, including exact Avatar IV/BYOK lines and unchanged HERO accounting cases.
- `npm run verify:mcp-perfect` — pass, including explicit engine input and private capability/disclosure options.
- `DATABASE_URL='file:/tmp/hero54-videojob-final-20260924-2.db' npx prisma db push --skip-generate` followed by `DATABASE_URL='file:/tmp/hero54-videojob-final-20260924-2.db?connection_limit=1' node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-mcp-videojob.ts` — pass: 52 disposable-SQLite job/checkpoint/recovery checks.
- `npx tsc --noEmit` — pass.
- Scoped server ESLint across all changed API/engine/checkpoint modules and the new verifier — pass.
- Scoped changed picker/receipt ESLint with the repository's existing `react-hooks/exhaustive-deps` and `react-hooks/set-state-in-effect` baseline rules disabled — exit 0 with one pre-existing unused-disable warning in `Step2Elements.tsx`. Running those files without the baseline exemption reports the existing synchronous state-in-effect findings in `RenderReceiptDialog.tsx`; this change does not alter those effect bodies.
- `git diff --check` — pass.
- Final full build — pending once, after this stable report commit, per the execution order requested by the coordinator. Its result will be appended without changing production source.

The provider fixtures exercise production catalog, request-builder/submitter, generator adapter, poll mapper, checkpoint/resume, job persistence, receipt, and MCP option code. They do not prove a rendered browser interaction, live provider eligibility, provider billing, or a completed live IV/V video. A bounded paid QA was authorized separately for the post-review stage, after the coordinator identifies the HERO HeyGen account and compatible private look; it was not run here.

## Exact implementation file list

Commit `9571f064f363de6bedc697709b6a1d01ecc0e4f5` contains:

```text
.github/workflows/ci.yml
docs/plans/2026-09-24-heygen-avatar-engines.md
docs/plans/reports/heygen-avatar-engines-20260924/progress.md
docs/research/2026-09-24-heygen-avatar-iv-v-api.md
package.json
scripts/editor-project-job-runtime-harness.ts
scripts/verify-avatar-provider-checkpoint.ts
scripts/verify-avatar-provider-resume.ts
scripts/verify-avatar-steps.ts
scripts/verify-editor-project-recovery-hook.ts
scripts/verify-heygen-own-avatars.ts
scripts/verify-heygen-poll-map.ts
scripts/verify-heygen-v3-avatar.ts
scripts/verify-mcp-avatar-input.ts
scripts/verify-mcp-create-input.ts
scripts/verify-mcp-videojob.ts
scripts/verify-render-receipt.ts
scripts/verify-video-options.ts
src/app/(dashboard)/video-editor/_v2/AvatarPickerModal.tsx
src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx
src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx
src/app/(dashboard)/video-editor/_v2/avatar-filter.ts
src/app/(dashboard)/video-editor/_v2/receipt.ts
src/app/(dashboard)/video-editor/_v2/useV2Job.ts
src/app/(dashboard)/video-editor/_v2/useV2Project.ts
src/app/api/[transport]/route.ts
src/app/api/heygen/generate-with-bg/route.ts
src/app/api/heygen/my-avatars/route.ts
src/app/api/videos/jobs/route.ts
src/app/api/videos/poll-avatar/route.ts
src/lib/editor-default-draft.ts
src/lib/heygen-avatar-engine.ts
src/lib/heygen-own-avatars.ts
src/lib/heygen-poll.ts
src/lib/heygen-v3-avatar.ts
src/lib/mcp/avatar-provider-checkpoint.ts
src/lib/mcp/avatar-provider-resume.ts
src/lib/mcp/avatar-steps.ts
src/lib/mcp/create-video-input.ts
src/lib/mcp/orchestrator.ts
src/lib/mcp/video-job.ts
src/lib/mcp/video-options.ts
```
