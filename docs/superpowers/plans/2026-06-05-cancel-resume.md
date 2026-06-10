# Cancel-at-period-end visibility + in-app reactivate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show card subscribers that their plan is scheduled to cancel, and let them undo it in-app with one click.

**Architecture:** Webhook learns the scheduled-cancel state from `customer.subscription.updated` and stores it on `User` (`cancelAtPeriodEnd` + `cancelAt`). A new `POST /api/payments/reactivate` route flips `cancel_at_period_end` back to false on Stripe and optimistically clears the flags. The settings billing tab renders a banner + "ใช้ {plan} ต่อ" button when the flag is set.

**Tech Stack:** Next.js 15 (App Router) API routes, Prisma 6 + SQLite, Stripe SDK 22.1.1 (API `2026-04-22.dahlia`), Clerk auth, React 19 client components, `sonner` toasts.

**Repo conventions discovered (follow these exactly):**
- Auth in routes: `const authUser = await getCurrentUser()` from `@/lib/clerk-auth`; `authUser.id` IS the DB user id; null → `401`.
- Stripe must be primed: `await ensureStripeConfig()` (from `@/lib/load-stripe-config`) before any `stripe.*` call (keys live in DB `SiteConfig`, not `.env`).
- Errors: `return apiError({ route: "...", error })` from `@/lib/api-error` in the `catch`.
- Webhook casts events with `as any` — keep that pattern (avoids Stripe type churn).
- **No unit-test runner exists** (no vitest/jest, `package.json` has no `test` script — and `package.json` is a shared file with wao1234, so do NOT add one). Verification = `npm run build` (the CI gate) + a local Stripe **test-mode** E2E check. This matches the established pattern.
- ⚠️ **Naming:** `POST /api/payments/resume` already exists for a different purpose (resuming a *pending checkout*). This feature uses **`/api/payments/reactivate`** — do not touch `resume`.
- ⚠️ **Stripe `2026-04-22.dahlia`:** `current_period_end` is no longer top-level on `Subscription`. We use `sub.cancel_at` (still top-level; set when a cancel is scheduled, null otherwise) and `sub.cancel_at_period_end` — both unaffected by the move.

**Branch:** `mew/cancel-resume` (already created off `main`). Never commit to `main`; merge via PR.

---

### Task 1: Schema — add cancel-tracking columns to `User`

**Files:**
- Modify: `prisma/schema.prisma` (User model — the `// Phase 2 — subscriptions` block, ~lines 36-39)

- [ ] **Step 1: Add the two columns**

In `prisma/schema.prisma`, find:

```prisma
  // Phase 2 — subscriptions (card auto-renew cohort)
  stripeCustomerId     String?  @unique
  stripeSubscriptionId String?
  subStatus            String?  // active | past_due | canceled
  billingPeriod        String?  // monthly | annual
```

Change it to:

```prisma
  // Phase 2 — subscriptions (card auto-renew cohort)
  stripeCustomerId     String?  @unique
  stripeSubscriptionId String?
  subStatus            String?  // active | past_due | canceled
  billingPeriod        String?  // monthly | annual
  cancelAtPeriodEnd    Boolean  @default(false) // portal-scheduled cancel; resume clears it
  cancelAt             DateTime?                  // exact lapse date from Stripe sub.cancel_at
```

- [ ] **Step 2: Apply to the local dev DB and regenerate the client**

Run: `npx prisma db push`
Expected: `Your database is now in sync with your Prisma schema.` and `Generated Prisma Client`.

- [ ] **Step 3: Verify the columns exist**

Run: `node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().user.findFirst({select:{cancelAtPeriodEnd:true,cancelAt:true}}).then(r=>{console.log('ok',r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: prints `ok { cancelAtPeriodEnd: false, cancelAt: null }` (or `ok null` on an empty DB) — no error.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add User.cancelAtPeriodEnd + cancelAt for scheduled-cancel tracking"
```

---

### Task 2: Webhook — handle `customer.subscription.updated`

**Files:**
- Modify: `src/app/api/payments/webhook/route.ts` (insert a new `if` block after the `customer.subscription.deleted` block, ~line 97, before `invoice.payment_failed`)

- [ ] **Step 1: Add the handler**

In `src/app/api/payments/webhook/route.ts`, immediately AFTER this existing block:

