# Free Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-grant every new signup a 7-day PRO trial (no card); on expiry revert to FREE and prompt an annual upgrade, via a trial-expiry cron (the app has no automatic plan downgrade).

**Architecture:** Two additive `User` fields — `trialStartedAt` (set once, anti-abuse guard) and `trialEndsAt` (marks an unconverted active trial; cleared on payment/coupon/revert). All logic lives in `src/lib/trial.ts` (`grantTrial`/`revertExpiredTrials`/`trialStatus`). Both user-creation paths call `grantTrial`; payment/coupon activation clears `trialEndsAt`; a daily cron reverts whatever is still past-due; a self-fetching `TrialBanner` shows the countdown / upgrade prompt.

**Tech Stack:** Next.js 15 App Router, Prisma 6 + SQLite, Clerk (signup webhook + lazy-create), existing `createNotification`/`limitsForPlan`/`extendVideoExpiryForPlan` helpers. No unit-test runner — the trial logic is proven by a `tsx` script against a throwaway SQLite DB (absolute `DATABASE_URL`); routes/UI gated by `tsc --noEmit` + `npm run build`; browser E2E later.

**Spec:** `docs/superpowers/specs/2026-06-06-free-trial-design.md`
**Branch:** `mew/free-trial` (already created). PR into `main`. `main` = prod.

---

## File structure

| File | Responsibility | New? |
|---|---|---|
| `prisma/schema.prisma` | `User.trialStartedAt` + `User.trialEndsAt` (additive) | modify |
| `src/lib/trial.ts` | trial logic: `TRIAL_DAYS_PUBLIC`, `grantTrial`, `revertExpiredTrials`, `trialStatus` | **create** |
| `scripts/verify-trial.ts` | tsx proof: grant/idempotent/convert-skip/revert/untouched | **create** |
| `src/app/api/clerk-webhook/route.ts` | grant trial on `user.created` | modify |
| `src/lib/clerk-auth.ts` | grant trial on lazy-create fallback | modify |
| `src/app/api/payments/webhook/route.ts` | clear `trialEndsAt` in `activatePlan` (conversion) | modify |
| `src/app/api/coupons/redeem/route.ts` | clear `trialEndsAt` on redeem (conversion) | modify |
| `src/app/api/cron/trial-expiry/route.ts` | `GET` → `revertExpiredTrials()` | **create** |
| `scripts/trial-expiry.js` | PM2 caller (Bearer CRON_SECRET) | **create** |
| `ecosystem.config.js` | PM2 cron entry (daily) | modify |
| `src/app/api/user/me/route.ts` | expose `trialStartedAt` + `trialEndsAt` | modify |
| `src/components/layout/trial-banner.tsx` | self-fetching banner (countdown / upgrade prompt) | **create** |
| `src/components/layout/dashboard-layout.tsx` | mount `<TrialBanner />` | modify |

**Shared symbols (Task 2):** `TRIAL_DAYS_PUBLIC`, `grantTrial(userId, days): Promise<boolean>`, `revertExpiredTrials(): Promise<number>`, `trialStatus(user): { active, daysLeft, hasUsedTrial }`.

---

## Task 1: Schema — trial fields

**Files:** Modify `prisma/schema.prisma`

- [ ] **Step 1: Add the two fields to the `User` model**

In `prisma/schema.prisma`, inside `model User`, add after the line `cancelAt            DateTime?` (the Phase-2 subscription block):
```prisma
  // Free trial (public 7-day PRO trial, no card)
  trialStartedAt DateTime?  // set once; never cleared (one-trial-per-user guard)
  trialEndsAt    DateTime?  // end of the active unconverted trial; cleared on conversion/revert
```

- [ ] **Step 2: Validate + push + regenerate client**

Run:
```bash
npx prisma validate
npx prisma db push
```
Expected: `valid 🚀` then `Your database is now in sync with your Prisma schema.` (client regenerated with the new fields). `.env` already has an absolute `DATABASE_URL`.

- [ ] **Step 3: Commit**
```bash
git add prisma/schema.prisma
git commit -m "feat(schema): User.trialStartedAt + trialEndsAt (free trial)"
```

---

## Task 2: `src/lib/trial.ts` + tsx verification (TDD)

**Files:** Create `scripts/verify-trial.ts`, then `src/lib/trial.ts`

- [ ] **Step 1: Write the failing verification script**

