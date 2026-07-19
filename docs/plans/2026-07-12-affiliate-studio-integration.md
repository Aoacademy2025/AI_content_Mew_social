# HERO AI Studio × Hero Affiliate Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HERO AI Creator Studio (studio.heroaiengine.com) a commissionable product in the live hero-affiliate system, with 25% recurring commission on every plan payment, trial-proof attribution, and a redesigned affiliate marketing site.

**Architecture:** Two repos change. **Studio** (`/Users/mewsocialmacmini/projects/AI_content_Mew_social`, SQLite/Prisma 6, Clerk, deployed on VPS from `main`) captures `?ref=` into a 30-day cookie, stamps it permanently onto the User row at first sign-in, and injects it into Stripe Checkout `metadata` + `subscription_data.metadata`. **hero-affiliate** (`/Users/mewsocialmacmini/projects/hero-affiliate`, Neon Postgres/Prisma 7, Vercel, affiliate.heroaiengine.com) learns to handle `invoice.paid` renewal events, computes commission from the **actual amount paid** (ex-VAT), and gets a redesigned `/` + `/affiliate-program` in the Studio violet house style.

**Tech Stack:** Next.js 15 (studio) / Next.js 14 (affiliate), Prisma, Stripe webhooks, Vitest (affiliate), tsx verify scripts (studio), Tailwind + shadcn/ui.

## Locked Decisions (interview 2026-07-12 — do not re-open)

1. **Commission: 25% flat across all tiers** for all HERO AI Studio products, **recurring on every payment for the lifetime of the subscription**, computed from the **actual amount paid after discounts, VAT (7%) deducted first**.
2. **Commissionable:** plan payments only — subscription monthly/annual (card) and one-time annual (PromptPay/card), including Founding-100 discounted annuals. **NOT commissionable:** credit packs, admin-recorded manual payments.
3. **Attribution:** `aff_ref` cookie 30 days, last-click wins. At registration the current cookie value is stamped onto the Studio User row **once, permanently, never expires, never updated later**. At checkout: live cookie wins, else fall back to the stamp.
4. **Studio promotion:** footer link on the sale page + item in the dashboard account menu → `https://affiliate.heroaiengine.com/affiliate-program`.
5. **Redesign scope:** affiliate site `/` and `/affiliate-program` only, in Studio's violet house system. Dashboard/admin untouched.
6. **Launch comms:** one pinned `/updates` post on Studio. Nothing else.
7. Existing program rules unchanged: self-referral ban (email match), 30-day holding on every payment incl. renewals, min payout ฿500, manual payout, 3% withholding + 50 ทวิ.

## Global Constraints

- **Studio `main` = production.** Work on branch `mew/affiliate-tracking`; PR into main; Mew merges + deploys.
- **hero-affiliate `main` auto-deploys on Vercel.** Work on branch `feat/hero-studio-recurring`; PR into main.
- **Never break the คลังแสง flow.** All webhook/schema changes must be backward compatible; the existing 185 Vitest tests must keep passing (adjust a test ONLY where this plan explicitly changes behavior, i.e. amount-based commission).
- **Prisma:** studio schema change must be additive (deployed via `prisma db push`). Affiliate schema change ships as a real migration (`prisma migrate dev` locally → `prisma migrate deploy` against Neon).
- **Canonical shared identifiers** (produced by Task 1, consumed by Tasks 3–4 — copy verbatim):
  - Cookie name: `aff_ref` (value may be URI-encoded; valid pattern `^[A-Za-z0-9_-]{1,32}$` after decode)
  - Stripe metadata keys: `ref_code`, `product_id`, `ha_brand: "hero-ai"`
  - Product slugs: `hero-studio-pro-monthly`, `hero-studio-pro-annual`, `hero-studio-business-monthly`, `hero-studio-business-annual` (annual slug covers both the card subscription and the one-time PromptPay purchase)
- **Canonical commission numbers** (25% of ex-VAT actual price — use these exact values in tests and marketing copy):
  | Payment | Paid | Commission |
  |---|---|---|
  | PRO monthly | ฿599 | **฿139.95** (display "~฿140/เดือน") |
  | BUSINESS monthly | ฿990 | **฿231.31** (display "~฿231/เดือน") |
  | PRO annual | ฿5,990 | **฿1,399.53** (display "~฿1,400") |
  | BUSINESS annual | ฿9,900 | **฿2,313.08** (display "~฿2,313") |
  | PRO annual + Founding 50% | ฿2,995 | **฿699.77** |
  | BUSINESS annual + Founding 50% | ฿4,950 | **฿1,156.54** |
- Thai marketing copy in this plan is **final copy** — workers use it verbatim, no improvisation.

---

## Task 1: Studio — ref capture, permanent stamp, checkout metadata, promo links

**Repo:** `/Users/mewsocialmacmini/projects/AI_content_Mew_social` · branch `mew/affiliate-tracking`

**Files:**
- Create: `src/lib/affiliate-ref.ts`
- Create: `scripts/verify-affiliate-ref.ts`
- Modify: `prisma/schema.prisma` (User model)
- Modify: `src/middleware.ts:42-44`
- Modify: `src/app/page.tsx` (script include + footer link)
- Modify: `src/lib/clerk-auth.ts:143-168` (lazy-create branch)
- Modify: `src/app/api/payments/checkout/route.ts:108-128`
- Modify: `src/components/layout/account-menu.tsx` (new menu item)

**Interfaces:**
- Produces: `sanitizeRefCode(raw: string | null | undefined): string | null`, `studioProductSlug(plan: string, period: string): string`, `AFF_COOKIE = "aff_ref"` in `src/lib/affiliate-ref.ts`; Stripe session metadata `{ ref_code, product_id, ha_brand }` and `subscription_data.metadata.ref_code` + `.product_id` consumed by hero-affiliate webhook (Task 3).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Pure helper lib** — create `src/lib/affiliate-ref.ts`:

