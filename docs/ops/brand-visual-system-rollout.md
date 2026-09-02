# Brand Visual System V1 rollout and rollback

Date: 2026-08-18
Status: Release hardening verified locally; preserve current paid-public access during deploy

## Safety contract

- Keep the shared Credit wallet unchanged. Paid and ever-paid accounts use 2
  credits for each newly generated image.
- Conversion Trial accounts receive one shared Hero AI Image allowance of eight
  successfully delivered images during their seven-day Trial, once per protected
  identity. It never renews every 30 days and failed delivery restores allowance.
  FREE accounts outside an active Conversion Trial see the locked copy on the
  AI-image actions and on pinning a Brand Profile to a project; creating and
  editing Brand Profiles stays open to them (ADR 0059).
- Reused current Visual Beats cost 0. A script or look edit never starts a job;
  new/outdated beats are charged only after an explicit render or reroll.
- Each initial AI B-roll window receives one generated candidate. There is no
  hidden quality retry, generic-treatment fallback, or engine switch. A creator
  who wants another image explicitly starts Scene Reroll and pays the displayed
  two-credit cost (or uses one eligible allowance unit) for that new request.
- A completed Scene Reroll remains a browser-staged candidate until the creator
  presses **Update video** and the replacement derivative finishes. Closing,
  undoing, or replacing that candidate must not overwrite the reusable Visual
  Beat. A staged paid candidate must be applied before it can be moved to
  another window. Apply discovers the candidate from its server-owned asset
  binding and fails closed if client metadata is absent or mismatched. Replaying
  the same request is free; a distinct request is charged once.
- Scene Reroll is available immediately to every capable project already in the
  Paid Public Launch; it has no separate internal-only percentage rollout.
- A successful discounted annual or Founding Price purchase is cash-backed paid
  access. A `DISCOUNT` coupon changes checkout price but never removes capability;
  without a completed payment it grants no capability by itself.
- RunPod Z-Image is the only V1 image route. Do not cross-fallback to another AI
  Engine. Keep generated imagery text-free; subtitles and brand marks stay in
  deterministic layers.
- Trend Packs, reference images, character/LoRA conditioning, and rendered text
  are outside V1 and must not be enabled as part of this rollout.

## Flags (fail closed; preserve the live baseline)

Missing or malformed values resolve to off/control. These are rollback controls,
not instructions to reduce a cohort that is already live. Record and preserve
the current production values before deployment.

Fail-safe defaults are shown below for reference; they are not the deployment
target when production already has a larger live cohort.

```text
BRAND_VISUAL_SYSTEM_ENABLED=0
BRAND_VISUAL_ROLLOUT_PERCENT=0
BRAND_VISUAL_ROLLOUT_STARTED_AT=
BRAND_VISUAL_50_PERCENT_STARTED_AT=
BRAND_VISUAL_TEST_EMAILS=
```

- `BRAND_VISUAL_SYSTEM_ENABLED=1` enables the capability gate.
- `BRAND_VISUAL_ROLLOUT_PERCENT` accepts only `0`, `10`, `50`, or `100`.
- `BRAND_VISUAL_ROLLOUT_STARTED_AT` must be an ISO timestamp. Admission reads
  only the stable rollout bucket and the presence of a valid value here: while it
  is unset or malformed nobody outside the internal canary is admitted, whatever
  the percentage. Account creation date is not part of the decision.
- Admins and the comma-separated `BRAND_VISUAL_TEST_EMAILS` are the internal
  canary while the master switch is enabled, even at 0 percent. No e-mail is
  hard-coded any more.
- Cohorts use a stable `brand-visual-v1` hash; changing 10 → 50 → 100 expands
  the cohort without reshuffling prior treatment accounts.
- Set `BRAND_VISUAL_50_PERCENT_STARTED_AT` once, to the ISO timestamp when the
  50% stage begins. It affects measurement only, never access. The health
  endpoint refuses to authorize 100% when this value is absent or invalid.

Creating, editing, publishing and deleting a Brand Profile is open to every plan
(ADR 0059). Attaching a profile to a project — `PUT /api/editor-projects/<id>/brand-revision`
and `POST /api/brand-library/from-project-look` — and every AI-image action stay
behind the entitlement + rollout gates in wave 0, because a persisted project pin
is an unconditional grandfather clause in the render acceptance (cohort
`existing-pin`). Before deploy add Mew's e-mail to `BRAND_VISUAL_TEST_EMAILS` if
she needs the internal image cohort from a non-ADMIN account.

## Pre-deploy checks

Run locally or in an authorized staging environment:

```bash
npm run verify:brand-treatment-v1
npm run verify:brand-visual-system
npm run verify:broll-rerender
npm run verify:broll-window-gen
npm run verify:hero-image-price
npm run verify:hero-image-resilience
npm run verify:ai-image-reconcile
npx prisma validate
npx tsc --noEmit --pretty false --incremental false
npm run lint
npm run build
git diff --check
```