Create `scripts/verify-trial.ts`:
```ts
// Proof of the trial lifecycle. Run against a throwaway SQLite DB with an ABSOLUTE path
// (Prisma CLI resolves relative file: paths vs the schema dir; runtime vs cwd — they must agree):
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-trial.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-trial.db?connection_limit=1" npx tsx scripts/verify-trial.ts
import { prisma } from "../src/lib/prisma";
import { grantTrial, revertExpiredTrials, trialStatus, TRIAL_DAYS_PUBLIC } from "../src/lib/trial";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

let n = 0;
async function mkUser(over: Record<string, unknown> = {}) {
  n++;
  return prisma.user.create({ data: { name: "u" + n, email: `u${n}@t.test`, ...over } });
}

async function main() {
  await prisma.user.deleteMany();

  // grant
  const a = await mkUser();
  assert((await grantTrial(a.id, TRIAL_DAYS_PUBLIC)) === true, "grantTrial returns true for a fresh user");
  let A = await prisma.user.findUnique({ where: { id: a.id } });
  assert(A!.plan === "PRO" && !!A!.trialStartedAt && !!A!.trialEndsAt, "user is PRO with trialStartedAt+trialEndsAt set");
  assert(A!.usageLimit === 100, "usageLimit set to PRO clips (100)");
  const st = trialStatus(A!);
  assert(st.active && st.daysLeft === 7 && st.hasUsedTrial, "trialStatus: active, 7 days left, hasUsedTrial");

  // one-trial-per-user (idempotent)
  assert((await grantTrial(a.id, TRIAL_DAYS_PUBLIC)) === false, "grantTrial returns false the second time");

  // active subscriber is not granted
  const sub = await mkUser({ subStatus: "active" });
  assert((await grantTrial(sub.id, 7)) === false, "active subscriber is not granted a trial");

  // conversion clears trialEndsAt → revert skips them
  const conv = await mkUser();
  await grantTrial(conv.id, 7);
  await prisma.user.update({ where: { id: conv.id }, data: { trialEndsAt: null } }); // simulate payment/coupon conversion
  // expiry: past-due unconverted trial reverts; converted + active + never-trialed are untouched
  const expired = await mkUser();
  await grantTrial(expired.id, 7);
  await prisma.user.update({ where: { id: expired.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
  const activeSubExpired = await mkUser({ subStatus: "active", trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() - 1000), plan: "PRO" });
  const neverTrialedPaid = await mkUser({ plan: "PRO" }); // trialStartedAt null

  const reverted = await revertExpiredTrials();
  assert(reverted === 1, `revertExpiredTrials reverts exactly the 1 past-due unconverted trial (got ${reverted})`);
  const E = await prisma.user.findUnique({ where: { id: expired.id } });
  assert(E!.plan === "FREE" && E!.trialEndsAt === null && !!E!.trialStartedAt && E!.usageLimit === 2, "expired trial → FREE, trialEndsAt cleared, trialStartedAt kept, usageLimit 2");
  const C = await prisma.user.findUnique({ where: { id: conv.id } });
  assert(C!.plan === "PRO", "converted user (trialEndsAt null) NOT reverted");
  const S = await prisma.user.findUnique({ where: { id: activeSubExpired.id } });
  assert(S!.plan === "PRO", "active subscriber NOT reverted even with past trialEndsAt");
  const N = await prisma.user.findUnique({ where: { id: neverTrialedPaid.id } });
  assert(N!.plan === "PRO", "never-trialed paid user untouched");

  // revert created a notification for the reverted user
  const notif = await prisma.notification.findFirst({ where: { userId: expired.id } });
  assert(!!notif, "revert created an upgrade notification");

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} TRIAL CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 2: Prepare the test DB and run to verify it FAILS**

Run:
```bash
ROOT="$(pwd)"
DATABASE_URL="file:$ROOT/prisma/test-trial.db" npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL="file:$ROOT/prisma/test-trial.db?connection_limit=1" npx tsx scripts/verify-trial.ts
```
Expected: FAIL — `../src/lib/trial` not found (lib doesn't exist yet).

- [ ] **Step 3: Implement `src/lib/trial.ts`**

Create `src/lib/trial.ts`:
```ts
import { prisma } from "@/lib/prisma";
import { limitsForPlan } from "@/lib/plan-limits";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { createNotification } from "@/lib/notifications";

export const TRIAL_DAYS_PUBLIC = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Clip allotment for a plan as a finite number (FREE=2, PRO=100, BUSINESS=300). */
function clipsFor(plan: string): number {
  const c = limitsForPlan(plan).clips;
  return Number.isFinite(c) ? (c as number) : 100;
}

