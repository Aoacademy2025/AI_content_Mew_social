# Subscription-first AI — Paid Public Launch Implementation Plan

> Status: implementation and local verification complete on `mew/subscription-first-ai-launch`; not authorized for production deployment.

**Goal:** Make Hero AI Image, Hero AI Script, and Brand Visual follow one
subscription-first access model, preserve a bounded Hero AI Image conversion
experience for Trial, and make Monthly Active Paying Creators (MAPC) the one
North Star shown at the top of Admin Insights.

**Approved product contract:** See `CONTEXT.md` and
`docs/adr/0008-subscription-first-ai-feature-access.md`. Do not reinterpret the
cohorts during implementation.

**Architecture:** Introduce one server-only Paid-Equivalent Entitlement resolver
that adapts the existing subscription, off-Stripe payment, Bundle, GRANT coupon,
and new audited Administrator Grant evidence. Hero AI Image, Hero AI Script,
Brand Visual, `/api/user/me`, and all paid API routes consume that decision.
Trial access is a separate Conversion Trial decision and never masquerades as
paid. Insights intersects a server-authoritative recurring-paying cohort with
durable creation outcomes; telemetry is used only for non-authoritative funnel
actions such as an upgrade click.

**Tech stack:** Next.js 16 App Router, Prisma/SQLite, Clerk, Stripe, existing
verify-script tests using disposable SQLite databases, PM2 deployment.

## Decisions already approved — do not re-ask

| Area | Decision |
|---|---|
| Paid Public | Non-admin customers with a Paid-Equivalent Entitlement |
| Full-access evidence | Active paid subscription/term, paid Bundle, active course/program `GRANT` coupon, or audited Administrator Grant |
| Not evidence | A raw `User.plan` value, FREE, Trial alone, or a `DISCOUNT` coupon before payment |
| Administrator Grant | Requires target plan, reason, and expiry; permanent requires an explicit permanent choice |
| Trial | Seven days; Hero AI Image only; eight successfully delivered images once per protected account/email identity |
| Trial failure | Failed or undelivered images restore the reserved allowance |
| Trial expiry | Unused images expire; no 30-day renewal; feature becomes a Locked Feature Preview |
| Hero Script on Trial | Preview and upgrade CTA only; no generation API access |
| Locked UX | Feature remains visible and clickable; explain value and paid requirement; link to monthly/annual pricing |
| North Star | MAPC: active recurring monthly/annual payers with at least one Core Creation Outcome in trailing 30 days |
| Core outcome | Completed video, saved/Editor-bound Hero Script, or usable customer-requested Hero AI Image |
| Exclusions from MAPC | Admin/team, coupon-only, Administrator Grant-only, Trial/Free, views, previews, failed jobs, and system retries |
| Insights language | Business meaning visible in Thai; every specialist metric has accessible formula/cohort/source help |
| Launch mode | Paid Soft Launch until security, verification, and 5–7 day production soak gates pass |

## Current production baseline — 2026-08-13

- Production commit: `01901087`; `/api/health` healthy.
- `HERO_AI_IMAGE_PUBLIC=1`: 72/72 external image jobs completed across
  nine external users, with no stale reservation or settlement mismatch.
- `HERO_SCRIPT_PAID_ENABLED=1`, public preview on, Trial/Free rollout both 0%.
  Full generation 4/4 and Editor handoff 3/3 succeeded externally, but Hooks
  failed 13/19 before today's parser repair; no meaningful post-fix soak exists.
- `BRAND_VISUAL_SYSTEM_ENABLED=1`, rollout 0%: no public canary evidence.
  Internal branded-image usable output is 237/282; average cost passes the gate,
  while the highest daily average (฿0.754/image) exceeds the ฿0.50 ceiling.
- Overall external VideoJobs in the last seven days: 115/141 completed; most
  failures were TTS/caption stages, not the render worker.
- `verify:hero-script-launch`, `verify:hero-image-price`,
  `verify:hero-image-resilience`, `verify:brand-visual-system`, TypeScript, and
  production build pass on clean `origin/main`.
