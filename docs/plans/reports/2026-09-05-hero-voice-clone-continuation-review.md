# Hero Voice Clone continuation review

Date: 2026-09-05. Decision: **NO-GO for Task 7, merge, or deployment.**

Latest approved direct-output increment: `5991c3c6`, with reviewed follow-ups
`debd5578` and `397d679f`. Earlier preparation increment: `654185e5`.
**Coding is not complete.**
The production Task 7 adapter is still absent; synthetic harness success is not
evidence that the actual 44-slot run can execute. The new checks below prepare
that boundary without bypassing the existing Task 6 gates.

Compared `git diff a6fd30ce00005e4c8177bf0e36cba552ae430ae7...HEAD`.
Initial review examined implementation `dcfb9591`; independent follow-up reviewed
the corrections now committed as `e2b4f6c4`. Standards and Spec were reviewed
by separate agents. The explicit canary plan supplies the spec because
`docs/agents/issue-tracker.md` is absent.

## Standards

Direct-output increment: **0 hard violations; 1 new advisory resolved**.
The independent reviewer found duplicated terminal-state definitions. Both
initial authority checking and the transactional recheck now use one positive
creation predicate, accepting only `collecting` direct ablation/baseline phases
with the exact in-flight slot. The SQLite suite tests rejected unknown and
non-direct phases. Follow-up confirmed resolution; the two older branch
advisories below remain, with no new unresolved standards finding.

Independent review of `654185e5`: **0 new hard violations, 0 new advisories**.
The dependency-free loopback client has a concrete child-isolation purpose;
bounded RPC and evaluator preparation introduce no substantiated new smell.
The reviewer independently passed both synthetic transport harnesses and all
16 evaluator tests. The two carried branch advisories below are unchanged.

No hard violations identified against `CLAUDE.md`. The shared private-response
helpers preserve explicit status codes, bodies, custom headers, and no-store
behavior. Local branch naming now follows the allowed `codex/` prefix.

Two advisory heuristics remain:

1. Possible Duplicated Code: the job-audio route's local `parseRange` and
   `src/lib/hero-voice-canary-range.ts` duplicate range parsing. Their accepted
   range forms differ: suffix ranges work in review audio but not job audio.
   Consolidation is a follow-up; no new range behavior was introduced here.
2. Possible Duplicated Code: `src/lib/hero-voice-clone-snapshot.ts` and
   `src/lib/hero-voice-canary-canonical.ts` contain separate JCS serializers with
   different rejection domains. No reachable commitment mismatch was established.
   Consolidation should retain the stronger Unicode/array/object checks.

Follow-up found no new standards blocker. The regression harness bundles real
entrypoints with inert dependencies and the real private-response helper.
The reviewer independently ran that harness successfully. Isolated-claim
validation is covered separately by the real canary runtime suite; the small
boundary harness does not replace it or prove every ordinary-mode auth path.

Standards: **0 hard violations, 2 advisories**; the more consequential advisory
is duplicate canonical serialization.

## Spec

Direct-output increment: **0 new implementation defects; 1 documentation
mismatch resolved**. The plan now states the approved early-close exception
for never-dispatched or terminal/parked collecting runs, with no in-flight slot
or active app job. It retains a sanitized closed `ReviewRun`, never fabricates
listening aggregates, and does not skip lock/reveal on an open blind review.
Account deletion also enumerates the new registry and its declared staging
paths. Follow-up confirmed the documentation and shared creation guard, and
confirmed that invalid delivered audio preserves primary state and the separate
cancellation disposition. No unresolved new Spec finding remains.

Independent review of `654185e5`: **0 confirmed new defects or scope creep**.
Preparation stays fail-closed. Two reviewed execution requirements remain
partial: actual native evaluator qualification and a parent-owned absolute
provider/parking deadline. The 660-second RPC watchdog only bounds a stuck
child; it does **not** meet the plan's first-park-by-dispatch-plus-600-seconds
requirement. Do not enable execution until cancellation/parking survives a
hung or terminated adapter child.

Concrete coding seams, confirmed from the current source:

- **Direct-output registration resolved in this increment.** A bounded WAV
  payload crosses IPC, the parent verifies actual format/hash/duration, and a
  separate run/slot-linked creation intent owns both final/staging paths before
  bytes are written. Signed ledger/provider acceptance binds the immutable
  registry row. Normal and interrupted owner/account close enumerate these
  files without changing the rigid 74-artifact/37-final-file blind pack.
  Worker response/stage observations and evaluator-input transfer are still
  separate missing seams; WAV persistence does not stand in for them.
- Candidate generation currently retains envelope/audio digests, not the actual
  validated stage/metric observations needed later. Capture bounded allowed
  observations at validation and transfer audio/observations for evaluation
  without exposing DB roots, deletion authority, or HMAC keys to the child.
- Objective ranking currently equates a float32-sample hash with a whole-WAV
  hash; reference observations also have distinct WAV/PCM-frame domains.
  Rounded micros can change a near-tied ranking compared with worker binary64
  selection, and the required vocals-stem digest is not emitted by the worker.
  Reconcile/version the observation schema and any worker contract/pin change;
  never synthesize missing observations from the expected manifest.
- Current source/model manifest byte hashes match their verifier constants.
  That is not an observed runtime source-manifest attestation. Complete actual
  evidence capture, evaluator input transfer, and endpoint parking before
  implementing the fixed production adapter entrypoint.

The earlier reviewed corrections follow; their completeness claims concern
those fixes, not completion of the overall plan.

Three code findings were corrected:

1. **Publication gate:** the plan says “Missing or incompatible internal-evaluation
   rights block image publication/use.” The image workflow previously published
   automatically on matching pushes. Its build job now has a literal false
   condition, before registry login/build/push. Re-enabling requires a reviewed
   evidence-backed change. Historical publication before rights clearance remains
   unresolved; a workflow freeze cannot supply retroactive permission.
2. **Isolated auth and credits:** the plan requires “Loopback AI Studio fails
   closed unless marked canary DB/auth/credit/storage bindings pass.” Ordinary
   clone routes previously reached service actors and lazy Clerk user/trial/
   entitlement paths. Marked execution now validates its isolated environment,
   waits for deletion readiness, and resolves only the bound existing test user.
   Identity resolution preserves suspended/policy-denied identities for the
   required route-level 404; dedicated execution auth still rejects them.
   Catalog and job-history reads suppress ordinary monthly credit grants.
3. **Private audio errors:** the plan requires private no-store audio responses
   and opaque identifiers. Path/auth/read exceptions could escape to framework
   telemetry with filenames. The complete audio handler now returns a generic
   private 503 without forwarding the exception or logging its path.

Acceptance remains incomplete: rights/notice and historical-publication evidence,
binding RunPod DPA/retention answers, actual GPU/model and canonical evaluator
evidence, isolated Clerk/credential authority, bounded cost/staging readbacks,
the complete private listening run, and Mew's post-reveal approval remain absent.
Not running Task 7 is the correct outcome under these gates.

Spec: **3 blocking code findings resolved; historical rights and external
acceptance gates remain open.** No remaining blocking code finding was identified
in the final corrections; this review is not a signed Task 6 evidence bundle.

## Verification and delivery boundary

Direct-output increment:

- Real runner integration registers all 26 synthetic direct outputs and reads
  their exact bytes back. Missing bytes and mismatched hashes each stop after
  one accepted intent, zero valid outputs, and 43 unstarted slots; no evaluator
  call follows. Ledger payload projection excludes audio and storage keys.
- Maximum 7 MB WAV validation and real child-process transfer pass. Framing
  buffers chunks linearly and remains bounded; base64 canonical roundtrip
  avoids regex stack overflow at the allowed maximum size.
- New disposable SQLite suite checks cross-owner/run/slot/provider denial,
  immutable repeated writes, corrupt readback, invalid format/size/duration,
  six creation crash points including partial writes and rename, four close
  crash points, and account-deletion recovery with a declared intermediate.
  Recovery is also exercised in fresh Node processes.
- Full canary suite, all 16 evaluator Python tests, clone/private-route/storage,
  Task 2 durable/crash, and existing deletion recovery tests pass. TypeScript,
  scoped ESLint, and diff checks pass. Independent reviewers repeated scoped
  SQLite, direct-audio, and IPC checks.