/**
 * Grant a PRO trial of `days` — only if the user has NEVER trialed and isn't an active
 * subscriber. Atomic via a conditional updateMany (one trial per user, race-safe).
 * Returns true if granted, false if skipped. Safe to call from both signup paths.
 */
export async function grantTrial(userId: string, days: number): Promise<boolean> {
  const now = new Date();
  const end = new Date(now.getTime() + days * DAY_MS);
  const res = await prisma.user.updateMany({
    where: {
      id: userId,
      trialStartedAt: null,                                   // never trialed
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }], // not an active subscriber (null-safe)
    },
    data: {
      plan: "PRO",
      planExpiresAt: end,
      trialStartedAt: now,
      trialEndsAt: end,
      usageCount: 0,
      usageLimit: clipsFor("PRO"),
    },
  });
  if (res.count !== 1) return false;
  await extendVideoExpiryForPlan(userId, "PRO").catch(() => {});
  return true;
}

/**
 * Revert every unconverted, past-due trial to FREE and notify with the annual-upgrade prompt.
 * This is the downgrade the app otherwise lacks; scoped to trial users (trialEndsAt set) only —
 * paying customers cleared trialEndsAt on conversion, so they're never touched. Returns the count.
 */
export async function revertExpiredTrials(): Promise<number> {
  const now = new Date();
  const due = await prisma.user.findMany({
    where: {
      trialEndsAt: { not: null, lte: now },
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
    },
    select: { id: true },
  });
  let reverted = 0;
  for (const u of due) {
    const res = await prisma.user.updateMany({
      where: { id: u.id, trialEndsAt: { not: null, lte: now } }, // re-guard (idempotent under concurrency)
      data: { plan: "FREE", planExpiresAt: null, trialEndsAt: null, usageCount: 0, usageLimit: clipsFor("FREE") },
    });
    if (res.count !== 1) continue;
    reverted++;
    await createNotification({
      userId: u.id,
      type: "LIMIT_REACHED",
      title: "ทดลอง PRO หมดอายุแล้ว",
      body: "อัปเกรดเป็นรายปีเพื่อใช้ฟีเจอร์ PRO ต่อ — รับราคาพิเศษที่หน้าราคา",
    }).catch(() => {});
  }
  return reverted;
}

/** UI helper — derive the trial display state from a user row. */
export function trialStatus(user: { trialStartedAt: Date | null; trialEndsAt: Date | null }): {
  active: boolean; daysLeft: number; hasUsedTrial: boolean;
} {
  const now = Date.now();
  const active = !!user.trialEndsAt && user.trialEndsAt.getTime() > now;
  const daysLeft = active ? Math.ceil((user.trialEndsAt!.getTime() - now) / DAY_MS) : 0;
  return { active, daysLeft, hasUsedTrial: !!user.trialStartedAt };
}
```

- [ ] **Step 4: Run the verification script to verify it PASSES**

Run:
```bash
ROOT="$(pwd)"
DATABASE_URL="file:$ROOT/prisma/test-trial.db?connection_limit=1" npx tsx scripts/verify-trial.ts
```
Expected: every line `✓ …` ending with `✅ ALL 12 TRIAL CHECKS PASSED`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `src/lib/trial.ts`.

- [ ] **Step 6: Commit** (the test DB `prisma/test-trial.db` is gitignored — do NOT add it)
```bash
git add src/lib/trial.ts scripts/verify-trial.ts
git commit -m "feat(trial): trial lib (grant/revert/status) + tsx verification"
```

---

## Task 3: Grant the trial on signup (both creation paths)

**Files:** Modify `src/app/api/clerk-webhook/route.ts`, `src/lib/clerk-auth.ts`

- [ ] **Step 1: Grant on the Clerk `user.created` webhook**

In `src/app/api/clerk-webhook/route.ts`, add the import at the top (after the `prisma` import):
```ts
import { grantTrial, TRIAL_DAYS_PUBLIC } from "@/lib/trial";
```
In the `user.created` handler, the `else` branch currently does `await prisma.user.create({ data: {...} });`. Capture the created user and grant the trial. Replace:
```ts
    } else {
      // Create brand new user
      const name =
        `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() ||
        primaryEmail.split("@")[0];
      await prisma.user.create({
        data: {
          clerkId: data.id,
          name,
          email: primaryEmail,
          image: data.image_url ?? null,
        },
      });
    }
```
with:
```ts
    } else {
      // Create brand new user + start their 7-day PRO trial
      const name =
        `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() ||
        primaryEmail.split("@")[0];
      const created = await prisma.user.create({
        data: {
          clerkId: data.id,
          name,
          email: primaryEmail,
          image: data.image_url ?? null,
        },
      });
      await grantTrial(created.id, TRIAL_DAYS_PUBLIC);
    }