- `verify:hero-image-disclosure` and `verify:hero-image-gate` fail because their
  source-shape assertions predate Brand Visual/persisted pins; the runtime
  behavior must be re-proven before updating those contracts.
- `npm audit --omit=dev` reports 1 critical, 28 high, 10 moderate, and 3 low
  production dependency findings. Reachable Next.js middleware/App Router and
  URL-fetching risks are release blockers until patched or explicitly proven
  unreachable and documented.

## Implementation status — local branch

- Workstreams 1–8 are implemented and locally verified. The original audit
  blocker is remediated: production-only and full npm audits both report zero
  vulnerabilities; TypeScript, ESLint, and the Next 16.3 production build pass.
- Both stale Hero Image verifiers now prove the subscription-first policy and
  are green. Hero Script and the full Brand Visual suite are green.
- Disposable migration rehearsal passes integrity, foreign-key, backfill
  dry-run, and schema-diff checks. It also closed the pre-existing Bundle
  migration-history gap with an additive catch-up migration.
- Evidence: `docs/audits/2026-08-13-paid-public-security-triage.md` and
  `docs/audits/2026-08-13-subscription-first-implementation-verification.md`.
- Workstream 9 remains intentionally unexecuted: production backup, migration,
  flags, smoke tests, Paid Soft Launch, Brand Visual 10→50→100 rollout, and
  5–7 day soak require separate approval.

## Global constraints

- Base implementation on the latest `origin/main` in a fresh worktree. The
  current checkout contains unrelated user work and must not be cleaned,
  reset, overwritten, or used as the implementation worktree.
- Port only the approved `CONTEXT.md` additions, ADR 0008, and this plan into
  the fresh branch before code changes.
- No direct push to `main`; no production flag change or deployment is included
  in implementation authorization.
- Access control is server-authoritative. Client booleans exist only for UX.
- Money, credits, Trial allowance, and provider work remain reserve-before-use,
  settle-on-success, restore-on-failure, and idempotent under retries.
- Preserve commercial origin in data. Coupon/Admin access may equal paid product
  capabilities but must never inflate recurring revenue or MAPC.
- Thai customer copy; English code identifiers/comments. Never expose provider
  errors, raw entitlement internals, or secrets to customers or logs.
- Every migration runs first on a disposable production DB copy, with counts
  and invariants reported but no customer PII printed.

## Execution order

| # | Workstream | Blocked by | Exit gate |
|---|---|---|---|
| 0 | Isolated worktree and baseline | — | Clean base build and current verification evidence captured |
| 1 | Repair release gates and dependency security | 0 | Launch verifiers green; no unaccepted reachable Critical/High issue |
| 2 | Canonical Paid-Equivalent Entitlement | 1 | One tested decision matrix for every evidence source |
| 3 | Audited Administrator Grants and legacy backfill | 2 | No raw plan dropdown can create paid access |
| 4 | One-time Conversion Trial allowance | 2 | Eight lifetime images, seven-day expiry, restoration and anti-farming proven |
| 5 | Wire Hero Image, Hero Script, and Brand Visual | 2–4 | UI and every paid API return the same access decision |
| 6 | Locked Feature Preview and conversion telemetry | 5 | FREE/Trial see value + CTA; qualifying cohorts never see an erroneous paywall |
| 7 | MAPC and conversion Insights | 2, 4–6 | Server-authoritative North Star and explained funnel visible to Admin |
| 8 | Integration, migration rehearsal, and security review | 1–7 | Full test/build/security gate green |
| 9 | Paid Soft Launch and staged Brand Visual rollout | 8 | Soak and operational thresholds met before promotion |

---

## Task 0 — Isolated worktree and baseline

**Steps**

- [ ] Fetch `origin/main`; record its commit in this plan's Status section.
- [ ] Create a fresh worktree and branch, suggested name
  `mew/subscription-first-ai-launch`.
- [ ] Copy `.env` only for local build requirements; never commit it. Run
  `npm ci` and `npx prisma generate`.
- [ ] Port the approved domain additions, ADR 0008, and this plan without
  carrying unrelated dirty-worktree files.
