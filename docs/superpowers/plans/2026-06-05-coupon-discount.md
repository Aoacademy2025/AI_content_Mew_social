# Coupon DISCOUNT type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `DISCOUNT` coupon type that gives a % off at Stripe checkout (via Stripe promotion codes), alongside the existing GRANT (free-access) coupons.

**Architecture:** Stripe is the discount engine; the app is the source of truth. Admin-create syncs a Stripe Coupon + Promotion Code onto the app `Coupon` row. The pricing-page CouponBox validates a code and (for DISCOUNT) reports it up; the page shows the discounted price and threads the code to `/api/payments/checkout`, which attaches `discounts:[{promotion_code}]`. The `checkout.session.completed` webhook records the redemption.

**Tech Stack:** Next.js 15 API routes, Prisma 6 + SQLite, Stripe SDK 22.1.1 (`percent_off` coupons, promotion codes, `discounts` on Checkout Sessions), React 19 client components, Clerk, `sonner`.

**Repo conventions:**
- Routes: `getCurrentUser()` from `@/lib/clerk-auth`; admin guard `role === "ADMIN"`; `apiError({route,error})`; `await ensureStripeConfig()` before any `stripe.*`.
- No unit-test runner (shared `package.json` — don't add one). Verify with `npm run build` (CI gate) + chrome-devtools/Stripe-test E2E. The backend Stripe flows are asserted via the Stripe test API.
- `prisma/schema.prisma` shared with wao1234 (additive change → low risk; coordinate deploy).
- Stripe API `2026-04-22.dahlia`; client in `src/lib/stripe.ts`.

**Branch:** `mew/coupon-discount` (already created off `main`).

**Shared type** (used by CouponBox + pricing page, Task 6):
```ts
type ValidatedCoupon = { code: string; type: "GRANT" | "DISCOUNT"; plan: string; percentOff: number | null; discountDuration: string | null; durationDays: number };
```

---

### Task 1: Schema — add DISCOUNT fields to `Coupon`

**Files:** Modify `prisma/schema.prisma` (Coupon model)

- [ ] **Step 1: Add fields**

Find:
```prisma
  maxUses     Int       @default(1)
  usedCount   Int       @default(0)
  expiresAt   DateTime?
  createdAt   DateTime  @default(now())
  redemptions CouponRedemption[]
```
Replace with:
```prisma
  maxUses     Int       @default(1)
  usedCount   Int       @default(0)
  expiresAt   DateTime?
  type                  String   @default("GRANT") // GRANT | DISCOUNT
  percentOff            Int?                         // 1-100, DISCOUNT only
  discountDuration      String?                      // "once" | "forever", DISCOUNT only
  stripeCouponId        String?                      // Stripe Coupon id (DISCOUNT)
  stripePromotionCodeId String?                      // Stripe Promotion Code id (DISCOUNT)
  createdAt   DateTime  @default(now())
  redemptions CouponRedemption[]
```

- [ ] **Step 2: Push to local DB + verify**

Run: `npx prisma db push`
Expected: "Your database is now in sync" + "Generated Prisma Client".
Run: `node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().coupon.findFirst({select:{type:true,percentOff:true,stripePromotionCodeId:true}}).then(r=>{console.log('ok',r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `ok null` (empty table) or a row — no error.

- [ ] **Step 3: Commit**
```bash
git add prisma/schema.prisma
git commit -m "feat(schema): Coupon DISCOUNT fields (type/percentOff/duration/stripe ids)"
```

---

### Task 2: Admin create — sync Stripe Coupon + Promotion Code for DISCOUNT

**Files:** Modify `src/app/api/admin/coupons/route.ts` (the `POST` handler)

- [ ] **Step 1: Replace the POST handler body**

Find the current `POST` (from `export async function POST` to its closing `}` before `// DELETE`). Replace the inside of the `try` with:

```ts
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdmin(authUser)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const {
      code, plan = "PRO", durationDays = 30, maxUses = 1, expiresAt,
      type = "GRANT", percentOff, discountDuration,
    } = body;

    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });
    if (!["GRANT", "DISCOUNT"].includes(type)) return NextResponse.json({ error: "type ไม่ถูกต้อง" }, { status: 400 });

    const normCode = code.trim().toUpperCase();
    let stripeCouponId: string | null = null;
    let stripePromotionCodeId: string | null = null;

    if (type === "DISCOUNT") {
      const pct = Number(percentOff);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100)
        return NextResponse.json({ error: "percentOff ต้องเป็น 1-100" }, { status: 400 });
      if (!["once", "forever"].includes(discountDuration))
        return NextResponse.json({ error: "discountDuration ต้องเป็น once หรือ forever" }, { status: 400 });

      const { ensureStripeConfig } = await import("@/lib/load-stripe-config");
      const { stripe } = await import("@/lib/stripe");
      await ensureStripeConfig();
      const sc = await stripe.coupons.create({ percent_off: pct, duration: discountDuration as "once" | "forever", name: normCode });
      const promo = await stripe.promotionCodes.create({
        coupon: sc.id,
        code: normCode,
        ...(Number(maxUses) > 0 ? { max_redemptions: Number(maxUses) } : {}),
        ...(expiresAt ? { expires_at: Math.floor(new Date(expiresAt).getTime() / 1000) } : {}),
      });
      stripeCouponId = sc.id;
      stripePromotionCodeId = promo.id;
    } else {
      if (!["FREE", "PRO", "BUSINESS"].includes(plan))
        return NextResponse.json({ error: `Invalid plan: ${plan}` }, { status: 400 });
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: normCode,
        plan: type === "DISCOUNT" ? "PRO" : plan,
        durationDays: Number(durationDays),
        maxUses: Number(maxUses),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        type,
        percentOff: type === "DISCOUNT" ? Number(percentOff) : null,
        discountDuration: type === "DISCOUNT" ? discountDuration : null,
        stripeCouponId,
        stripePromotionCodeId,
      },
    });
    return NextResponse.json(coupon);
```

Keep the existing `catch` (P2002 → "รหัสคูปองนี้มีอยู่แล้ว").

- [ ] **Step 2: Build**
Run: `npm run build`
Expected: compiles, no TS error.

- [ ] **Step 3: Commit**
```bash
git add src/app/api/admin/coupons/route.ts
git commit -m "feat(admin): create DISCOUNT coupons synced to Stripe coupon+promo"
```

---

### Task 3: Validate endpoint (no side effects)

**Files:** Create `src/app/api/coupons/validate/route.ts`

- [ ] **Step 1: Write the route**
```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

// Validates a coupon WITHOUT redeeming/granting. Used to preview a DISCOUNT before checkout.
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { code } = await req.json();
    if (!code?.trim()) return NextResponse.json({ error: "กรุณากรอกรหัสคูปอง" }, { status: 400 });

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: { redemptions: { where: { userId: authUser.id } } },
    });
    if (!coupon) return NextResponse.json({ error: "รหัสคูปองไม่ถูกต้อง" }, { status: 404 });
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      return NextResponse.json({ error: "คูปองหมดอายุแล้ว" }, { status: 400 });
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses)
      return NextResponse.json({ error: "คูปองถูกใช้ครบจำนวนแล้ว" }, { status: 400 });
    if (coupon.redemptions.length > 0)
      return NextResponse.json({ error: "คุณเคยใช้คูปองนี้แล้ว" }, { status: 400 });

    return NextResponse.json({
      code: coupon.code,
      type: coupon.type,
      plan: coupon.plan,
      percentOff: coupon.percentOff,
      discountDuration: coupon.discountDuration,
      durationDays: coupon.durationDays,
    });
  } catch (error) {
    return apiError({ route: "POST /api/coupons/validate", error });
  }
}
```

- [ ] **Step 2: Build** — `npm run build` → compiles.
- [ ] **Step 3: Commit**
```bash
git add src/app/api/coupons/validate/route.ts
git commit -m "feat(coupons): add validate endpoint (preview without redeeming)"
```

---

### Task 4: Checkout — accept `couponCode`, attach Stripe discount

**Files:** Modify `src/app/api/payments/checkout/route.ts`

- [ ] **Step 1: Read couponCode from the body**

Find:
```ts
    const { plan, period = "annual", method = "card" } =
      await req.json() as { plan: PlanKey; period?: BillingPeriod; method?: "card" | "promptpay" };
```
Replace with:
```ts
    const { plan, period = "annual", method = "card", couponCode } =
      await req.json() as { plan: PlanKey; period?: BillingPeriod; method?: "card" | "promptpay"; couponCode?: string };
```