```ts
  // ── Subscription canceled → mark canceled (access lapses at period end) ──
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as any;
    const user = await prisma.user.findFirst({ where: { stripeSubscriptionId: sub.id }, select: { id: true } });
    if (user) {
      await prisma.user.update({ where: { id: user.id }, data: { subStatus: "canceled", stripeSubscriptionId: null } });
    }
  }
```

insert:

```ts
  // ── Subscription updated → sync scheduled-cancel state (covers cancel AND resume) ──
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as any;
    const user = await prisma.user.findFirst({
      where: { OR: [{ stripeSubscriptionId: sub.id }, { stripeCustomerId: sub.customer }] },
      select: { id: true },
    });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          subStatus: sub.status,
        },
      });
      console.log(`[stripe-webhook] subscription.updated ${user.id} cancelAtPeriodEnd=${!!sub.cancel_at_period_end}`);
    } else {
      console.warn(`[stripe-webhook] subscription.updated: no user for sub ${sub.id}`);
    }
  }
```

- [ ] **Step 2: Typecheck via build**

Run: `npm run build`
Expected: build completes with no TypeScript error in `payments/webhook/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/payments/webhook/route.ts
git commit -m "feat(webhook): handle customer.subscription.updated (scheduled cancel + resume)"
```

---

### Task 3: `POST /api/payments/reactivate` — undo a scheduled cancel

**Files:**
- Create: `src/app/api/payments/reactivate/route.ts`

- [ ] **Step 1: Write the route** (modeled on `payments/portal/route.ts`)

Create `src/app/api/payments/reactivate/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { ensureStripeConfig } from "@/lib/load-stripe-config";

// Undo a portal-scheduled cancellation: set cancel_at_period_end back to false on Stripe.
// The customer.subscription.updated webhook reconciles the DB; we also clear optimistically.
export async function POST() {
  try {
    await ensureStripeConfig();
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const dbUser = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { stripeSubscriptionId: true },
    });
    if (!dbUser?.stripeSubscriptionId) {
      return NextResponse.json({ error: "ไม่พบการสมัครแบบต่ออัตโนมัติ" }, { status: 400 });
    }

    await stripe.subscriptions.update(dbUser.stripeSubscriptionId, { cancel_at_period_end: false });

    await prisma.user.update({
      where: { id: authUser.id },
      data: { cancelAtPeriodEnd: false, cancelAt: null, subStatus: "active" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "POST /api/payments/reactivate", error });
  }
}
```

- [ ] **Step 2: Typecheck via build**

Run: `npm run build`
Expected: build completes; route compiles, no TS error.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/payments/reactivate/route.ts
git commit -m "feat(payments): add reactivate route to undo scheduled cancel"
```

---

### Task 4: Expose `cancelAtPeriodEnd` + `cancelAt` in `/api/user/me`

**Files:**
- Modify: `src/app/api/user/me/route.ts` (the `select` object, ~lines 15-24)

- [ ] **Step 1: Add the two fields to the select**

In `src/app/api/user/me/route.ts`, change:

```ts
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        plan: true,
        usageCount: true,
        usageLimit: true,
        avatar: true,
      } as any,
```

to:

```ts
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        plan: true,
        usageCount: true,
        usageLimit: true,
        avatar: true,
        cancelAtPeriodEnd: true,
        cancelAt: true,
      } as any,
```

- [ ] **Step 2: Typecheck via build**

Run: `npm run build`
Expected: build completes, no error.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/user/me/route.ts
git commit -m "feat(api): expose cancelAtPeriodEnd + cancelAt from /api/user/me"
```

---

### Task 5: `ReactivateBanner` component + render in BillingTab

**Files:**
- Create: `src/components/settings/reactivate-banner.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` (add import near line 16; render `<ReactivateBanner />` in `BillingTab` just above `<ManageSubscriptionButton />` at line 125)

- [ ] **Step 1: Write the component**