- [ ] Run `npx tsc --noEmit`, `npm run build`, relevant verify suites, and
  `npm audit --omit=dev`; store summarized counts in the task report.
- [ ] Export read-only production baseline counts needed to prove migration:
  active Trial, active paid terms, Bundle, GRANT coupon, raw manual paid-plan,
  starter allowance rows/reservations, and the last 30 days of creation jobs.

## Task 1 — Repair release gates and dependency security

**Files**

- Update: `scripts/verify-hero-image-disclosure.ts`
- Update: `scripts/verify-hero-image-gate.ts`
- Update as required: `package.json`, lockfile, and reachable imports identified
  by the audit; remove unused legacy `next-auth` access only after proving no
  route depends on it.
- Create: `docs/audits/2026-08-13-paid-public-security-triage.md`

**Behavior**

- Replace brittle old-string/source-shape assertions with tests of the current
  customer contract: persisted Brand Visual pins, Trial allowance, locked paid
  cards, shared server authorization, rate limit, and no charge before admission.
- Patch direct/transitive dependencies to versions without the reported issue
  where compatible. For a finding that remains, document reachability,
  compensating control, owner, and expiry date; “development-only” must be
  proven from the production dependency tree.
- Specifically exercise middleware authentication, App Router API access, and
  all server-side URL-fetching seams after Next.js/Axios changes.

**Exit criteria**

- [ ] Both previously red Hero Image launch verifiers pass for behavioral reasons.
- [ ] `npm audit --omit=dev` has no unaccepted reachable Critical or High item.
- [ ] Auth bypass, SSRF, request-smuggling/cache, provider URL allowlist, and
  oversized/malformed request regression checks pass.
- [ ] TypeScript and production build pass.

## Task 2 — Canonical Paid-Equivalent Entitlement

**Files**

- Create: `src/lib/paid-equivalent-entitlement.server.ts`
- Refactor: `src/lib/hero-script-rollout.server.ts`
- Refactor: `src/lib/internal-ai-access.ts`
- Reuse/adapt: `src/lib/entitlements.ts`, `src/lib/revenue-cohorts.ts`,
  `src/lib/grant-coupon-entitlement.ts`, and `src/lib/bundle-entitlement.ts`
- Create: `scripts/verify-paid-equivalent-entitlement.ts`

**Interface**

The server resolver returns a stable decision rather than another boolean:

```ts
type PaidEquivalentSource =
  | "subscription"
  | "paid_term"
  | "bundle"
  | "grant_coupon"
  | "administrator_grant"
  | "none";

type PaidEquivalentDecision = {
  canUsePaidFeatures: boolean;
  effectivePlan: "FREE" | "PRO" | "BUSINESS";
  source: PaidEquivalentSource;
  expiresAt: Date | null;
  cashBacked: boolean;
  recurring: boolean;
};
```

Internal Admin/team access remains a separate operational override and is never
reported as Paid-Equivalent or recurring revenue.

**Rules**

- Active subscription or current paid term with matching `PAID` plan-payment
  evidence qualifies.
- Active paid Bundle qualifies and preserves Bundle as its source.
- Active matching `GRANT` coupon qualifies until its own expiry; a `DISCOUNT`
  coupon alone never qualifies.
- Active Administrator Grant qualifies according to its stored plan and expiry.
- Active Trial and a bare PRO/BUSINESS label do not qualify.
- Suspended users fail closed before feature admission regardless of evidence.
- Where valid sources overlap, choose the strongest effective plan, then the
  furthest valid expiry, while retaining a deterministic source precedence for
  reporting. Do not shorten a valid paid entitlement when another source ends.

**Verification matrix**

- [ ] Subscription monthly/annual; cancel-at-period-end while still entitled;
  expired/canceled term; Stripe pending/failed/credit-pack-only.
- [ ] PromptPay/manual paid term active/expired and plan match/mismatch.
- [ ] Bundle active/revoked/expired.
- [ ] GRANT coupon active/timed/permanent/expired; DISCOUNT-only.
- [ ] Administrator Grant timed/permanent/revoked.
- [ ] Trial with/without another valid source, FREE, raw manual plan, suspended,
  Admin/team, and overlapping sources.