- [ ] **Step 2: Resolve a valid DISCOUNT coupon before creating the session**

Find:
```ts
    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
```
Insert ABOVE it:
```ts
    // Resolve an optional DISCOUNT coupon (ignored if invalid — never block the purchase)
    let discountCoupon: { id: string; stripePromotionCodeId: string } | null = null;
    if (couponCode?.trim()) {
      const c = await prisma.coupon.findUnique({
        where: { code: couponCode.trim().toUpperCase() },
        include: { redemptions: { where: { userId } } },
      });
      const usable = c && c.type === "DISCOUNT" && c.stripePromotionCodeId
        && (!c.expiresAt || c.expiresAt >= new Date())
        && (c.maxUses <= 0 || c.usedCount < c.maxUses)
        && c.redemptions.length === 0;
      if (usable) discountCoupon = { id: c.id, stripePromotionCodeId: c.stripePromotionCodeId };
    }
```

- [ ] **Step 3: Attach the discount + couponId metadata to the session**

Find:
```ts
      line_items: [{ price: priceCfg.priceId, quantity: 1 }],
      metadata: { userId, plan, period, periodDays: String(priceCfg.periodDays), method },
```
Replace with:
```ts
      line_items: [{ price: priceCfg.priceId, quantity: 1 }],
      ...(discountCoupon ? { discounts: [{ promotion_code: discountCoupon.stripePromotionCodeId }] } : {}),
      metadata: { userId, plan, period, periodDays: String(priceCfg.periodDays), method, ...(discountCoupon ? { couponId: discountCoupon.id } : {}) },
```

- [ ] **Step 4: Build** — `npm run build` → compiles.
- [ ] **Step 5: Commit**
```bash
git add src/app/api/payments/checkout/route.ts
git commit -m "feat(checkout): apply DISCOUNT coupon via Stripe promotion code"
```

---

### Task 5: Webhook — record redemption on completed checkout

**Files:** Modify `src/app/api/payments/webhook/route.ts` (the `checkout.session.completed` block)

- [ ] **Step 1: Record the redemption**

Inside the `if (event.type === "checkout.session.completed")` block, find:
```ts
      console.log(`[stripe-webhook] ${userId} → ${plan} until ${newExpiry} (mode=${s.mode})`);
```
Insert ABOVE it:
```ts
      const couponId = s.metadata?.couponId;
      if (couponId) {
        try {
          await prisma.couponRedemption.create({ data: { couponId, userId } });
          await prisma.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
          console.log(`[stripe-webhook] coupon ${couponId} redeemed by ${userId}`);
        } catch { /* already recorded (unique guard) — webhook retry, ignore */ }
      }
```

- [ ] **Step 2: Build** — `npm run build` → compiles.
- [ ] **Step 3: Commit**
```bash
git add src/app/api/payments/webhook/route.ts
git commit -m "feat(webhook): record CouponRedemption when a discounted checkout completes"
```

---

### Task 6: CouponBox callback + pricing-page discount UI

**Files:**
- Modify `src/components/settings/coupon-box.tsx`
- Modify `src/app/(dashboard)/pricing/page.tsx`

- [ ] **Step 1: CouponBox — accept `onDiscountApplied`, branch GRANT vs DISCOUNT**

In `src/components/settings/coupon-box.tsx`, change the component signature + `redeem()`:

Replace:
```tsx
export function CouponBox() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function redeem() {
    if (!code.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/coupons/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "เกิดข้อผิดพลาด"); return; }
      toast.success(data.message);
      setCode("");
      window.location.reload();
    } finally {
      setLoading(false);
    }
  }
```
with:
```tsx
type ValidatedCoupon = { code: string; type: "GRANT" | "DISCOUNT"; plan: string; percentOff: number | null; discountDuration: string | null; durationDays: number };

export function CouponBox({ onDiscountApplied }: { onDiscountApplied?: (c: ValidatedCoupon) => void } = {}) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function redeem() {
    if (!code.trim()) return;
    setLoading(true);
    try {
      const vr = await fetch("/api/coupons/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const v = await vr.json();
      if (!vr.ok) { toast.error(v.error ?? "รหัสคูปองไม่ถูกต้อง"); return; }

      if (v.type === "DISCOUNT") {
        if (!onDiscountApplied) { toast.message("ใช้โค้ดส่วนลดนี้ที่หน้าราคา"); return; }
        onDiscountApplied(v as ValidatedCoupon);
        toast.success(`ใช้ส่วนลด ${v.percentOff}% แล้ว`);
        setCode("");
        return;
      }

      // GRANT — redeem instantly (unchanged behavior)
      const res = await fetch("/api/coupons/redeem", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "เกิดข้อผิดพลาด"); return; }
      toast.success(data.message);
      setCode("");
      window.location.reload();
    } finally {
      setLoading(false);
    }
  }
```