```ts
// Affiliate ref-code plumbing shared by middleware, auth lazy-create, and checkout.
export const AFF_COOKIE = "aff_ref";
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function sanitizeRefCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    // keep raw if not URI-encoded
  }
  return REF_RE.test(v) ? v : null;
}

export function studioProductSlug(plan: string, period: string): string {
  return `hero-studio-${plan.toLowerCase()}-${period.toLowerCase()}`;
}
```

- [ ] **Step 2: Verify script (studio test pattern)** — create `scripts/verify-affiliate-ref.ts` (run with `npx tsx scripts/verify-affiliate-ref.ts`; follow the assert-and-log style of the existing `scripts/verify-*.ts`):

```ts
import { sanitizeRefCode, studioProductSlug } from "../src/lib/affiliate-ref";
import assert from "node:assert";

assert.equal(sanitizeRefCode("MEW1234"), "MEW1234");
assert.equal(sanitizeRefCode("MEW%20X"), null);            // decodes to "MEW X" → invalid
assert.equal(sanitizeRefCode(encodeURIComponent("A_b-9")), "A_b-9");
assert.equal(sanitizeRefCode("<script>"), null);
assert.equal(sanitizeRefCode(""), null);
assert.equal(sanitizeRefCode(null), null);
assert.equal(sanitizeRefCode("x".repeat(33)), null);
assert.equal(studioProductSlug("PRO", "monthly"), "hero-studio-pro-monthly");
assert.equal(studioProductSlug("BUSINESS", "annual"), "hero-studio-business-annual");
console.log("verify-affiliate-ref: ALL PASS");
```

Run it; expect `ALL PASS`.

- [ ] **Step 3: Schema** — in `prisma/schema.prisma` User model add one nullable column (additive → safe for prod `prisma db push`):

```prisma
  affiliateRefCode   String?   // hero-affiliate refCode stamped once at first sign-in; never updated after
```

Run `npx prisma generate` (do NOT run migrate against dev.db if it drifts; `db push` on a scratch copy is fine).

- [ ] **Step 4: Middleware — stop dropping `?ref=` for logged-in users.** In `src/middleware.ts`, the block at lines 42-44 currently redirects `/` → `/dashboard` and loses the query string. Replace with:

```ts
if (userId && req.nextUrl.pathname === "/") {
  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  const ref = sanitizeRefCode(req.nextUrl.searchParams.get("ref"));
  if (ref) {
    res.cookies.set(AFF_COOKIE, ref, {
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  }
  return res;
}
```

Import `{ AFF_COOKIE, sanitizeRefCode }` from `@/lib/affiliate-ref` (pure module — edge-safe). Anonymous visitors are not redirected; the tracking script handles them.

- [ ] **Step 5: Tracking script on the sale page.** In `src/app/page.tsx` add at the end of the returned JSX (server components may render `next/script`):

```tsx
import Script from "next/script";
// ... inside the returned fragment, after the footer:
<Script src="https://affiliate.heroaiengine.com/scripts/affiliate-tracking.js" strategy="afterInteractive" />
```

This sets the `aff_ref` cookie for anonymous visitors AND posts the click record to affiliate.heroaiengine.com (CORS is opened in Task 3).

- [ ] **Step 6: Stamp at lazy-create.** In `src/lib/clerk-auth.ts`, inside the lazy-create branch (lines 143-168), before `prisma.user.create`:

```ts
import { cookies } from "next/headers";
import { AFF_COOKIE, sanitizeRefCode } from "@/lib/affiliate-ref";

let affiliateRefCode: string | null = null;
try {
  const jar = await cookies();
  affiliateRefCode = sanitizeRefCode(jar.get(AFF_COOKIE)?.value);
} catch {
  // outside request scope (service actor path) — no stamp
}
```

and add to the create data: `...(affiliateRefCode ? { affiliateRefCode } : {})`. Do NOT add any code path that updates this field later — the stamp is written once, by design.

- [ ] **Step 7: Checkout metadata.** In `src/app/api/payments/checkout/route.ts`:

Resolve the ref (cookie wins, stamp is fallback) near the top of the handler, after the user is loaded:

```ts
let refCode: string | null = null;
try {
  const jar = await cookies();
  refCode = sanitizeRefCode(jar.get(AFF_COOKIE)?.value);
} catch {}
refCode = refCode ?? user.affiliateRefCode ?? null;
const affiliateMeta = refCode
  ? { ref_code: refCode, product_id: studioProductSlug(plan, period), ha_brand: "hero-ai" }
  : {};
```

Then spread into BOTH metadata blocks in `stripe.checkout.sessions.create` (lines 108-128):
- session `metadata: { ...existing, ...affiliateMeta }`
- `subscription_data: { metadata: { userId, plan, period, ...affiliateMeta } }` (subscription mode only — this is what makes renewal invoices attributable).

Do NOT touch `src/app/api/payments/credits/route.ts` — credit packs earn no commission (locked decision 2).

- [ ] **Step 8: Footer link.** In the `<footer>` of `src/app/page.tsx` (lines ~330-369), under the trial-note `<p>` and above the wordmark, add:

```tsx
<a
  href="https://affiliate.heroaiengine.com/affiliate-program"
  className="text-sm text-white/50 underline-offset-4 hover:text-white hover:underline"
>
  โปรแกรมพันธมิตร — แนะนำ HERO AI รับค่าคอม 25% ทุกเดือน
</a>
```

(match surrounding footer classes/spacing; keep the violet design system.)

- [ ] **Step 9: Account menu item.** In `src/components/layout/account-menu.tsx`, after the Billing item (line ~99), add:

```tsx
<DropdownMenuItem asChild>
  <a href="https://affiliate.heroaiengine.com/affiliate-program" target="_blank" rel="noopener noreferrer">
    <Handshake className="mr-2 h-4 w-4" />
    โปรแกรมพันธมิตร
  </a>
</DropdownMenuItem>
```

Add `Handshake` to the existing `lucide-react` import.

- [ ] **Step 10: Build + verify.** Run `npx tsx scripts/verify-affiliate-ref.ts` (ALL PASS) and `npm run build` (must pass). Manual smoke in dev: visit `/?ref=TEST123` logged-out → cookie `aff_ref=TEST123` present; logged-in → redirected to /dashboard AND cookie set.