Create `src/components/settings/reactivate-banner.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

type SubState = { plan?: string; cancelAtPeriodEnd?: boolean; cancelAt?: string | null };

// Shows when a card subscription is scheduled to cancel; lets the user undo it in-app.
// Renders nothing when there is no scheduled cancellation.
export function ReactivateBanner() {
  const [state, setState] = useState<SubState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/user/me").then(r => r.json()).then(setState).catch(() => {});
  }, []);

  if (!state?.cancelAtPeriodEnd) return null;

  const plan = state.plan ?? "PRO";
  const dateLabel = state.cancelAt
    ? new Date(state.cancelAt).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" })
    : "สิ้นรอบบิล";

  async function reactivate() {
    setLoading(true);
    try {
      const res = await fetch("/api/payments/reactivate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "ทำรายการไม่สำเร็จ"); return; }
      setState(s => (s ? { ...s, cancelAtPeriodEnd: false, cancelAt: null } : s));
      toast.success(`ใช้แพ็ก ${plan} ต่อแล้ว — ยกเลิกการยกเลิกเรียบร้อย`);
    } catch {
      toast.error("เชื่อมต่อไม่ได้");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center"
      style={{ background: "hsl(38 92% 50% / 0.08)", border: "1px solid hsl(38 92% 50% / 0.3)" }}
    >
      <AlertTriangle className="h-5 w-5 shrink-0" style={{ color: "hsl(38 92% 55%)" }} strokeWidth={2.25} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>
          แพ็ก {plan} จะยกเลิกวันที่ {dateLabel}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
          ใช้งานได้ถึงวันนั้น — กดด้านขวาเพื่อใช้ต่อแบบต่ออัตโนมัติ
        </p>
      </div>
      <button
        onClick={reactivate}
        disabled={loading}
        className="flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        style={{ background: "hsl(38 92% 50%)", color: "#1a1205" }}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        ใช้ {plan} ต่อ
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Import it in settings page**

In `src/app/(dashboard)/settings/page.tsx`, just below line 16:

```tsx
import { ManageSubscriptionButton } from "@/components/settings/manage-subscription-button";
```

add:

```tsx
import { ReactivateBanner } from "@/components/settings/reactivate-banner";
```

- [ ] **Step 3: Render it in BillingTab above the manage button**

In `src/app/(dashboard)/settings/page.tsx`, change line 125 from:

```tsx
      <ManageSubscriptionButton />
```

to:

```tsx
      <ReactivateBanner />
      <ManageSubscriptionButton />
```

- [ ] **Step 4: Typecheck via build**

Run: `npm run build`
Expected: build completes; settings page + component compile, no TS error.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/reactivate-banner.tsx "src/app/(dashboard)/settings/page.tsx"
git commit -m "feat(settings): scheduled-cancel banner + in-app reactivate button"
```

---

### Task 6: Local E2E verification (Stripe test mode)

**Goal:** Prove the cancel → banner → reactivate loop end-to-end against local dev + Stripe test mode. No code changes — this is a verification gate.

**Prereqs:** `.env` has the TEST Stripe keys + 6 TEST price IDs (per `project-payment-subscriptions` memory). Two terminals.

- [ ] **Step 1: Start dev + Stripe listener**

Terminal A: `npm run dev`
Terminal B: `stripe listen --forward-to localhost:3000/api/payments/webhook`
Paste the `whsec_...` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`, then restart Terminal A.
Expected: `stripe listen` shows `Ready! ... waiting for events`.

- [ ] **Step 2: Create a test card subscription**

Sign up / sign in (Clerk test: email `you+clerk_test@…`, code `424242`), go to `/pricing`, buy PRO with test card `4242 4242 4242 4242`.
Verify activation:
`node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().user.findFirst({where:{stripeSubscriptionId:{not:null}},orderBy:{updatedAt:'desc'},select:{email:true,plan:true,stripeSubscriptionId:true,cancelAtPeriodEnd:true}}).then(u=>{console.log(u);process.exit(0)})"`
Expected: a user with `plan: 'PRO'`, a `stripeSubscriptionId`, `cancelAtPeriodEnd: false`. Note the `stripeSubscriptionId` (call it `SUB_ID`).

- [ ] **Step 3: Schedule a cancel via Stripe CLI → assert webhook stores it**

Run (replace `SUB_ID`): `stripe subscriptions update SUB_ID --cancel-at-period-end`
Watch Terminal B: a `customer.subscription.updated` event forwards and returns `200`.
Assert DB:
`node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().user.findFirst({where:{stripeSubscriptionId:'SUB_ID'},select:{cancelAtPeriodEnd:true,cancelAt:true}}).then(u=>{console.log(u);process.exit(0)})"`
Expected: `{ cancelAtPeriodEnd: true, cancelAt: <a future Date> }`.