- [ ] **Step 2: Pricing page — add `appliedCoupon` state**

In `src/app/(dashboard)/pricing/page.tsx`, find:
```tsx
  const [method, setMethod] = useState<"card" | "promptpay">("card");
```
Add below:
```tsx
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentOff: number | null } | null>(null);
```

- [ ] **Step 3: Pricing page — send couponCode in checkout**

Find:
```tsx
        body: JSON.stringify({ plan: planKey, period, method }),
```
Replace with:
```tsx
        body: JSON.stringify({ plan: planKey, period, method, couponCode: appliedCoupon?.code }),
```

- [ ] **Step 4: Pricing page — pass the callback to CouponBox**

Find:
```tsx
      <div className="max-w-xl mx-auto mb-8"><CouponBox /></div>
```
Replace with:
```tsx
      <div className="max-w-xl mx-auto mb-8">
        <CouponBox onDiscountApplied={(c) => setAppliedCoupon({ code: c.code, percentOff: c.percentOff })} />
        {appliedCoupon && (
          <div className="mt-2 flex items-center justify-center gap-2 text-xs" style={{ color: "hsl(142 60% 60%)" }}>
            <span>ใช้โค้ด {appliedCoupon.code} · ลด {appliedCoupon.percentOff}%</span>
            <button onClick={() => setAppliedCoupon(null)} className="underline opacity-80 hover:opacity-100">ลบ</button>
          </div>
        )}
      </div>
```

- [ ] **Step 5: Pricing page — show discounted price on paid cards**

Find the price block:
```tsx
                  ) : (
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-semibold mt-2" style={{ color: "var(--ui-text-muted)" }}>฿</span>
                      <span className="text-5xl font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                        {(period === "annual" ? price * 10 : price).toLocaleString()}
                      </span>
                      <span className="text-sm ml-1" style={{ color: "var(--ui-text-muted)" }}>{period === "annual" ? "/ปี" : "/30 วัน"}</span>
                    </div>
                  )}
```
Replace with:
```tsx
                  ) : (() => {
                    const base = period === "annual" ? price * 10 : price;
                    const pct = appliedCoupon?.percentOff ?? 0;
                    const final = pct > 0 ? Math.round(base * (1 - pct / 100)) : base;
                    return (
                      <div className="flex items-baseline gap-1 flex-wrap">
                        <span className="text-2xl font-semibold mt-2" style={{ color: "var(--ui-text-muted)" }}>฿</span>
                        <span className="text-5xl font-bold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                          {final.toLocaleString()}
                        </span>
                        <span className="text-sm ml-1" style={{ color: "var(--ui-text-muted)" }}>{period === "annual" ? "/ปี" : "/30 วัน"}</span>
                        {pct > 0 && (
                          <span className="ml-2 text-sm line-through" style={{ color: "var(--ui-text-muted)" }}>฿{base.toLocaleString()}</span>
                        )}
                        {pct > 0 && (
                          <span className="ml-1 text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: "hsl(142 60% 50% / 0.15)", color: "hsl(142 60% 60%)" }}>ลด {pct}%</span>
                        )}
                      </div>
                    );
                  })()}
```

- [ ] **Step 6: Build** — `npm run build` → compiles (pricing page + CouponBox).
- [ ] **Step 7: Commit**
```bash
git add src/components/settings/coupon-box.tsx "src/app/(dashboard)/pricing/page.tsx"
git commit -m "feat(pricing): DISCOUNT coupon entry + discounted price display"
```

---

### Task 7: Local E2E (Stripe test mode + chrome-devtools)

