# Brand Visual System V1 rollout and rollback

Date: 2026-08-13
Status: Paid Soft Launch deployment authorized; stage changes remain gate-controlled

## Safety contract

- Keep the shared Credit wallet unchanged. Paid and ever-paid accounts use 2
  credits for each newly generated image.
- Conversion Trial accounts receive one shared Hero AI Image allowance of eight
  successfully delivered images during their seven-day Trial, once per protected
  identity. It never renews every 30 days and failed delivery restores allowance.
  FREE accounts outside an active Conversion Trial see the locked preview.
- Reused current Visual Beats cost 0. A script or look edit never starts a job;
  new/outdated beats are charged only after an explicit render or reroll.
- RunPod Z-Image is the only V1 image route. Do not cross-fallback to another AI
  Engine. Keep generated imagery text-free; subtitles and brand marks stay in
  deterministic layers.
- Trend Packs, reference images, character/LoRA conditioning, and rendered text
  are outside V1 and must not be enabled as part of this rollout.

## Flags (fail closed)

Missing or malformed values resolve to off/control.

```text
BRAND_VISUAL_SYSTEM_ENABLED=0
BRAND_VISUAL_ROLLOUT_PERCENT=0
BRAND_VISUAL_ROLLOUT_STARTED_AT=
BRAND_VISUAL_50_PERCENT_STARTED_AT=
BRAND_VISUAL_TEST_EMAILS=
```

- `BRAND_VISUAL_SYSTEM_ENABLED=1` enables the capability gate.
- `BRAND_VISUAL_ROLLOUT_PERCENT` accepts only `0`, `10`, `50`, or `100`.
- `BRAND_VISUAL_ROLLOUT_STARTED_AT` must be an ISO timestamp. Accounts created
  before it remain control unless they are internal.
- Admins, `duckyhero@gmail.com`, and comma-separated
  `BRAND_VISUAL_TEST_EMAILS` are the internal canary while the master switch is
  enabled, even at 0 percent.
- Cohorts use a stable `brand-visual-v1` hash; changing 10 → 50 → 100 expands
  the cohort without reshuffling prior treatment accounts.
- Set `BRAND_VISUAL_50_PERCENT_STARTED_AT` once, to the ISO timestamp when the
  50% stage begins. It affects measurement only, never access. The health
  endpoint refuses to authorize 100% when this value is absent or invalid.

## Pre-deploy checks

Run locally or in an authorized staging environment:

```bash
npm run verify:brand-visual-system
npm run verify:hero-image-price
npm run verify:hero-image-resilience
npm run verify:ai-image-reconcile
npx tsc --noEmit
npm run lint
npm run build
```

Also verify the additive migration on a disposable copy, confirm all flags are
off in the release configuration, and inspect the diff for secrets, generated
quality-gate PNGs, or production data. The reviewed picker WebPs are expected;
raw 21-image gate artifacts remain ignored and local.

## Authorized rollout sequence

Initial Paid Soft Launch deployment was authorized on 2026-08-13. Every
subsequent 10→50→100 expansion still requires the health gates below and an
explicit production stage approval.

1. Deploy code and migration with the master switch off.
2. Confirm the existing `/api/cron/reconcile-ai-images` schedule and heartbeat.
   The same pass must settle durable image reservations and fail preview items
   that were queued for more than 30 minutes without a linked image job, so a
   crashed request cannot leave its batch permanently pending.
3. Set the master switch to 1 with rollout 0; smoke test `duckyhero`, one Admin,
   and explicit test Free/Trial/Paid accounts.
4. Verify create draft → preview → publish revision → pin project → render →
   reopen; then script edit → unchanged reuse + outdated-only generation; then
   single-scene reroll and downgrade/profile-freeze behavior on desktop/mobile.
5. Keep the internal canary until settlement and provider evidence is clean.
6. Set `BRAND_VISUAL_ROLLOUT_STARTED_AT` once, then expand to 10%. Do not reset
   that timestamp or the salt between stages. When expanding to 50%, also set
   `BRAND_VISUAL_50_PERCENT_STARTED_AT` to that stage's start time.
7. At each stage, wait for at least 100 terminal branded image jobs and require
   every safety check below before expansion.

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