- [ ] **Step 4: Assert the UI banner**

Reload `/settings?tab=billing`.
Expected: amber banner "แพ็ก PRO จะยกเลิกวันที่ <date>" with a "ใช้ PRO ต่อ" button, shown above "จัดการการสมัคร".

- [ ] **Step 5: Reactivate from the UI → assert cleared**

Click "ใช้ PRO ต่อ".
Expected: success toast, banner disappears. Terminal B shows another `customer.subscription.updated` (`cancel_at_period_end=false`) → `200`.
Assert DB:
`node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().user.findFirst({where:{stripeSubscriptionId:'SUB_ID'},select:{cancelAtPeriodEnd:true,cancelAt:true,subStatus:true}}).then(u=>{console.log(u);process.exit(0)})"`
Expected: `{ cancelAtPeriodEnd: false, cancelAt: null, subStatus: 'active' }`.

- [ ] **Step 6: Record the result**

If all asserts pass, note it in the PR description. If any fail, STOP and debug (use systematic-debugging) before shipping.

---

### Task 7: Ship — PR, deploy, live webhook event check

**Goal:** Get it to prod safely, coordinating with wao1234 on the shared schema + deploy. **Gate: do not run this task until Mew says go and deploy timing is agreed.**

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin mew/cancel-resume
gh pr create --base main --head mew/cancel-resume --title "feat: cancel-at-period-end banner + in-app reactivate" --body "Adds scheduled-cancel visibility in settings and a one-click reactivate. Schema: additive User.cancelAtPeriodEnd + cancelAt (needs prisma db push on deploy). See docs/superpowers/specs/2026-06-05-cancel-at-period-end-ui-design.md. Local Stripe test-mode E2E passed."
```

- [ ] **Step 2: Confirm CI is green on the PR**

Run: `gh pr checks <PR#>`
Expected: `Build` = `pass`. If red, fix before merging.

- [ ] **Step 3: Verify the LIVE Stripe webhook endpoint sends `customer.subscription.updated`**

The live endpoint is `we_1Tet6NL39kyExJWOO2CLrSjA` (6 events). If `customer.subscription.updated` is NOT among them, the prod feature never fires. Check via Stripe Dashboard → Developers → Webhooks → that endpoint → Events, OR Stripe CLI against the LIVE key. If missing, add `customer.subscription.updated` to the endpoint's event list. (Auth is already protected; adding an event is safe.)

- [ ] **Step 4: Merge + deploy (coordinated with wao1234)**

After agreement: `gh pr merge <PR#> --merge --delete-branch`, then on the VPS run `bash deploy/deploy.sh` (it does `git pull` + build + pm2 restart). Because the schema changed, ensure deploy applies `prisma db push` (or run it manually on the VPS: `cd /var/www/ai-content && npx prisma db push`). Back up the DB first: `cp prisma/dev.db prisma/dev.db.bak-cancelresume-$(date +%s)`.

- [ ] **Step 5: Smoke-check prod**

Confirm `/settings?tab=billing` loads with no banner for an active non-cancelled subscriber, and that a portal-initiated cancel surfaces the banner (or simulate with a real test if a safe account exists).

---

## Self-Review notes (completed by plan author)

- **Spec coverage:** schema (Task 1) ✓, webhook `subscription.updated` cancel+resume (Task 2) ✓, reactivate route — renamed to avoid the existing `resume` route collision (Task 3) ✓, UI banner + button (Task 5) ✓, `/api/user/me` exposure needed by the UI (Task 4, not in spec but required by the data flow — added) ✓, testing (Task 6) ✓, deploy notes incl. live-endpoint event check (Task 7) ✓.
- **No placeholders:** every code step contains full code; commands have expected output.
- **Type consistency:** `cancelAtPeriodEnd` (Boolean) and `cancelAt` (DateTime → ISO string in JSON) used identically across schema, webhook, route, `/api/user/me`, and the component. The component reads `cancelAt` as `string | null` and formats with `new Date(...)`.
- **Known deviation from default TDD:** repo has no unit-test runner and `package.json` is shared with wao1234 → verification is the CI build gate + local Stripe test-mode E2E (Task 6), matching the project's established pattern.