- [ ] **Step 11: Commit** — `feat(affiliate): capture ref, stamp user at signup, tag checkout metadata, promo links`

---

## Task 2: Studio — /updates launch post script

**Repo:** studio · branch `mew/affiliate-tracking` (after Task 1 merges to the branch)

**Files:**
- Create: `scripts/publish-affiliate-update.ts` (model on `scripts/publish-v1.0.0-update.ts` — idempotent by `version`)

**Interfaces:** none. Script is only RUN at launch (ops checklist), on the VPS inside `/var/www/ai-content`.

- [ ] **Step 1:** Create the script. Copy the structure of `scripts/publish-v1.0.0-update.ts` exactly (same prisma import, same idempotency check on `version`), with:
  - `version: "affiliate-2026-07"`, `isPinned: true`, `state: PUBLISHED` (use the enum values that exist in `prisma/schema.prisma` — check `ProductUpdateCategory` / `ProductUpdateImportance` / `ProductUpdateState` and pick the feature-announcement category), `publishedAt: new Date()`, `ctaLabel: "สมัครเป็นพันธมิตร"`, `ctaHref: "https://affiliate.heroaiengine.com/affiliate-program"`.
  - `title`: `เปิดตัวโปรแกรมพันธมิตร — แนะนำ HERO AI รับค่าคอม 25% ทุกเดือน`
  - `summary`: `ชวนเพื่อนมาใช้ HERO AI แล้วรับค่าคอมมิชชั่น 25% ของทุกยอดจ่าย ทุกเดือน ตลอดที่ลูกค้ายังใช้งาน`
  - `body` (PLAIN TEXT — /updates does not render markdown):

```
เปิดตัวโปรแกรมพันธมิตร HERO AI อย่างเป็นทางการ

แนะนำ HERO AI Creator Studio ให้เพื่อนหรือผู้ติดตามของคุณ แล้วรับค่าคอมมิชชั่น 25% ของยอดที่ลูกค้าจ่ายจริง ทุกเดือน ตลอดอายุการใช้งานของลูกค้า ไม่ใช่จ่ายครั้งเดียวจบ

ตัวอย่างรายได้: ลูกค้า PRO รายเดือน 1 คน = ~140 บาท/เดือน · ลูกค้า PRO รายปี 1 คน = ~1,400 บาท · มีลูกค้า active 10 คน = รายได้ประจำ ~1,400 บาท/เดือน

สมัครฟรี อนุมัติอัตโนมัติ ไม่ต้องมียอดขั้นต่ำ ใช้ลิงก์ส่วนตัวของคุณแชร์ได้ทันที ระบบติดตามยอดและจ่ายเงินให้ทุกเดือน (โอนตรง หักภาษี ณ ที่จ่าย พร้อมเอกสาร 50 ทวิ)

สมัครได้ที่ affiliate.heroaiengine.com/affiliate-program
```

- [ ] **Step 2:** Dry-run locally against a scratch DB (`DATABASE_URL=file:/tmp/scratch.db npx prisma db push && npx tsx scripts/publish-affiliate-update.ts`) → verify row created, run twice → second run skips. Commit: `chore(updates): affiliate launch post script`.

---

## Task 3: hero-affiliate — recurring webhook + amount-based commission + tier-count fix

**Repo:** `/Users/mewsocialmacmini/projects/hero-affiliate` · branch `feat/hero-studio-recurring` · **security-sensitive (webhook input handling) → run /security-review at review time**

**Files:**
- Modify: `prisma/schema.prisma` (AffiliateReferral) + new migration
- Create: `src/lib/recurring.ts`
- Create: `src/lib/product-match.ts` (extracted from webhook)
- Modify: `src/lib/commission.ts` (add `calculateCommissionFromAmount`)
- Modify: `src/app/api/webhook/stripe/route.ts`
- Modify: `src/app/api/cron/tier-upgrade/route.ts`
- Test: `tests/recurring.test.ts` (new), `tests/product-match.test.ts` (new), `tests/commission.test.ts` (extend), `tests/webhook.test.ts` (adjust ONLY where amount-based commission changes expected values)