```

- [ ] **Step 2: Grant on the lazy-create fallback**

In `src/lib/clerk-auth.ts`, add the import at the top (after the `User` type import):
```ts
import { grantTrial, TRIAL_DAYS_PUBLIC } from "@/lib/trial";
```
Replace the final "New user — create Prisma record" block:
```ts
  // New user — create Prisma record
  return prisma.user.create({
    data: {
      clerkId: userId,
      name:
        `${clerkUser.firstName ?? ""} ${clerkUser.lastName ?? ""}`.trim() ||
        email.split("@")[0],
      email,
      image: clerkUser.imageUrl ?? null,
      ...(isAdminEmail ? { role: "ADMIN" } : {}),
    },
  });
```
with:
```ts
  // New user — create Prisma record + start their 7-day PRO trial
  const created = await prisma.user.create({
    data: {
      clerkId: userId,
      name:
        `${clerkUser.firstName ?? ""} ${clerkUser.lastName ?? ""}`.trim() ||
        email.split("@")[0],
      email,
      image: clerkUser.imageUrl ?? null,
      ...(isAdminEmail ? { role: "ADMIN" } : {}),
    },
  });
  await grantTrial(created.id, TRIAL_DAYS_PUBLIC); // idempotent if the webhook already granted
  return prisma.user.findUnique({ where: { id: created.id } }) as Promise<typeof created>;
}
```
> Note: the closing `}` shown is the end of `getCurrentUser`. Ensure you don't duplicate it — replace only the `return prisma.user.create({...});` statement and keep the existing function brace.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/clerk-webhook/route.ts src/lib/clerk-auth.ts
git commit -m "feat(trial): auto-grant 7-day PRO trial on signup (webhook + lazy-create)"
```

---

## Task 4: Clear `trialEndsAt` on conversion (payment + coupon)

**Files:** Modify `src/app/api/payments/webhook/route.ts`, `src/app/api/coupons/redeem/route.ts`

- [ ] **Step 1: Clear on paid activation (webhook)**

In `src/app/api/payments/webhook/route.ts`, the `activatePlan` function updates the user with `data: { plan, planExpiresAt: newExpiry, usageCount: 0, usageLimit: ... }`. Add `trialEndsAt: null` to that `data` object so any real payment ends the trial. The line currently reads:
```ts
    data: { plan: plan as any, planExpiresAt: newExpiry, usageCount: 0, usageLimit: planConfig?.clips ?? 100 },
```
Change to:
```ts
    data: { plan: plan as any, planExpiresAt: newExpiry, usageCount: 0, usageLimit: planConfig?.clips ?? 100, trialEndsAt: null },
```

- [ ] **Step 2: Clear on GRANT coupon redemption**

In `src/app/api/coupons/redeem/route.ts`, the `$transaction` updates the user with `prisma.user.update({ where: { id: authUser.id }, data: { plan: coupon.plan, ... } })`. Add `trialEndsAt: null` to that `data`. The block currently reads:
```ts
      prisma.user.update({
        where: { id: authUser.id },
        data: {
          plan: coupon.plan,
          ...(planExpiresAt ? {} : {}), // permanent if durationDays=0
        },
      }),
```
Change the `data` to:
```ts
      prisma.user.update({
        where: { id: authUser.id },
        data: {
          plan: coupon.plan,
          trialEndsAt: null, // redeeming supersedes any running trial
          ...(planExpiresAt ? {} : {}), // permanent if durationDays=0
        },
      }),
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/payments/webhook/route.ts src/app/api/coupons/redeem/route.ts
git commit -m "feat(trial): clear trialEndsAt on conversion (payment + coupon)"
```

---

## Task 5: Trial-expiry cron

**Files:** Create `src/app/api/cron/trial-expiry/route.ts`, `scripts/trial-expiry.js`; modify `ecosystem.config.js`

- [ ] **Step 1: Implement the cron route**