## Task 3 — Audited Administrator Grants and legacy backfill

**Files**

- Modify: `prisma/schema.prisma`
- Create: `src/lib/administrator-grant.server.ts`
- Modify: `src/app/api/admin/users/[id]/route.ts`
- Modify: `src/app/api/admin/users/route.ts`
- Modify: `src/app/(dashboard)/admin/users/page.tsx`
- Update: `src/lib/account-hard-delete.server.ts`
- Create: `scripts/backfill-administrator-grants.ts`
- Create: `scripts/verify-administrator-grants.ts`

**Data model**

Add an append-only/auditable Administrator Grant record containing user,
PRO/BUSINESS plan, required reason, starts-at, nullable expires-at, explicit
permanent flag, granting Admin ID, revoked-at, revoking Admin ID, and timestamps.
Index active lookup by user and expiry. Do not encode source only in `User.plan`.

**Admin UX/API**

- Replace direct PRO/BUSINESS plan dropdown mutation with a grant dialog.
- Require plan, reason, and either an expiry date or an explicit permanent
  checkbox. Confirmation summarizes cost-bearing access before commit.
- Show source, reason, grantor, expiry/permanent, and revoke action in the user row.
- Selecting FREE revokes active Administrator Grants transactionally and runs
  the existing entitlement downgrade/credit rules; it must not erase payments,
  coupons, or Bundle evidence.
- Remove or redirect the misleading Users-page “บันทึกชำระ” shortcut that sets a
  term without creating a Payment. Real off-Stripe cash must use the existing
  manual-payment flow so revenue and access share evidence.

**Legacy migration**

- Back up the DB and require zero stale/in-flight allowance reservations.
- Preserve active payment, Bundle, and coupon users as their true sources.
- For existing non-Trial PRO/BUSINESS accounts without those sources, create a
  legacy Administrator Grant: use `planExpiresAt` when present; otherwise mark
  explicit permanent; reason `legacy_admin_plan_backfill`.
- Never convert an active/expired Trial into an Administrator Grant.
- Dry-run prints counts only; apply is idempotent; second apply creates zero rows.

## Task 4 — One-time Conversion Trial allowance

**Files**

- Modify: `prisma/schema.prisma` only if a unique trial-grant key/expiry is
  needed to distinguish legacy windows safely.
- Refactor: `src/lib/starter-ai-image-allowance.server.ts`
- Update: `src/lib/trial.ts`
- Update: all starter-allowance consumers and Brand Visual health checks.
- Create: `scripts/migrate-conversion-trial-allowance.ts`
- Rewrite: `scripts/verify-trial-taste-grant.ts`
- Update: `scripts/verify-starter-ai-image-allowance.ts`

**Rules**

- Eligibility requires an active seven-day Trial and no Paid-Equivalent
  Entitlement. Never-paid FREE outside an active Trial receives zero images.
- Issue at most eight delivered images for the one protected Trial identity.
  The existing `UsedTrialEmail` hash remains the cross-delete/re-registration
  anti-farming guard.
- Anchor the grant to `trialStartedAt`/`trialEndsAt`; remove the rolling 30-day
  window calculation.
- Reservation occurs before provider submission. Completed usable output consumes
  one; failure, cancellation, lost delivery, and stale reconciliation restore one.
- Trial expiry immediately makes unused capacity unavailable. Paying conversion
  switches future images to the normal credit wallet without deleting history.
- Existing 30-day rows are retained as audit history. Migration carries prior
  successful Trial consumption into the one-time cap without granting a fresh
  eight; apply requires no unresolved reservation or fails closed.

**Verification**

- [ ] Fresh Trial gets 8; ninth denied; failure restores; concurrent ninth loses
  atomically; cron reconciliation restores exactly once.
- [ ] Day 8 denies unused images; Trial→FREE never renews; advancing 30/60 days
  never creates a new allowance.
- [ ] Delete/re-register same normalized email cannot obtain another Trial.
- [ ] Paid conversion uses credits; coupon/Admin/Bundle access uses plan credits;
  no path mixes allowance and credits in one image charge.
