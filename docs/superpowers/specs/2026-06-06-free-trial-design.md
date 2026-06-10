# Design — Free Trial (public 7-day auto PRO trial)

**Date:** 2026-06-06
**Owner:** Mew (Payment/pricing vertical)
**Status:** Approved (design), pending implementation plan
**Part of:** Campaign Phase 2 (after Founding-100)

## Problem

The funnel has no trial: a new signup lands on **FREE** (2 clips, no HeyGen/ElevenLabs/editor)
and must pay before experiencing the product. We want every new user to **auto-start a 7-day
PRO trial on signup (no credit card)**, then **revert to FREE and be prompted to upgrade
annually** when it ends. The same mechanism must support a longer **community 1-month** trial
that the future claim/allowlist page will grant — so the trial logic takes a configurable
duration. One trial per user (anti-abuse).

A key constraint: **the app has no automatic plan downgrade.** Feature gates read
`user.plan` directly (e.g. `isFree(dbUser.plan)` in `videos/render`, `user.plan === "FREE"`
in `contents`); nothing compares `planExpiresAt` to now. So the trial must introduce its own
revert-to-FREE path — scoped to trial users only, leaving existing paid behavior untouched.

## Decisions (confirmed)

- Trial grants **PRO** (not BUSINESS) for **7 days** (public), counted from signup.
- **No credit card** — on expiry the user reverts to FREE and is prompted to upgrade annually
  (the campaign's "prompt annual offer"); no Stripe auto-charge.
- **Auto on signup** — granted at user creation, not opt-in.
- **One trial per user** — `trialStartedAt` is set once and never cleared (anti-abuse guard).
- **Configurable duration** — `grantTrial(userId, days)`; community 30-day granting is **out of
  scope** here and will be done by the claim page calling the same function.
- A **banner shows during the trial** ("PRO trial — X days left") and after it ends
  ("trial ended — upgrade annually").

## Architecture

Six parts. `trialEndsAt` is the single marker of "currently in an unconverted trial" — set on
grant, cleared on any conversion (payment or coupon) or on revert. This lets the cron revert
exactly the pure trial users and never a paying customer.

### A) Schema — `User` (additive)

```prisma
trialStartedAt DateTime?  // set once when the user's only trial begins; never cleared (anti-abuse)
trialEndsAt    DateTime?  // end of the active, unconverted trial; cleared on conversion/revert
```

Additive/nullable → safe `prisma db push`. `prisma/schema.prisma` is shared with wao1234 →
coordinate deploy. Existing users have both null (no trial, no behavior change).

Derived states (no stored enum needed):
- **Trialing now:** `trialEndsAt != null && trialEndsAt > now`.
- **Has used trial:** `trialStartedAt != null` (blocks a second grant).
- **Trial ended (show upgrade prompt):** `plan == "FREE" && trialStartedAt != null && trialEndsAt == null`.

### B) `src/lib/trial.ts` (all trial logic, one place)

- `TRIAL_DAYS_PUBLIC = 7`.
- `grantTrial(userId, days): Promise<boolean>` — grants only if the user **has never trialed**
  (`trialStartedAt == null`) and isn't already a paying subscriber. Sets `plan = "PRO"`,
  `planExpiresAt = trialEndsAt = now + days`, `trialStartedAt = now`, `usageCount = 0`,
  `usageLimit = PRO clips`, and extends existing videos' retention (`extendVideoExpiryForPlan`).
  Returns `true` if granted, `false` if skipped (already trialed / already paid). Idempotent.
- `revertExpiredTrials(): Promise<number>` — the downgrade the app otherwise lacks. For each
  user with `trialEndsAt != null && trialEndsAt <= now` and not an active subscriber
  (`subStatus != "active"`): set `plan = "FREE"`, `planExpiresAt = null`, `trialEndsAt = null`,
  `usageCount = 0`, `usageLimit = FREE clips`, and `createNotification` with the annual-upgrade
  prompt. Returns the count reverted. `trialStartedAt` is left intact (one-trial guard).
- `trialStatus(user): { active: boolean; daysLeft: number; hasUsedTrial: boolean }` — for the UI.
  `daysLeft = ceil((trialEndsAt - now)/day)` when active, else 0.

### C) Grant on signup (both creation paths)

Users are created in two places; both call `grantTrial(id, TRIAL_DAYS_PUBLIC)` after creating
the row (idempotent via the `trialStartedAt` guard, so whichever runs first wins):
- `src/app/api/clerk-webhook/route.ts` — `user.created` (primary path).
- `src/lib/clerk-auth.ts` — `getCurrentUser` lazy-create fallback (covers a user who hits the
  app before the webhook fires, or a missed webhook).

Existing-user link paths (NextAuth migration) do **not** grant a trial.

### D) Conversion clears the trial marker

When a user genuinely upgrades, clear `trialEndsAt = null` so the revert cron never touches
them (and the "trial ended" prompt doesn't show):
- `src/app/api/payments/webhook/route.ts` — in `activatePlan` (covers first payment + renewals).
- `src/app/api/coupons/redeem/route.ts` — a GRANT coupon supersedes the trial.

`trialStartedAt` stays set (they still can't get a second free trial).

### E) Revert cron

`GET /api/cron/trial-expiry` (Bearer `CRON_SECRET`, `runtime = "nodejs"`) → `revertExpiredTrials()`,
mirroring `renewal-reminders` / `founding-sweep`. Wired as a PM2 cron (`scripts/trial-expiry.js`
+ `ecosystem.config.js` entry), daily. Daily granularity means a trial may run up to ~24h past
its end before revert — acceptable.

### F) UI — trial banner + status

- `src/app/api/user/me/route.ts` adds `trialStartedAt` + `trialEndsAt` to its response.
- A `TrialBanner` in the dashboard shell:
  - Trialing (`trialEndsAt > now`): "ทดลอง PRO เหลือ {daysLeft} วัน" + an upgrade CTA to `/pricing`.
  - Ended (`plan == FREE && trialStartedAt != null && trialEndsAt == null`): "ทดลอง PRO หมดแล้ว —
    อัปเกรดรายปีรับส่วนลด" → `/pricing` (founding price shows there if seats remain).
  - Otherwise (paid, or never trialed): nothing.

## Data flow

Signup → `grantTrial(id, 7)` sets PRO + `trialEndsAt = now+7d` + `trialStartedAt`. Dashboard
reads `/api/user/me` → banner counts down. If the user upgrades (payment or GRANT coupon) →
`trialEndsAt` cleared → they're a normal customer. If they don't → the daily `trial-expiry`
cron finds `trialEndsAt <= now`, reverts them to FREE, clears `trialEndsAt`, and notifies with
the annual offer → dashboard shows the "trial ended — upgrade" banner.

## Error handling

| Case | Behavior |
|---|---|
| Second signup / re-trial attempt | `grantTrial` no-ops (`trialStartedAt != null`) |
| Both creation paths fire | Idempotent — first grants, second is a no-op |
| User upgrades during trial | `activatePlan`/redeem clears `trialEndsAt` → cron skips them |
| GRANT coupon extends access past trial | `trialEndsAt` cleared on redeem → no premature revert |
| Active subscriber whose `trialEndsAt` lingered | Cron guard `subStatus != "active"` skips them |
| Trial ends | Cron sets FREE + notifies; gates already honor `plan == FREE` |
| Existing paid users (never trialed) | Untouched — `trialStartedAt == null`, cron ignores them |

## Out of scope (YAGNI)

- Community 30-day granting (the claim page will call `grantTrial(userId, 30)`).
- Email on revert (in-app notification only; can reuse the renewal-reminders email later).
- Stripe card-required trials / auto-charge.
- Fixing the broader "paid plans never auto-downgrade" gap — only trial users revert.

## Testing (local, tsx + build)

`scripts/verify-trial.ts` (run via tsx against a throwaway SQLite DB, absolute `DATABASE_URL`):
1. `grantTrial(u, 7)` → user is PRO, `trialStartedAt` + `trialEndsAt ≈ now+7d` set, `usageLimit`
   = PRO clips; returns true.
2. `grantTrial(u, 7)` again → returns false, no change (one-trial guard).
3. `trialStatus` → `active:true, daysLeft:7, hasUsedTrial:true`.
4. Conversion: simulate a paid activation clearing `trialEndsAt` → `revertExpiredTrials` does
   **not** revert that user.
5. Expiry: a user with `trialEndsAt` in the past, not subscribed → `revertExpiredTrials` sets
   FREE + clears `trialEndsAt`, keeps `trialStartedAt`; an active-subscriber row with a past
   `trialEndsAt` is **not** reverted.
6. A never-trialed paid user (`trialStartedAt == null`, `plan` PRO) is untouched by the cron.
- Then `npx tsc --noEmit` + `npm run build`. Browser E2E (signup → banner → revert) later.

## Deploy notes

- Additive schema → back up `prisma/dev.db`, `npx prisma db push` on the VPS, then
  `deploy/deploy.sh`. Coordinate with wao1234 (`schema.prisma` shared).
- `pm2 start ecosystem.config.js --only trial-expiry && pm2 save`.
- No new env keys. After deploy, **existing users get no retroactive trial** (only new signups);
  that's intended.
- Branch `mew/free-trial` → PR into `main`.