Create `src/app/api/cron/trial-expiry/route.ts`:
```ts
import { NextResponse } from "next/server";
import { revertExpiredTrials } from "@/lib/trial";

export const runtime = "nodejs";

// GET /api/cron/trial-expiry  (daily, Bearer CRON_SECRET)
// Reverts expired unconverted trials to FREE and notifies them with the annual-upgrade prompt.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const reverted = await revertExpiredTrials();
  console.log(`[trial-expiry] ${new Date().toISOString()} reverted=${reverted}`);
  return NextResponse.json({ ok: true, reverted });
}
```

- [ ] **Step 2: Create the PM2 caller script**

Create `scripts/trial-expiry.js`:
```js
// Runs daily via PM2 cron to revert expired free trials to FREE + send the upgrade prompt.
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

const url = `${BASE_URL}/api/cron/trial-expiry`;
const client = url.startsWith("https") ? https : http;
const options = { method: "GET", timeout: 30000, headers: { ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}) } };

function attempt(retries) {
  const req = client.request(url, options, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => { console.log(`[trial-expiry] ${new Date().toISOString()} status=${res.statusCode} body=${data}`); process.exit(0); });
  });
  req.on("timeout", () => { req.destroy(); console.error("[trial-expiry] timed out"); retries > 0 ? setTimeout(() => attempt(retries - 1), 10000) : process.exit(1); });
  req.on("error", (e) => { console.error(`[trial-expiry] ${e.code || ""} ${e.message || ""}`); retries > 0 ? setTimeout(() => attempt(retries - 1), 10000) : process.exit(1); });
  req.end();
}
attempt(3);
```

- [ ] **Step 3: Add the PM2 entry**

In `ecosystem.config.js`, add a new app object after the `founding-sweep` entry (before the closing `],`):
```js
    {
      name: "trial-expiry",
      cwd: "/var/www/ai-content",
      script: "scripts/trial-expiry.js",
      cron_restart: "0 8 * * *", // daily 8:00 — revert expired free trials + upgrade prompt
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        CRON_SECRET: process.env.CRON_SECRET || "",
      },
    },
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; build lists `/api/cron/trial-expiry`.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/cron/trial-expiry/route.ts scripts/trial-expiry.js ecosystem.config.js
git commit -m "feat(trial): daily trial-expiry cron (revert + upgrade prompt)"
```

---

## Task 6: Expose trial status + dashboard banner

**Files:** Modify `src/app/api/user/me/route.ts`, `src/components/layout/dashboard-layout.tsx`; create `src/components/layout/trial-banner.tsx`

- [ ] **Step 1: Add trial fields to `/api/user/me`**

In `src/app/api/user/me/route.ts`, add `trialStartedAt: true,` and `trialEndsAt: true,` to the `select` object (next to `cancelAt: true`):
```ts
        cancelAtPeriodEnd: true,
        cancelAt: true,
        trialStartedAt: true,
        trialEndsAt: true,
      } as any,
```

- [ ] **Step 2: Create the TrialBanner component**

Create `src/components/layout/trial-banner.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";

type Me = { plan: string; trialStartedAt: string | null; trialEndsAt: string | null };

export function TrialBanner() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch("/api/user/me").then(r => r.json()).then(setMe).catch(() => {});
  }, []);

  if (!me) return null;

  const now = Date.now();
  const endsAt = me.trialEndsAt ? new Date(me.trialEndsAt).getTime() : 0;
  const trialing = endsAt > now;
  const ended = me.plan === "FREE" && !!me.trialStartedAt && !me.trialEndsAt;
  if (!trialing && !ended) return null;

  const daysLeft = trialing ? Math.ceil((endsAt - now) / (24 * 60 * 60 * 1000)) : 0;
  const text = trialing
    ? `ทดลอง PRO เหลืออีก ${daysLeft} วัน`
    : "ทดลอง PRO หมดแล้ว — อัปเกรดรายปีรับราคาพิเศษ";

  return (
    <Link
      href="/pricing"
      className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
      style={{ background: "linear-gradient(90deg,#7c3aed,#06b6d4)" }}
    >
      <Sparkles className="h-4 w-4" strokeWidth={2.5} />
      <span>{text}</span>
      <span className="inline-flex items-center gap-1 underline underline-offset-2">
        {trialing ? "อัปเกรดเลย" : "ดูแพ็กเกจ"} <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    </Link>
  );
}
```

- [ ] **Step 3: Mount the banner in the dashboard shell**