- [ ] Migration is idempotent and never increases an identity's remaining total.

## Task 5 — Wire all three AI products to the shared decision

**Files**

- Modify: `src/app/api/user/me/route.ts`
- Modify every Hero Image admission point, including
  `src/app/api/videos/jobs/route.ts`,
  `src/app/api/videos/fetch-stock/route.ts`, and
  `src/app/api/videos/broll-window/generate/route.ts`.
- Modify image-job creation so every new `AiGenerationJob` records a durable,
  non-PII product surface (for example Hero video, AutoMix, scene reroll, Brand
  Visual preview, or AI Studio); do not infer MAPC from free-text prompts.
- Modify: `src/lib/hero-script-rollout.server.ts` and all Hero Script route guards.
- Modify: `src/lib/brand-visual-rollout.server.ts`,
  `src/lib/brand-visual-access.server.ts`, and all Brand Visual API/layout gates.
- Update the relevant `verify:*gate`, Hero Script launch, and Brand Visual suites.

**Feature policy**

- Hero AI Image: internal override, Paid-Equivalent full access, or active
  Conversion Trial with remaining allowance. Trial is not reported as paid.
- Hero AI Script: internal override or Paid-Equivalent full access. Everyone
  else receives preview-only access; Trial/Free generation APIs return 403.
- Brand Visual: internal override or a stable percentage of Paid-Equivalent
  customers. Replace the new-account Free/Trial rollout interpretation with a
  paid-cohort rollout; keep 0/10/50/100 stages and existing pinned-project
  recovery semantics.
- A paid customer excluded only by a Brand Visual rollout stage sees “กำลังทยอย
  เปิดให้สมาชิก” rather than an upgrade CTA; a non-entitled account sees the
  payment CTA.

Return structured access per feature from `/api/user/me`, including mode
(`internal`, `paid`, `trial`, `preview`, `rollout_wait`), source, effective plan,
reason, and remaining Trial images. Keep legacy booleans temporarily for client
compatibility, prove parity, then remove them in a separate cleanup.

All APIs use a shared customer-safe 403 contract for payment-required requests
and a distinct allowance-exhausted response. Feature flags still fail closed;
they do not manufacture entitlement.

## Task 6 — Locked Feature Preview and conversion telemetry

**Files**

- Refactor/reuse: `src/components/ui/upgrade-modal.tsx`
- Modify: `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx`
- Modify: Hero Script `HeroScriptLockedPreview.tsx`
- Add or modify the Brand Visual locked/rollout-wait surface.
- Update: sidebar and `/api/user/me` consumers.
- Create/update UI contract verify scripts.

**Customer experience**

- Hero Image and AutoMix AI cards remain visible. Locked cards are buttons, not
  disabled dead ends; opening one shows outcome-focused benefits and the exact
  reason access is unavailable.
- Active Trial shows “8 ภาพครั้งเดียวภายในช่วงทดลอง”, remaining images, and the
  subscription CTA. Exhausted/expired Trial preserves prior output but blocks
  new generation and offers monthly/annual plans.
- Hero Script removes “Trial กำลังทยอยเปิด” wording. Use: “ฟีเจอร์พรีเมียมนี้ไม่
  รวมในช่วงทดลอง — อัปเกรดเพื่อปลดล็อกทันที”.
- Qualifying coupon, Bundle, and Administrator Grant users never see a payment
  lock. Brand Visual rollout-wait users never receive a false “ต้องจ่าย” message.
- Successful payment causes `/api/user/me` to revalidate and unlock without a
  new login.

**Telemetry**

Track one server/client vocabulary with `feature`, `accessMode`, `source`, and
surface: locked preview viewed, feature card clicked, pricing CTA clicked,
checkout started, payment confirmed, first core outcome, allowance exhausted.
Never treat client telemetry as payment or outcome truth.

## Task 7 — MAPC and conversion Insights

**Files**

- Modify: `prisma/schema.prisma` for the non-PII image product surface and
  counts-only North Star snapshot.
