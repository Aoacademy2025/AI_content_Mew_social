# Hero Voice Clone continuation review

Date: 2026-09-05. Decision: **NO-GO for Task 7, merge, or deployment.**

Compared `git diff a6fd30ce00005e4c8177bf0e36cba552ae430ae7...HEAD`.
Initial review examined implementation `dcfb9591`; independent follow-up reviewed
the corrections now committed as `e2b4f6c4`. Standards and Spec were reviewed
by separate agents. The explicit canary plan supplies the spec because
`docs/agents/issue-tracker.md` is absent.

## Standards

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