**Goal:** Prove the full DISCOUNT flow and that GRANT still works. Backend asserted via Stripe test API; UI via chrome-devtools. Dev server on `:3005` (`:3000` is a different project). Logged in as `mewtest+clerk_test@example.com` (email+password, 2FA `424242`). The test user must have `role:"ADMIN"` to hit admin routes — set it directly for the test: `node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().user.update({where:{email:'mewtest+clerk_test@example.com'},data:{role:'ADMIN'}}).then(()=>process.exit(0))"` (restore after).

- [ ] **Step 1:** Create a DISCOUNT coupon via the admin API (from the logged-in browser): `evaluate_script` → `fetch('/api/admin/coupons',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'E2EDISC50',type:'DISCOUNT',percentOff:50,discountDuration:'once',maxUses:0})}).then(r=>r.json())`. Expected: returns a coupon with non-null `stripeCouponId` + `stripePromotionCodeId`.
- [ ] **Step 2:** Validate: `fetch('/api/coupons/validate',{method:'POST',...,body:JSON.stringify({code:'E2EDISC50'})})` → `{type:"DISCOUNT",percentOff:50}`.
- [ ] **Step 3:** On `/pricing`, type `E2EDISC50` in the CouponBox → assert the "ลด 50%" applied line shows and the BUSINESS card price halves (฿9,900 → ฿4,950) with the original struck through.
- [ ] **Step 4:** Intercept the checkout call (patch `window.fetch` as in the PromptPay E2E) → click "อัปเกรดเป็น Business" → assert request body has `couponCode:"E2EDISC50"`; from the returned `cs_test_…`, retrieve via Stripe API → assert `total_details.amount_discount === 495000` (50% of 990000) and a discount is present.
- [ ] **Step 5:** GRANT regression: create `node`-side a GRANT coupon and confirm `/api/coupons/redeem` still grants instantly (or just confirm an existing GRANT code path is untouched).
- [ ] **Step 6:** Cleanup: delete the test coupon + its Stripe objects; restore the user's `role`; clear any PENDING payments. Record result in the PR.

---

### Task 8: Ship — PR, db push, deploy

**Goal:** Merge + deploy. Schema change → needs `prisma db push`. **Gate: Mew's go + deploy timing aligned with wao1234.**

- [ ] **Step 1:** `git push -u origin mew/coupon-discount` then `gh pr create --base main --head mew/coupon-discount --title "feat: Coupon DISCOUNT type (% off via Stripe promo)" --body "Adds DISCOUNT coupons (% off at checkout via Stripe promotion codes) alongside GRANT. Schema additive (db push). Spec/plan in docs/superpowers. Local E2E (Stripe test) passed."`
- [ ] **Step 2:** `gh pr checks <PR#>` → `Build` = pass.
- [ ] **Step 3:** Merge after go: `gh pr merge <PR#> --merge --delete-branch`.
- [ ] **Step 4:** Deploy on VPS (schema changed): backup DB `cp prisma/dev.db prisma/dev.db.bak-coupondisc-$(date +%s)` → `git pull` → `npx prisma db push` → `bash deploy/deploy.sh`.
- [ ] **Step 5:** Smoke: `/pricing` 200; create a tiny real DISCOUNT coupon via admin → validate → confirm discounted price renders; check pm2 healthy + no new errors.

---

## Self-Review notes (by plan author)

- **Spec coverage:** schema (T1) ✓; admin Stripe sync (T2) ✓; validate endpoint (T3) ✓; checkout discount attach + metadata (T4) ✓; webhook redemption (T5) ✓; CouponBox callback + pricing discount UI (T6) ✓; testing incl. GRANT regression (T7) ✓; deploy w/ db push (T8) ✓.
- **No placeholders:** every code step has full code; commands have expected output.
- **Type consistency:** `ValidatedCoupon` (with `type/percentOff/discountDuration/durationDays`) defined once and used in CouponBox + page; `couponCode` flows page→checkout; `metadata.couponId` set in checkout (T4) and read in webhook (T5); `stripePromotionCodeId`/`stripeCouponId` set in T2 and read in T4.
- **YAGNI:** percent-only, no stacking, DISCOUNT not plan-restricted (Stripe % applies to any paid line item), founding counter + claim page excluded.
- **Known deviation from TDD:** no unit-test runner (shared package.json) → CI build gate + Stripe-test E2E, per project pattern.