- Create: `src/lib/subscription-north-star.server.ts`
- Modify: `src/app/api/admin/insights/route.ts`
- Modify: `src/app/(dashboard)/admin/insights/page.tsx`
- Create: `src/app/api/cron/snapshot-north-star/route.ts`
- Modify: `ecosystem.config.js` to schedule the daily snapshot with the existing
  heartbeat/`CRON_SECRET` conventions.
- Refactor: existing `InfoTip` into an accessible reusable metric-help component
  if needed.
- Create: `scripts/verify-subscription-north-star.ts`
- Update: `scripts/verify-insights-data-quality.ts` and
  `scripts/verify-cost-margin.ts` where contracts overlap.

**Authoritative formula**

- Denominator: unique non-internal customers holding an active recurring
  monthly/annual cash-backed entitlement in the selected as-of state. Course
  coupon, Administrator Grant, Trial, FREE, and credit-pack-only users are out.
- Numerator: denominator users with at least one durable Core Creation Outcome
  completed in `[now-30d, now]`.
- Video outcome: completed customer video with usable output.
- Script outcome: persisted Script saved or sent to Editor; use its durable
  created/updated transition, never the generate-button telemetry.
- Image outcome: one completed `AiGenerationJob(kind=image)` with usable output;
  include only approved Hero video/AutoMix/scene-reroll product surfaces. Brand
  setup previews, AI Studio jobs, and unknown legacy surfaces do not qualify;
  retries remain one job and do not inflate the user count.
- Count each user once even when they complete all three outcome types.
- Exclude Admin/team by role plus the existing internal-email policy.

Add a counts-only `NorthStarDailySnapshot` (no user IDs or PII) and a protected
daily cron that records the live calculation in Asia/Bangkok. If exact historical
entitlement-as-of state cannot be reconstructed from existing ledgers, do not
fabricate a “previous 30 days” delta. Show current MAPC and begin the snapshot
series from launch; display comparison only when a valid snapshot exists. Raw
historical outcomes may be backfilled, but entitlement history may not be
inferred from today's plan label.

**Insights layout**

1. Immediately below the page header and before the revenue panel, show the top
   hero card with visible Thai label “ผู้จ่ายที่ยังสร้างผลงานใน 30 วัน”; `MAPC`
   secondary; value, valid comparison, denominator, and Active Rate.
2. Monthly/annual split and outcome mix (video/script/image).
3. Supporting Activation Funnel, renamed from the old North Star.
4. Conversion Trial funnel: Trial started → first usable Hero Image → allowance
   exhausted → pricing click → plan payment → active creator.
5. Course coupon and Administrator Grant funnels into later subscription,
   reported separately and excluded from MAPC until payment.
6. Guardrails: creation success, system error rate, refunds/restoration, AI COGS
   per converted subscriber, cancellation/at-risk recurring revenue.

**Metric Help**

Every specialist label exposes plain Thai help containing formula, window,
denominator, inclusions, exclusions, and source of truth. The visible subtitle
must still convey the essential meaning. Help opens on hover, keyboard focus,
and mobile tap; it has an accessible name, dismissal behavior, and no
hover-only content.

## Task 8 — Integration and migration rehearsal