In `src/components/layout/dashboard-layout.tsx`, add the import after the `TopNav` import:
```ts
import { TrialBanner } from "./trial-banner";
```
Then render it immediately under `<TopNav … />`. Replace:
```tsx
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
```
with:
```tsx
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />
      <TrialBanner />

      <div className="flex flex-1 overflow-hidden">
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/user/me/route.ts src/components/layout/trial-banner.tsx src/components/layout/dashboard-layout.tsx
git commit -m "feat(trial): expose trial status on /api/user/me + dashboard trial banner"
```

---

## Task 7: Build gate + E2E acceptance + PR

**Files:** none (verification) — plus `STATUS.md`.

- [ ] **Step 1: Re-run the trial proof + full build**
```bash
ROOT="$(pwd)"
DATABASE_URL="file:$ROOT/prisma/test-trial.db" npx prisma db push --skip-generate --accept-data-loss
DATABASE_URL="file:$ROOT/prisma/test-trial.db?connection_limit=1" npx tsx scripts/verify-trial.ts
npx tsc --noEmit && npm run build
rm -f prisma/test-trial.db*
```
Expected: `✅ ALL 12 TRIAL CHECKS PASSED`; build OK.

- [ ] **Step 2: Browser E2E (later, needs Clerk test keys + dev on :3005)**
  - Sign up a fresh Clerk test user → confirm they land as PRO with the "ทดลอง PRO เหลืออีก 7 วัน" banner; `/api/user/me` shows `trialEndsAt ≈ +7d`.
  - Set that user's `trialEndsAt` to the past (DB) → call `GET /api/cron/trial-expiry` with the `CRON_SECRET` → user becomes FREE, banner switches to "ทดลอง PRO หมดแล้ว", an upgrade notification exists.
  - Upgrade flow (or redeem a GRANT coupon) on a trialing user → `trialEndsAt` cleared, banner disappears, cron leaves them alone.
  - Regression: an existing paid user (never trialed) shows no banner and is untouched by the cron.

- [ ] **Step 3: Update STATUS.md + commit**

Add under "🔄 Payment vertical (Mew)" in `STATUS.md`:
```
- 🧪 **Free trial (code-complete 06-06, branch `mew/free-trial`)** — สมัครได้ PRO 7 วันอัตโนมัติ (ไม่ใช้บัตร) → หมดแล้ว revert FREE + prompt อัปเกรดรายปี (cron `trial-expiry`) · กลไกรับ duration (claim page เรียก `grantTrial(id,30)` ทีหลัง) · ผ่าน tsx proof + build · รอ E2E + deploy (`prisma db push` + `pm2 start --only trial-expiry`)
```
```bash
git add STATUS.md
git commit -m "docs(status): Free trial code-complete (7-day PRO auto trial) — pending E2E+deploy"
```

- [ ] **Step 4: Push + open PR**
```bash
git push -u origin mew/free-trial
gh pr create --base main --title "Free trial: 7-day auto PRO trial (revert + annual prompt)" \
  --body "Auto-grants a 7-day PRO trial on signup (no card); reverts to FREE + prompts annual upgrade on expiry via a daily trial-expiry cron. Spec: docs/superpowers/specs/2026-06-06-free-trial-design.md · Plan: docs/superpowers/plans/2026-06-06-free-trial.md"
```
> Deploy (coordinate with wao1234 — `schema.prisma` shared): back up `prisma/dev.db`, `npx prisma db push` (adds the 2 trial columns), `deploy/deploy.sh`, then `pm2 start ecosystem.config.js --only trial-expiry && pm2 save`.

---

## Self-review notes (coverage vs spec)

- Spec §A (schema) → Task 1.
- Spec §B (`trial.ts`: grant/revert/status) → Task 2 (+ tsx proof).
- Spec §C (grant on both signup paths) → Task 3.
- Spec §D (conversion clears `trialEndsAt`: payment + coupon) → Task 4.
- Spec §E (revert cron) → Task 5.
- Spec §F (user/me fields + banner during & after trial) → Task 6.
- Spec testing → Task 2 (lib) + Task 7 (build + E2E).
- Anti-abuse (one trial), active-subscriber skip, never-trialed-untouched → encoded in `grantTrial`/`revertExpiredTrials` guards and asserted in `verify-trial.ts`.
- Out-of-scope honored: no community-30 grant path here (claim page calls `grantTrial(id,30)`), no email, no Stripe card-trial, no change to existing paid downgrade behavior.