Also verify the additive migration on a disposable copy, record the current
production flags and confirm the release will not reduce them, then inspect the
diff for secrets, generated quality-gate PNGs, or production data. The reviewed
picker WebPs are expected; raw 21-image gate artifacts remain ignored and local.

As of 2026-08-18, `npm run lint` exits zero but the flat config supplies only
global ignores; representative source files report “File ignored because no
matching configuration was supplied.” Treat lint as **not executed**, not as a
green gate. Do not hide this by deleting generated directories or changing
unrelated rules during this release; TypeScript, focused contracts and the
production build remain mandatory while lint coverage is repaired separately.

`npm audit --omit=dev` currently reports the `deepmerge-ts` recursive-object
stack-exhaustion advisory through the Prisma CLI/config package. The application
source does not import that merge library; `prisma.config.ts` is the only
`prisma/config` import. Do not force a downgrade or an unverified transitive
override during deployment. Recheck the advisory and Prisma's resolved
dependency before every release, and stop if the package becomes reachable from
request-time code or a supported patched Prisma composition becomes available.

## Authorized deployment sequence

Initial Paid Public Launch deployment was authorized on 2026-08-13. Scene
Reroll joins that existing eligible population when this release deploys; it
does not restart the product at an internal-only cohort. Any future expansion
of the broader Brand Visual population still requires the health gates below
and an explicit production stage approval.

1. Capture the current production flag values and deploy code/migration without
   reducing existing Paid Public Launch access.
2. Confirm the existing `/api/cron/reconcile-ai-images` schedule and heartbeat.
   The same pass must settle durable image reservations and fail preview items
   that were queued for more than 30 minutes without a linked image job, so a
   crashed request cannot leave its batch permanently pending.
3. Smoke test `duckyhero`, one Admin, and explicit Free/Trial/Paid accounts while
   leaving the live paid cohort unchanged.
4. Verify create draft → preview → publish revision → pin project → render →
   reopen; then script edit → unchanged reuse + outdated-only generation; then
   single-scene reroll and downgrade/profile-freeze behavior on desktop/mobile.
5. Monitor Scene Reroll settlement, refunds and provider evidence across the
   existing eligible population; do not introduce a new Scene Reroll percentage.
6. If the broader Brand Visual rollout is not already at 100%, preserve its
   existing timestamp/salt and use the health gates before any future expansion.
7. At each future broader rollout stage, wait for at least 100 terminal branded
   image jobs and require every safety check below before expansion.

## Health endpoint and expansion gates

An Admin can read:

```text
GET /api/admin/brand-visual-health?days=30
```

`safety.canExpand` is true only when all of these hold:

- at least 100 terminal branded image jobs;
- usable completed-image rate ≥ 95%;
- 100% of failed/canceled jobs have restored allowance or credits;
- zero reservations older than 30 minutes;
- zero negative Granted/Purchased balances;
- zero invalid allowance rows (limit must remain 8 and reserved + used ≤ 8);
- average RunPod COGS ≤ ฿0.30 per delivered image;
- highest daily RunPod COGS ≤ ฿0.50 per delivered image.

Treat missing/stale COGS data as no-go. Also stop expansion for cross-account
data, incorrect revision pins, silent generation after an edit, double charge,
wrong-wallet settlement, or a Sev-1/Sev-2 incident even if the aggregate gate
is green.

The response also reports branded image terminal latency as
`latency.sampleJobs`, `latency.p50Ms`, and `latency.p95Ms`. Latency is an
operational signal (`latency.blocksCanary` is always false in V1), not an
automatic rollout gate; investigate a sustained regression before expanding.

At 50%, `rollout.canExpandFrom50To100` additionally stays false until all of
these measured funnel checks pass:

- at least 100 new signups reached Step 2 in both control and treatment, with
  at least 100 per cohort having completed the full 24-hour observation window;
- treatment's first-render success rate within 24 hours is no more than five
  percentage points below control;
- among treatment users whose first successful Brand Visual clip has completed
  a full seven-day observation window, at least 20% saved that exact look as a
  Brand Profile or used the same resolved look in a different project.

The endpoint deduplicates each user, keys “same look” from the full resolved
Visual Format + recipe + treatment + Brand Visual Language, and reports both
the numerator and denominator. `funnel.paidConversion7d` counts only cash-paid
subscriptions with a positive billing period inside the seven-day observation
window; credit-pack purchases and later payments are excluded. Paid conversion
remains observational and is not an expansion gate.

## Rollback

Set only:

```text
BRAND_VISUAL_SYSTEM_ENABLED=0
BRAND_VISUAL_ROLLOUT_PERCENT=0
```

This fail-closes new Brand Visual API/UI access. Do not delete profiles,
revisions, project pins, jobs, allowance rows, or ledger entries. Let in-flight
durable jobs reach a terminal state and keep the image reconciliation cron
running so reservations settle or restore exactly once. Existing non-Brand
Video Editor and shared-credit behavior remain available.

After containment, preserve job/provider IDs and inspect the health endpoint,
telemetry cohort fields, credit ledger, allowance reservations, and RunPod
billing buckets before any manual account correction.