- [ ] Run all new verify scripts first, then:
  `verify:hero-script-launch`, `verify:hero-image-gate`,
  `verify:hero-image-disclosure`, `verify:hero-image-resilience`,
  `verify:trial-taste-grant`, `verify:ai-image-reconcile`,
  `verify:brand-visual-system`, Insights/data-quality/payment suites,
  `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- [ ] Run the schema/backfill on two disposable copies: current production and a
  fixture containing overlapping Payment/Trial/Coupon/Bundle/Admin cases.
- [ ] Assert before/after totals: no payment lost, no qualifying access lost, no
  Trial promoted to paid, no allowance increased, no negative credits, no stale
  reservation, and no duplicated grant.
- [ ] Security review all authorization, admin mutation, payment, coupon,
  allowance, URL-fetching, telemetry privacy, and Insights PII boundaries.
- [ ] Manual QA desktop and mobile for each cohort and each feature; include
  payment-confirmation immediate unlock and screen-reader/keyboard Metric Help.
- [ ] Update Hero Script and Brand Visual runbooks to the approved terms and add
  a Paid Soft Launch rollback procedure. Remove the old recurring 30-day starter
  allowance statement everywhere.

## Task 9 — Paid Soft Launch and staged rollout

Production mutation requires separate deploy authorization.

1. Deploy schema and code with Brand Visual paid rollout at 0%; preserve Hero
   Image/Script paid flags and keep Trial/Free Hero Script percentages at 0.
2. Verify `KEY_ENC_SECRET` is present and migrate any existing BYOK/provider
   keys with `scripts/encrypt-existing-keys.ts` before public AI admission.
3. Run backfills in dry-run, compare counts, take DB backup, require empty image
   reservation queue, then apply once and rerun to prove idempotency.
4. Smoke every cohort: subscription, manual paid term, Bundle, GRANT coupon,
   Administrator Grant, active Trial with allowance, exhausted Trial, FREE,
   expired source, suspended user, and Admin/team.
5. Observe Hero Image/Script for 5–7 days after the last production fix. Require
   zero payment/access mismatch, zero double charge, zero lost refund/allowance,
   critical Script journey pass, and no Sev-1/Sev-2.
6. Start Brand Visual at 10% of Paid-Equivalent customers only. Do not expose the
   full feature to FREE/Trial as part of this launch.
7. Before 10→50 and 50→100, require at least 100 terminal branded image jobs at
   each stage, ≥95% usable output, 100% restoration, zero stale/negative/invalid
   settlement, average COGS ≤฿0.30/image, highest daily COGS ≤฿0.50/image, and
   no payment/access/security incident.
8. Promote from Paid Soft Launch only after the soak and gates are documented.
   A marketing campaign is a separate authorization after technical go-live.

**Rollback**

- Brand Visual: set paid rollout to 0 and master flag off for new admission;
  preserve profiles, pins, jobs, and ledgers; let reconciliation finish.
- Hero Script incident: turn paid generation off while leaving the locked preview
  available if safe.
- Hero Image incident: turn public flag off; keep internal recovery and the
  reconciliation cron; never delete jobs/credits to roll back.
- Entitlement/migration incident: fail paid actions closed, retain evidence,
  restore the pre-migration DB only under the existing drain/backup procedure,
  and reconcile external payment events before reopening.

## Acceptance criteria

- [x] One shared resolver makes the same decision for Hero Image, Hero Script,
  Brand Visual, UI state, and every server API.
- [x] Subscription, paid Bundle, active GRANT coupon, and audited Administrator
  Grant users receive the capabilities of their granted PRO/BUSINESS plan.
- [x] FREE/Trial never gain full paid access from a raw plan label; Trial can use
  exactly eight delivered Hero Images once within seven days.
- [x] Locked features remain visible, explain value honestly, and lead to monthly
  or annual payment; eligible users never see the wrong paywall.
- [x] Admin grants require reason + expiry/permanent choice and remain auditable;
  direct plan mutation cannot bypass evidence.
- [x] MAPC is server-authoritative, deduplicated, excludes non-recurring/internal
  cohorts, and is the top Insights metric; Activation is supporting.
- [x] Every specialist Insights metric has accessible, plain-language help.
- [x] Disposable migration rehearsal does not increase Trial allowance, lose access, alter payment
  evidence, double-grant credits, or leak PII.
- [ ] Relevant tests, TypeScript, build, dependency/security review, manual cohort
  QA, and production soak gates all pass before wider rollout.

## Out of scope

- Changing PRO/BUSINESS prices, credit price per image, plan quotas, or Trial
  duration beyond the approved seven days.
- Opening full Hero Script or Brand Visual generation to FREE/Trial.
- Counting coupon/Admin-only users as revenue or MAPC before they subscribe.
- Launch marketing, ad spend, or a production flag/deployment without separate
  authorization.
- A wholesale billing-ledger rewrite; the shared resolver adapts existing source
  ledgers and adds only the missing Administrator Grant evidence.

## Status

interviewed: 2026-08-13
approved by Mew: 2026-08-13
implementation: complete and locally verified
production authorization: granted for the Paid Soft Launch sequence on 2026-08-13; rollout in progress