**Interfaces:**
- Consumes: Stripe events from Studio's Stripe account carrying `metadata.ref_code` / `metadata.product_id` / `metadata.ha_brand` (session) and the same keys on `subscription_data.metadata` (Task 1).
- Produces: `calculateCommissionFromAmount(amountTHB: number, ratePercent: number): { commissionRate: number; commissionAmount: number }`; `matchProduct(db, { priceId, productSlug, brandSlug }): Promise<AffiliateProduct | null>`; referral rows with `isRenewal`, `stripeInvoiceId`, `stripeSubscriptionId` (consumed by Task 4's display only indirectly — no UI change required).

- [ ] **Step 1: Schema + migration.** Add to `AffiliateReferral`:

```prisma
  stripeInvoiceId      String?   @unique   // idempotency key for renewal invoices
  stripeSubscriptionId String?
  isRenewal            Boolean   @default(false)

  @@index([stripeSubscriptionId])
```

`npx prisma migrate dev --name recurring-referrals` (local/branch DB), `npx prisma generate`.

- [ ] **Step 2: Failing tests first — commission from actual amount.** In `tests/commission.test.ts` add:

```ts
import { calculateCommissionFromAmount } from "@/lib/commission";

describe("calculateCommissionFromAmount (25% studio flat, ex-VAT)", () => {
  it.each([
    [599, 139.95], [990, 231.31], [5990, 1399.53],
    [9900, 2313.08], [2995, 699.77], [4950, 1156.54],
  ])("25%% of ฿%d ex-VAT = ฿%f", (paid, expected) => {
    expect(calculateCommissionFromAmount(paid, 25).commissionAmount).toBe(expected);
  });
  it("keeps the rate it was given", () => {
    expect(calculateCommissionFromAmount(599, 25).commissionRate).toBe(25);
  });
});
```

Run `npx vitest run tests/commission.test.ts` → FAIL (function missing).

- [ ] **Step 3: Implement** in `src/lib/commission.ts`:

```ts
/**
 * Commission from the ACTUAL amount paid (VAT-inclusive THB), not catalog price.
 * Discounts (e.g. Founding-100) therefore flow through to the commission.
 */
export function calculateCommissionFromAmount(amountTHB: number, ratePercent: number) {
  const exVat = amountTHB / (1 + VAT_RATE);
  const commissionAmount = Math.round(exVat * (ratePercent / 100) * 100) / 100;
  return { commissionRate: ratePercent, commissionAmount };
}
```

Run tests → PASS. Commit.

- [ ] **Step 4: Extract product matching.** Create `src/lib/product-match.ts` with the exact 3-layer logic currently inline at `webhook/stripe/route.ts:145-184`, generalized:

```ts
import type { PrismaClient } from "@/generated/prisma/client";

export interface ProductMatchInput {
  priceId?: string | null;     // Stripe price id from line item
  productSlug?: string | null; // metadata.product_id
  brandSlug?: string | null;   // metadata.ha_brand
}

export async function matchProduct(db: PrismaClient, input: ProductMatchInput) {
  if (input.priceId) {
    const byPrice = await db.affiliateProduct.findFirst({
      where: { stripePriceId: input.priceId, isActive: true },
    });
    if (byPrice) return byPrice;
  }
  if (input.productSlug) {
    const bySlug = await db.affiliateProduct.findFirst({
      where: { slug: input.productSlug, isActive: true },
    });
    if (bySlug) return bySlug;
  }
  if (input.brandSlug) {
    const brand = await db.affiliateBrand.findFirst({
      where: { slug: input.brandSlug, isActive: true },
    });
    if (brand) {
      return db.affiliateProduct.findFirst({
        where: { brandId: brand.id, isActive: true },
      });
    }
  }
  return null;
}
```

Refactor `handleCheckoutCompleted` to call it (same order as today: price id → product_id slug → ha_brand). Add `tests/product-match.test.ts` covering the ordering with a mocked `db` object (plain object with vi.fn() methods — no real DB, per repo test convention). Run → PASS. Commit.

- [ ] **Step 5: Failing tests — invoice helpers.** Create `src/lib/recurring.ts` test-first (`tests/recurring.test.ts`):

```ts
import { getSubscriptionMetadata, getInvoiceSubscriptionId, isFirstSubscriptionInvoice } from "@/lib/recurring";

describe("invoice event parsing (API-version tolerant)", () => {
  const meta = { ref_code: "MEW1", product_id: "hero-studio-pro-monthly", plan: "PRO", period: "monthly" };
  it("reads metadata from invoice.parent.subscription_details (2025+ API shape)", () => {
    expect(getSubscriptionMetadata({ parent: { subscription_details: { metadata: meta } } })).toEqual(meta);
  });
  it("reads metadata from invoice.subscription_details (older shape)", () => {
    expect(getSubscriptionMetadata({ subscription_details: { metadata: meta } })).toEqual(meta);
  });
  it("returns {} when absent", () => {
    expect(getSubscriptionMetadata({})).toEqual({});
  });
  it("finds subscription id in either shape (string or object)", () => {
    expect(getInvoiceSubscriptionId({ subscription: "sub_1" })).toBe("sub_1");
    expect(getInvoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_2" } } })).toBe("sub_2");
    expect(getInvoiceSubscriptionId({ subscription: { id: "sub_3" } })).toBe("sub_3");
    expect(getInvoiceSubscriptionId({})).toBeNull();
  });
  it("flags first invoice by billing_reason subscription_create", () => {
    expect(isFirstSubscriptionInvoice({ billing_reason: "subscription_create" })).toBe(true);
    expect(isFirstSubscriptionInvoice({ billing_reason: "subscription_cycle" })).toBe(false);
  });
});
```

Run → FAIL. Implement `src/lib/recurring.ts`:

```ts
/* Invoice shapes moved between Stripe API versions; the webhook must accept both.
   We never call the Stripe API from this app (webhook-verify only), so everything
   must come from the event payload itself. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyInvoice = any;

export function getSubscriptionMetadata(invoice: AnyInvoice): Record<string, string> {
  return (
    invoice?.parent?.subscription_details?.metadata ??
    invoice?.subscription_details?.metadata ??
    {}
  );
}

export function getInvoiceSubscriptionId(invoice: AnyInvoice): string | null {
  const raw =
    invoice?.parent?.subscription_details?.subscription ?? invoice?.subscription ?? null;
  if (typeof raw === "string") return raw;
  return raw?.id ?? null;
}

export function isFirstSubscriptionInvoice(invoice: AnyInvoice): boolean {
  return invoice?.billing_reason === "subscription_create";
}
```

Run → PASS. Commit.

- [ ] **Step 6: `invoice.paid` handler.** In `src/app/api/webhook/stripe/route.ts` add the event case + handler:

```ts
case "invoice.paid":
  await handleInvoicePaid(event.data.object, accountSource);
  break;
case "customer.subscription.deleted":
  // No action needed: renewals simply stop arriving. Logged for visibility.
  console.log("[webhook] subscription deleted — recurring commission stops naturally");
  break;
```

```ts
async function handleInvoicePaid(invoice: AnyInvoice, accountSource: string) {
  if (isFirstSubscriptionInvoice(invoice)) return; // first payment is handled by checkout.session.completed

  const meta = getSubscriptionMetadata(invoice);
  const refCode = meta.ref_code ?? meta.refCode ?? null;
  if (!refCode) return;

  const invoiceId: string | null = invoice?.id ?? null;
  if (!invoiceId) return;
  const dup = await prisma.affiliateReferral.findUnique({ where: { stripeInvoiceId: invoiceId } });
  if (dup) return; // idempotent

  const affiliate = await prisma.affiliateUser.findUnique({ where: { refCode } });
  if (!affiliate || !affiliate.isActive) return;

  const customerEmail: string | null = invoice?.customer_email ?? null;
  if (customerEmail && customerEmail.toLowerCase() === affiliate.email.toLowerCase()) return; // self-referral

  const saleAmount = Math.round(invoice?.amount_paid ?? 0) / 100;
  if (saleAmount <= 0) return; // zero/proration-credit invoices earn nothing

  const product = await matchProduct(prisma, {
    priceId: null, // invoice line price extraction is version-fragile; slug is authoritative for studio
    productSlug: meta.product_id ?? (meta.plan && meta.period ? `hero-studio-${String(meta.plan).toLowerCase()}-${String(meta.period).toLowerCase()}` : null),
    brandSlug: meta.ha_brand ?? "hero-ai",
  });
  if (!product) return;

  const rate = getCommissionRate(product, affiliate.tier);
  const { commissionAmount } = calculateCommissionFromAmount(saleAmount, rate);

  await prisma.$transaction([
    prisma.affiliateReferral.create({
      data: {
        affiliateId: affiliate.id,
        productId: product.id,
        stripeInvoiceId: invoiceId,
        stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
        stripeCustomerEmail: customerEmail,
        saleAmount,
        commissionRate: rate,
        commissionAmount,
        isRenewal: true,
        status: "PENDING",
        holdingExpiresAt: new Date(Date.now() + HOLDING_PERIOD_MS),
      },
    }),
    prisma.affiliateUser.update({
      where: { id: affiliate.id },
      data: { pendingEarnings: { increment: commissionAmount } },
      // totalReferrals deliberately NOT incremented — renewals are not new customers
    }),
  ]);

  sendCommissionEmail(/* same args pattern as the checkout path */).catch(() => {});
}
```

(Adapt names/arg shapes to the real file; keep the always-return-200 convention and non-blocking emails.)

- [ ] **Step 7: Checkout path switches to actual amount.** In `handleCheckoutCompleted`, replace `calculateCommission(product, affiliate.tier)` with:

```ts
const rate = getCommissionRate(product, affiliate.tier);
const amountForCommission = saleAmount > 0 ? saleAmount : product.price; // fallback: catalog price
const { commissionAmount } = calculateCommissionFromAmount(amountForCommission, rate);
```

Also store `stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null` and `isRenewal: false` on the created referral. **Note:** this is a deliberate behavior improvement for คลังแสง too — a discounted checkout now pays commission on the discounted amount. Update any `tests/webhook.test.ts` expectation that assumed catalog-price commission, keep every other assertion.

- [ ] **Step 8: Refund matching gains invoice precision.** In `handleChargeRefunded`, BEFORE the existing email+amount fallback, try:

```ts
const chargeInvoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id ?? null;
if (chargeInvoiceId) {
  const byInvoice = await prisma.affiliateReferral.findUnique({ where: { stripeInvoiceId: chargeInvoiceId } });
  if (byInvoice && ["PENDING", "APPROVED"].includes(byInvoice.status)) {
    // run the same clawback transaction on this referral and return
  }
}
```

- [ ] **Step 9: Tier-count fix.** In `src/app/api/cron/tier-upgrade/route.ts`, add `isRenewal: false` to the referral count `where` (line ~36-46), so monthly renewals can't inflate tier progression. Add a comment: `// renewals are revenue events, not new customers — tiers count customers`.

- [ ] **Step 10: Full test pass.** `npx vitest run` → all suites green (185 existing ± the explicitly adjusted webhook expectations + new suites). `npm run build` → pass. Commit: `feat(recurring): invoice.paid commissions, amount-based commission, tier-count fix`.

- [ ] **Step 11 (manual, local, optional-if-time): live-shaped smoke.** With Stripe CLI: `stripe listen --forward-to localhost:3000/api/webhook/stripe` + `stripe trigger invoice.payment_succeeded` won't carry our metadata; instead craft a raw `invoice.paid` event JSON (metadata included) and sign with `stripe.webhooks.generateTestHeaderString`, POST to the local route with a test secret in `STRIPE_WEBHOOK_SECRET_HEROAI`, against a Neon dev-branch DB. Verify a referral row with `isRenewal: true` appears and re-POST is idempotent.

---

## Task 4: hero-affiliate — Hero AI products, links, CORS, display honesty

**Repo:** hero-affiliate · branch `feat/hero-studio-recurring` · **blocked by Task 3** (uses new schema + matchProduct semantics)

**Files:**
- Modify: `prisma/seed.ts`
- Create: `scripts/seed-hero-studio.ts` (prod-safe idempotent upsert — seed.ts full-reseed is NOT safe on prod)
- Modify: `src/app/api/clicks/route.ts:16-22` (CORS)
- Modify: `src/components/dashboard/ProductCard.tsx:37-45`, `src/app/(dashboard)/materials/page.tsx:21-25,100-102,163`, `src/components/dashboard/QuickShare.tsx:16`
- Modify: `src/app/api/products/route.ts:57` (ex-VAT display fix)

**Interfaces:**
- Consumes: product slugs + `matchProduct` from Task 3.
- Produces: 4 active `AffiliateProduct` rows + active `hero-ai` brand that Task 3's webhook matches at runtime; landing URLs used in affiliate dashboards.

- [ ] **Step 1: Prod-safe product upsert script** — `scripts/seed-hero-studio.ts` (run with `npx tsx`, uses same prisma bootstrap as `prisma/seed.ts`):

```ts
const PRODUCTS = [
  { slug: "hero-studio-pro-monthly",      name: "HERO AI Studio — PRO รายเดือน",      price: 599,  stripePriceId: process.env.PRICE_ID_PRO_MONTHLY  ?? "pending_pro_monthly" },
  { slug: "hero-studio-pro-annual",       name: "HERO AI Studio — PRO รายปี",         price: 5990, stripePriceId: process.env.PRICE_ID_PRO_ANNUAL   ?? "pending_pro_annual" },
  { slug: "hero-studio-business-monthly", name: "HERO AI Studio — BUSINESS รายเดือน", price: 990,  stripePriceId: process.env.PRICE_ID_BIZ_MONTHLY  ?? "pending_biz_monthly" },
  { slug: "hero-studio-business-annual",  name: "HERO AI Studio — BUSINESS รายปี",    price: 9900, stripePriceId: process.env.PRICE_ID_BIZ_ANNUAL   ?? "pending_biz_annual" },
];
// for each: upsert by slug; commissionBronze/Silver/Gold/Platinum ALL = 25; isRecurring: true; brand = hero-ai
// also: update brand hero-ai → isActive: true
// placeholders are fine: webhook matching for studio is slug-first (metadata.product_id); real price ids can be patched later via the same script + env vars
```

Write it fully (upserts + brand activation + console summary). Mirror the same 4 products + brand activation in `prisma/seed.ts` for fresh installs.

- [ ] **Step 2: CORS** — add `"https://studio.heroaiengine.com"` to `ALLOWED_ORIGINS` in `src/app/api/clicks/route.ts` (keep existing entries).

- [ ] **Step 3: Landing URLs** — in BOTH `ProductCard.tsx` and `materials/page.tsx` change `BRAND_URLS["hero-ai"]` from `https://app.heroaiengine.com/pricing` → **`https://studio.heroaiengine.com`** (the sale page is the root; `?ref=` must land there). In `QuickShare.tsx` add a second share row for HERO AI Studio using `https://studio.heroaiengine.com/?ref=${refCode}` labeled `HERO AI Studio`, keeping the คลังแสง row.

- [ ] **Step 4: Display honesty** — `src/app/api/products/route.ts:57` computes `commissionAmount` on VAT-inclusive price (inconsistent with what the webhook actually pays). Change to reuse `calculateCommissionFromAmount(product.price, rate).commissionAmount` so the dashboard promises what the webhook pays. Verify `products/page.tsx:114` renders the API value (adjust if it recomputes locally).

- [ ] **Step 5:** `npx vitest run` + `npm run build` → green. Commit: `feat(products): HERO AI Studio products, studio landing URLs, CORS, ex-VAT display`.

---

## Task 5: hero-affiliate — redesign `/` + `/affiliate-program` (violet house system)

**Repo:** hero-affiliate · branch `feat/hero-studio-recurring` · **blocked by Task 4** (uses final product data/URLs) · pure frontend, no API changes

**Files:**
- Rewrite: `src/app/page.tsx`
- Rewrite: `src/app/affiliate-program/page.tsx` (+ its `layout.tsx` metadata)
- Reference (read-only, for visual tokens): `/Users/mewsocialmacmini/projects/AI_content_Mew_social/src/app/page.tsx` and `src/components/marketing/*` in the studio repo — replicate the look locally; do NOT import across repos.

**Design tokens (from Studio house system):**
- Single accent **violet `#8b5cf6`** (gradients toward `#a78bfa` allowed; no second accent color)
- Headings font **Bai Jamjuree** (add via `next/font/google`, weights 500/600/700, `subsets: ["thai","latin"]`); body stays the existing sans
- Dark base like studio sale page (near-black `#0a0a12`–`#0f1117` range), soft violet radial glows, thin `white/10` card borders, rounded-2xl cards
- Buttons: primary = violet solid; secondary = outline `white/15`
- Motion: subtle fade/slide-in on scroll is fine with plain CSS/`framer`-free approach (do not add the `motion` dependency to this repo; use CSS transitions + `IntersectionObserver` or omit)
- Mobile-first responsive; all pages must look right at 390px and 1440px

**Copy — FINAL, use verbatim (Thai):**

`/` (home):
- H1: `เปลี่ยนผู้ติดตามให้เป็นรายได้ประจำ`
- Sub: `โปรแกรมพันธมิตรอย่างเป็นทางการของ A'O Group — แนะนำเครื่องมือที่คุณใช้จริง รับค่าคอมมิชชั่นเข้าบัญชีทุกเดือน`
- Product card 1 — `HERO AI Creator Studio` · badge `ใหม่ · Recurring 25%`: `แอปเปลี่ยนสคริปต์เป็นวิดีโอสั้นอัตโนมัติ — รับ 25% ของทุกยอดจ่าย ทุกเดือน ตลอดที่ลูกค้ายังใช้งาน (~฿140/เดือน ต่อลูกค้า PRO · สูงสุด ~฿2,313 ต่อดีลรายปี)`
- Product card 2 — `คลังแสง AI` · badge `One-time สูงสุด 25%`: `คอร์ส AI ขายดี ฿5,990 — ค่าคอมต่อดีล ฿840–1,400 ตามระดับ Tier`
- CTA primary: `สมัครเป็นพันธมิตร — ฟรี` → `/register` · secondary: `เข้าสู่ระบบ` → `/login` · text link: `ดูรายละเอียดโปรแกรม →` → `/affiliate-program`
- Footer: `© 2026 A'O Group · affiliate.heroaiengine.com` + links `เข้าสู่ระบบ / สมัคร / รายละเอียดโปรแกรม`

`/affiliate-program`:
1. **Hero** — badge `โปรแกรมพันธมิตร A'O Group`; H1 `แนะนำครั้งเดียว รับค่าคอมทุกเดือน`; sub `รับ 25% ของทุกยอดที่ลูกค้าจ่าย ทุกเดือน ตลอดอายุการใช้งาน — ไม่ใช่จ่ายครั้งเดียวจบ พร้อมสินค้า one-time ค่าคอมสูงถึง ฿1,400 ต่อดีล`; CTA `สมัครเป็นพันธมิตร — ฟรี` (→/register) + `เข้าสู่ระบบ` (→/login); trust line: `สมัครฟรี · อนุมัติอัตโนมัติ · จ่ายตรงทุกเดือน พร้อมเอกสารภาษีครบ`
2. **สินค้าและอัตราค่าคอม** — two cards:
   - HERO AI Studio (Recurring): table rows exactly — `PRO รายเดือน ฿599 → ~฿140/เดือน` · `BUSINESS รายเดือน ฿990 → ~฿231/เดือน` · `PRO รายปี ฿5,990 → ~฿1,400/ดีล` · `BUSINESS รายปี ฿9,900 → ~฿2,313/ดีล`; footnote `ลูกค้าต่ออายุเดือนไหน คุณได้ค่าคอมเดือนนั้น — อัตโนมัติ`
   - คลังแสง AI (One-time): `฿5,990 ต่อดีล → ค่าคอม ฿840 (Bronze 15%) ถึง ฿1,400 (Platinum 25%) ตามระดับของคุณ`
3. **เริ่มยังไง (4 ขั้น)** — `1. สมัครฟรี ได้ลิงก์ส่วนตัวทันที` · `2. แชร์ลิงก์ในคอนเทนต์ของคุณ` · `3. ระบบติดตามให้อัตโนมัติ — คุกกี้ 30 วัน + ผูกบัญชีถาวรตั้งแต่ลูกค้าสมัคร แม้ลูกค้าซื้อทีหลังหลายเดือนก็ยังนับ` · `4. รับเงินทุกเดือน — ยอดครบ ฿500 โอนตรงเข้าบัญชี พร้อมหนังสือรับรองหักภาษี (50 ทวิ)`
4. **ทำไมรายได้แบบ Recurring ถึงต่างจากที่อื่น** — headline `ทำครั้งเดียว รายได้โตขึ้นทุกเดือน`; body `ค่าคอมแบบครั้งเดียวจบ ต้องหาลูกค้าใหม่ตลอด แต่ค่าคอมแบบ recurring สะสมขึ้นเรื่อย ๆ: มีลูกค้า PRO active 10 คน = ~฿1,400 เข้าทุกเดือน = ~฿16,800 ต่อปี โดยไม่ต้องขายเพิ่มอีกดีลเดียว`
5. **Income Calculator (interactive)** — tabs `HERO AI Studio` / `คลังแสง AI`:
   - Studio tab: plan toggle (`PRO` default / `BUSINESS`) + slider `จำนวนลูกค้า active` 1–100 (default 10) → outputs `รายได้ต่อเดือน = N × ฿139.95 (หรือ 231.31)` shown rounded to whole baht, and `ต่อปี = ×12`; caption `คิดจากยอดหลังหัก VAT · อัตรา 25% ทุกระดับ`
   - คลังแสง tab: keep the existing tier-based logic (slider ดีล 1–50, tier auto from breakpoints 0/5/15/30, per-deal `round(5990/1.07 × rate)`), restyled to match
6. **กติกาที่ควรรู้ (โปร่งใสตรงไปตรงมา)** — bullet list verbatim: `ค่าคอมคิดจากยอดที่ลูกค้าจ่ายจริง หลังหักส่วนลดและ VAT 7%` · `ยอดใหม่ทุกยอดมีระยะรอ 30 วัน (กันการคืนเงิน) แล้วเปลี่ยนเป็นพร้อมจ่ายอัตโนมัติ` · `จ่ายเมื่อยอดสะสมถึง ฿500 — โอนตรง PromptPay/บัญชีธนาคาร หักภาษี ณ ที่จ่าย 3% พร้อม 50 ทวิ` · `ห้ามซื้อผ่านลิงก์ตัวเอง และห้ามประมูลคีย์เวิร์ดชื่อแบรนด์ (brand bidding)` · `ลูกค้ายกเลิกเมื่อไหร่ ค่าคอมงวดถัดไปหยุดเมื่อนั้น — งวดที่จ่ายมาแล้วยังเป็นของคุณ`
7. **FAQ (Accordion, 6 ข้อ)** — verbatim Q/A:
   - `สมัครต้องเสียเงินไหม ต้องมียอดขั้นต่ำไหม` → `ฟรี ไม่มีเงื่อนไข อนุมัติอัตโนมัติ สมัครเสร็จได้ลิงก์ทันที`
   - `ลูกค้ากดลิงก์วันนี้ แต่ไปซื้ออีก 2 เดือนข้างหน้า ยังนับไหม` → `นับ — ถ้าลูกค้าสมัครบัญชีผ่านลิงก์ของคุณ ระบบผูกบัญชีนั้นกับคุณถาวร ซื้อเมื่อไหร่ก็นับ (ถ้ายังไม่สมัคร ใช้คุกกี้ 30 วันแบบ last-click)`
   - `รายได้ recurring คืออะไร ต่างจากค่าคอมปกติยังไง` → `ลูกค้าจ่ายรายเดือน/รายปีเมื่อไหร่ คุณได้ 25% ของยอดนั้นทุกครั้ง ไม่ใช่แค่ครั้งแรก — ตราบใดที่ลูกค้ายังใช้งานอยู่`
   - `ได้เงินเมื่อไหร่ ยังไง` → `ทุกยอดมีระยะรอ 30 วัน จากนั้นเข้ายอดพร้อมจ่าย เมื่อครบ ฿500 ทีมงานโอนให้ทุกเดือน หักภาษี ณ ที่จ่าย 3% พร้อมออก 50 ทวิให้`
   - `ต้องเตรียมเอกสารอะไรบ้าง` → `เลขบัตรประชาชนและบัญชีธนาคาร/พร้อมเพย์ สำหรับการโอนและออกเอกสารภาษี — กรอกในหน้าตั้งค่าหลังสมัคร`
   - `โปรโมทช่องทางไหนได้บ้าง` → `ได้ทุกช่องทางของคุณ: TikTok, YouTube, Facebook, กลุ่ม, บล็อก ฯลฯ ยกเว้นการยิงแอดประมูลชื่อแบรนด์ (brand bidding) และการสแปม`
8. **Final CTA** — H2 `พร้อมเปลี่ยนคอนเทนต์ของคุณเป็นรายได้ประจำหรือยัง`; button `สมัครเป็นพันธมิตร — ฟรี` (→/register); subline `ใช้เวลาสมัครไม่ถึง 2 นาที`
9. Footer same as `/`.

- [ ] **Step 1:** Rewrite `/` per copy + tokens above (server component, static — keep current pattern; only `Button` + `next/link` needed).
- [ ] **Step 2:** Rewrite `/affiliate-program` per sections above (`"use client"` stays because of the calculator; keep `Accordion`, `Slider`, `Card`, `Button` from `@/components/ui/*`). Update `layout.tsx` OG title/description to `โปรแกรมพันธมิตร HERO AI & คลังแสง — ค่าคอม 25% ทุกเดือน`.
- [ ] **Step 3:** Verify calculator numbers against the canonical table (PRO 10 คน = ฿1,400/เดือน rounded from 1,399.5). `npm run build` + `npx vitest run` green. Visual check at 390px/1440px (screenshots).
- [ ] **Step 4:** Commit: `feat(landing): violet redesign of / and /affiliate-program with HERO AI Studio recurring`.

---

## Task 6: Launch ops (Mew + session — NOT a subagent task)

Ordered checklist; run after Tasks 1–5 pass review and PRs merge:

- [ ] **6.1** hero-affiliate: merge PR → Vercel auto-deploys. Run `npx prisma migrate deploy` against prod Neon. Run `npx tsx scripts/seed-hero-studio.ts` with prod `DATABASE_URL` (+ real `PRICE_ID_*` env values if available from Studio SiteConfig — otherwise placeholders are safe because studio matching is slug-first).
- [ ] **6.2** Stripe Dashboard (**Studio's Stripe account**): add webhook endpoint `https://affiliate.heroaiengine.com/api/webhook/stripe` with events `checkout.session.completed`, `charge.refunded`, `invoice.paid`, `customer.subscription.deleted` → copy signing secret → set `STRIPE_WEBHOOK_SECRET_HEROAI` in Vercel env → redeploy affiliate app.
- [ ] **6.3** Studio: merge PR → on VPS `bash deploy/deploy.sh` (schema column arrives via `prisma db push` in the script). Use the standard low-heap env; run detached (nohup) per runbook.
- [ ] **6.4** Live smoke (acceptance criteria 1–3): open `https://studio.heroaiengine.com/?ref=<real-test-affiliate-code>` in a fresh browser → check click row in affiliate admin + `aff_ref` cookie; register a throwaway account → check `affiliateRefCode` stamped in Studio DB; if feasible, make one real small payment → referral PENDING appears at 25% of ex-VAT paid amount.
- [ ] **6.5** Renewal verification (acceptance criterion 4) is **time-gated**: confirm at the first real renewal cycle (≤31 days). Interim confidence = unit tests + (optional) local signed-event smoke from Task 3 Step 11. Set a reminder to check the first `invoice.paid` arrival in Vercel logs / referral table.
- [ ] **6.6** On VPS inside `/var/www/ai-content`: `npx tsx scripts/publish-affiliate-update.ts` (pinned /updates post).
- [ ] **6.7** Update memory/STATUS docs; record real Stripe price IDs into affiliate products when convenient.

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Studio ref capture + stamp + checkout metadata + links | mew-worker-heavy | subagent | — | build + verify script, code review, **security-review** (auth/payment path) |
| 2 | Studio /updates post script | mew-worker | subagent | 1 (same branch) | dry-run evidence, code review |
| 3 | Affiliate recurring webhook + amount commission + tier fix | mew-worker-heavy | subagent | — | vitest full pass, code review, **security-review** (webhook input) |
| 4 | Affiliate products/CORS/links/display | mew-worker | subagent | 3 | vitest + build, code review |
| 5 | Affiliate landing redesign | mew-worker | subagent | 4 | build + visual screenshots vs copy brief, code review |
| 6 | Launch ops checklist | (session + Mew) | inline | 1–5 | acceptance criteria walkthrough |

Parallel frontier at start: **Task 1 and Task 3** (different repos). Task 2 follows 1; Tasks 4→5 follow 3 sequentially on the same branch.

## Acceptance Criteria (locked with Mew 2026-07-12)

- [ ] 1. Click `?ref=` link on Studio → click record in affiliate dashboard + `aff_ref` cookie set
- [ ] 2. New registration via link → refCode stamped in Studio DB
- [ ] 3. Plan payment (monthly / annual / one-time annual) → PENDING commission = 25% of ex-VAT actual paid, correct incl. Founding
- [ ] 4. Automatic renewal invoice → new commission row created automatically (time-gated: first real cycle)
- [ ] 5. Cancel → no further commission · refund → clawback works
- [ ] 6. Credit-pack purchase → NO commission
- [ ] 7. New `/` + `/affiliate-program` live, all numbers match locked policy
- [ ] 8. Studio links (footer + account menu) work
- [ ] 9. Builds pass; affiliate 185-test suite green (+ new recurring tests)

## Out of scope (deliberate)

- In-app affiliate stats page inside Studio (Phase-later; needs cross-system API)
- Admin UI for managing affiliate products (seed script is the tool)
- Commission on credit packs / manual payments
- External recruiting content (posts/ads) — Mew handles separately
- Dashboard/admin redesign of the affiliate site
- 50 ทวิ PDF auto-generation, leaderboard (existing M4 backlog)

## Status

interviewed 2026-07-12 | approved: 2026-07-12 | executed: 2026-07-12 (Tasks 1-5, all review gates) | delivered: **2026-07-12 LIVE ON PROD** (launch ops 6.1-6.4 + 6.6 done same day)

- Studio: PR #182 (Tasks 1-2) + #183 (post copy) + #184 (sidebar menu — plan's account-menu.tsx is editor-shell-only; dashboard uses sidebar.tsx) + #185 (Affiliate wording + v1.2.2 post version) — all merged + VPS-deployed
- hero-affiliate: PR #1 (Tasks 3-5, 216/216 tests) + PR #2 (landing Affiliate wording) — merged, Vercel-deployed; prod Neon migrated + 4 products seeded; Stripe webhook + STRIPE_WEBHOOK_SECRET_HEROAI live
- Wording decision (Mew, post-launch): user-facing term everywhere = **"Affiliate"** (สมัครทำ Affiliate), not โปรแกรมพันธมิตร
- Smoke passed: aff_ref cookie (middleware path) + click record 200 w/ correct CORS for XXX1093; /updates post live as v1.2.2 with system-updates roundup
- Time-gated remainder: renewal `invoice.paid` verify ≤31d (6.5) · stamp verify with first real referred signup · real Stripe price IDs (6.7)
- Fast-follows (non-blocking, recorded in PR #1): gate invoice handler's `ha_brand ?? "hero-ai"` default to account source · label คลังแสง QuickShare row · regression tests for unchanged clawback branches in refund.ts