- Local production builds through `debd5578` pass all 184 pages using fresh
  synthetic SQLite/fake Clerk and masked environment files, with no Sentry
  upload. Browser scan reports zero source maps and authority sentinel files.
  The subsequent `397d679f` CLI metadata correction is covered by the direct-
  audio, full canary, and TypeScript checks; no route/UI behavior changed.
- The additive `CanaryRunOutput` migration is checked in and Prisma regenerated
  locally. No existing column was removed/renamed and no live database was
  touched. `codebase-design` informed the small parent-only read/write interface
  and centralized deletion ownership; `code-review` supplied the two independent
  review axes above.
- No push, authenticated GitHub action, provider mutation, paid job, real voice,
  worker/image pin change, image publication, merge, or deployment occurred.
  The native evaluator and fixed production adapter remain unavailable; the
  parent-owned absolute cancel/park control is still an execution prerequisite.

Earlier preparation increment (`654185e5`):

- Fixed real IPC failures: non-accepted dispositions were rejected as malformed;
  signed capability Buffers were outside the JCS domain. The bridge now preserves
  the exact canonical capability bytes, bounds frames/time, enforces one call
  in flight, settles pending calls on disposal/exit, and suppresses diagnostics.
- Extracted the loopback client without runtime DB/auth imports; added origin/
  slot/capability validation, response-stream limits and deadlines, no retry,
  and generic errors. Regression tests were observed failing before fixes.
- Evaluator schema 2 binds exact dependency-lock bytes and validates every
  distribution pin/hash. Offline wheel inventory, separate preparation gates,
  installed closure/FFmpeg checks, and the Docker canonical-import fix are
  implemented. No real base/wheel/FFmpeg pin or runtime attestation was invented;
  canonical execution remains disabled. The lock checker now also diagnoses
  invalid placeholder pins and the missing dependency-lock digest.
- Canary/ledger/blind-review suite, both new IPC/loopback harnesses, all 16
  evaluator tests, clone/private-route/storage suite, and Task 2 durable/crash
  suite passed. TypeScript, changed-scope ESLint, and diff checks passed.
- Final production build passed all 184 pages using a fresh synthetic SQLite DB,
  fake Clerk values, masked environment-file values, and no Sentry upload.
  Browser static scan found zero source maps and zero server-authority sentinel
  files. This is a local build, not a deployment or runtime qualification.
- No worker/model/image pin changed. No authenticated GitHub operation, push,
  provider mutation, paid job, real audio submission, image publication, merge,
  or deployment occurred. The earlier remote status below was not re-queried
  during this increment; the local publication freeze is still not on GitHub.

Earlier increment verification:

- Clone policy/route/storage tests, new real-entrypoint auth/credit/error/freeze
  regression tests, Task 2 settlement/crash checks, deletion/upload recovery,
  and Task 5 ledger/18-pair review tests passed in this continuation.
- Real auth runtime coverage includes wrong issuer/subject/audience and
  suspended identity versus authorization. All 11 Python evaluator tests passed;
  the canonical evaluator still reports its four expected missing attestations.
- TypeScript and changed-scope ESLint passed. Stale Prisma generated types were
  regenerated locally from the existing schema; no production database changed.
- Final production build of `e2b4f6c4` passed compilation, TypeScript, and all
  184 pages using a throwaway SQLite database and fake Clerk values. Existing
  environment-file values were masked and Sentry upload was disabled.
- Worker build context, model/source locks, and final immutable image identity
  are unchanged. Plan/operator evidence now agrees with the final image report.
- Both public remote tips were unchanged; PR #440 remained open/unmerged at
  `8cf4869a`. The local branch is `codex/hero-voice-clone-prod-audit`.
- All continuation changes are local. Credential rotation remains pending, so
  PR #440 and its remote workflow have not received these fixes or the freeze.
  No paid job, real audio submission, image publication, merge, or deployment
  was performed in this continuation.

Initial findings: Standards 2 advisories; Spec 4 items (3 code findings plus
incomplete acceptance). After correction, Standards retains the 2 advisories;
Spec retains historical rights and the external acceptance blockers.
