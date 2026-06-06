# Pricing Redesign × Founding-100 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the richer redesigned `/pricing` page as the in-app pricing page, with Founding-100 (live seat counter + founding price) fully working.

**Architecture:** Use the backed-up 707-line redesign as the page base; extract the founding/coupon price rule into a pure, unit-verified helper; graft the four founding integration points + dynamic sticky bar into the redesign. No API/checkout/schema changes (founding backend already live on `main`).

**Tech Stack:** Next.js 15 (App Router, client component), React 19, TypeScript, Tailwind v4, lucide-react, `tsx` verify scripts (no test runner).

**Spec:** `docs/superpowers/specs/2026-06-06-pricing-redesign-founding-design.md`

**Source artifacts:**
- Redesign baseline (uncommitted backup): `C:\Users\MewSocial\creator studio\pricing-redesign-707.tsx.bak`
- Reference founding logic: `origin/main:src/app/(dashboard)/pricing/page.tsx`

> All commit messages end with the trailer:
> `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Branch setup + commit spec & plan

**Files:** (no source code — git + docs only)
- Docs already on disk (untracked): the spec + this plan.

- [ ] **Step 1: Confirm the redesign backup exists before any git op**

Run: `Test-Path "C:\Users\MewSocial\creator studio\pricing-redesign-707.tsx.bak"`
Expected: `True` (707-line redesign is safe outside the repo). Do NOT proceed if False — re-create it from the `mew/coupon-discount` working tree first.

- [ ] **Step 2: Discard the working-tree redesign change (it is backed up) so branches can switch cleanly**

```bash
cd "C:\Users\MewSocial\creator studio\AI_content_Mew_social"
git checkout -- "src/app/(dashboard)/pricing/page.tsx"
git status -sb
```
Expected: pricing page no longer shows as modified. Untracked `image.png` + `docs/superpowers/{specs,plans}/2026-06-06-pricing-redesign-founding*` remain (that's fine — untracked files carry across checkout).

- [ ] **Step 3: Fast-forward local `main` to `origin/main`, branch off it**

```bash
git checkout main
git merge --ff-only origin/main
git checkout -b mew/pricing-redesign
git status -sb
```
Expected: on `mew/pricing-redesign`, based on latest `origin/main` (founding + coupon + trial present). The two untracked docs still present.

- [ ] **Step 4: Commit the spec and plan**

```bash
git add "docs/superpowers/specs/2026-06-06-pricing-redesign-founding-design.md" "docs/superpowers/plans/2026-06-06-pricing-redesign-founding.md"
git commit -m "docs(pricing): spec + plan for redesign × founding-100 merge" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: one commit with the two docs. `git status` clean except untracked `image.png`.

---

### Task 2: Pure pricing-display helper (TDD via tsx verify)

**Files:**
- Create: `src/lib/pricing-display.ts`
- Create (test): `scripts/verify-pricing-display.ts`

- [ ] **Step 1: Write the failing verification script**

Create `scripts/verify-pricing-display.ts`:
```ts
import { computeDisplayPrice } from "../src/lib/pricing-display";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`);
  }
}

// 1) Monthly, no discount
check("monthly / none",
  computeDisplayPrice({ monthlyPrice: 599, period: "monthly", coupon: null, founding: null }),
  { base: 599, final: 599, pct: 0, isFounding: false });

// 2) Annual, no discount
check("annual / none",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: null, founding: null }),
  { base: 5990, final: 5990, pct: 0, isFounding: false });

// 3) Annual + founding 50% -> ฿2,995 (matches the live integration check)
check("annual / founding 50%",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: null, founding: { active: true, percentOff: 50 } }),
  { base: 5990, final: 2995, pct: 50, isFounding: true });

// 4) Monthly + founding active -> founding does NOT apply (annual-only)
check("monthly / founding ignored",
  computeDisplayPrice({ monthlyPrice: 599, period: "monthly", coupon: null, founding: { active: true, percentOff: 50 } }),
  { base: 599, final: 599, pct: 0, isFounding: false });

// 5) Annual + coupon 20%, no founding
check("annual / coupon 20%",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: { percentOff: 20 }, founding: null }),
  { base: 5990, final: 4792, pct: 20, isFounding: false });

// 6) Coupon beats founding (both present)
check("annual / coupon beats founding",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: { percentOff: 20 }, founding: { active: true, percentOff: 50 } }),
  { base: 5990, final: 4792, pct: 20, isFounding: false });

// 7) Founding sold out / inactive
check("annual / founding inactive",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: null, founding: { active: false, percentOff: 50 } }),
  { base: 5990, final: 5990, pct: 0, isFounding: false });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll pricing-display checks passed");
```

- [ ] **Step 2: Run it to confirm it fails (module not found)**

Run: `npx tsx scripts/verify-pricing-display.ts`
Expected: FAIL — cannot find module `../src/lib/pricing-display`.

- [ ] **Step 3: Write the helper**

Create `src/lib/pricing-display.ts`:
```ts
// Pure pricing-display calculator shared by the /pricing page.
// Precedence rule (mirrors origin/main pricing page):
//   a manual coupon always wins; the Founding-100 price applies on ANNUAL only.

export interface DisplayPriceInput {
  /** Monthly list price for the plan (THB). */
  monthlyPrice: number;
  period: "monthly" | "annual";
  /** Applied manual coupon, or null. percentOff may be null for non-percent coupons. */
  coupon: { percentOff: number | null } | null;
  /** Founding-100 status, or null when unknown/unavailable. */
  founding: { active: boolean; percentOff: number } | null;
}

export interface DisplayPrice {
  /** Pre-discount price for the selected period (THB). */
  base: number;
  /** Final price after any discount (THB, rounded). */
  final: number;
  /** Percent off applied (0 when none). */
  pct: number;
  /** True when the founding price (not a manual coupon) is what's applied. */
  isFounding: boolean;
}

export function computeDisplayPrice(input: DisplayPriceInput): DisplayPrice {
  const { monthlyPrice, period, coupon, founding } = input;
  const base = period === "annual" ? monthlyPrice * 10 : monthlyPrice;
  const foundingPct =
    !coupon && founding?.active && period === "annual" ? founding.percentOff : 0;
  const pct = coupon?.percentOff ?? foundingPct;
  const isFounding = !coupon && foundingPct > 0;
  const final = pct > 0 ? Math.round(base * (1 - pct / 100)) : base;
  return { base, final, pct, isFounding };
}
```

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `npx tsx scripts/verify-pricing-display.ts`
Expected: 9 PASS lines + "All pricing-display checks passed".

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricing-display.ts scripts/verify-pricing-display.ts
git commit -m "feat(pricing): pure display-price helper (coupon/founding precedence) + tsx verify" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Merge redesign + founding into the pricing page

**Files:**
- Replace: `src/app/(dashboard)/pricing/page.tsx` (restore redesign, then apply 6 edits)

- [ ] **Step 1: Restore the redesign baseline into the page**

```bash
Copy-Item "C:\Users\MewSocial\creator studio\pricing-redesign-707.tsx.bak" "src/app/(dashboard)/pricing/page.tsx" -Force
```
Expected: `git diff --stat` shows the pricing page heavily changed (redesign vs main's 438-line version). At this point founding is NOT yet wired — the next edits add it.

- [ ] **Step 2: Edit imports — add `Flame` icon and the helper**

In the `lucide-react` import block, add `Flame,` (alphabetical, after `Film,`). Then add the helper import after the `CouponBox` import line.

Find:
```tsx
  Film,
  Gift,
```
Replace with:
```tsx
  Film,
  Flame,
  Gift,
```

Find:
```tsx
import { CouponBox } from "@/components/settings/coupon-box";
```
Replace with:
```tsx
import { CouponBox } from "@/components/settings/coupon-box";
import { computeDisplayPrice } from "@/lib/pricing-display";
```

- [ ] **Step 3: Add founding state**

Find:
```tsx
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentOff: number | null } | null>(null);
  const [currentPlan, setCurrentPlan] = useState<string>("FREE");
```
Replace with:
```tsx
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentOff: number | null } | null>(null);
  const [founding, setFounding] = useState<{ active: boolean; remaining: number; total: number; percentOff: number } | null>(null);
  const [currentPlan, setCurrentPlan] = useState<string>("FREE");
```

- [ ] **Step 4: Fetch founding status on mount**

Find:
```tsx
    fetch("/api/user/me").then((r) => r.json()).then((d) => {
      if (d.plan) setCurrentPlan(d.plan);
    }).catch(() => {});
  }, []);
```
Replace with:
```tsx
    fetch("/api/user/me").then((r) => r.json()).then((d) => {
      if (d.plan) setCurrentPlan(d.plan);
    }).catch(() => {});
    fetch("/api/founding/status").then((r) => r.json()).then(setFounding).catch(() => {});
  }, []);
```

- [ ] **Step 5: Route the price calc through the helper (founding-aware)**

Find:
```tsx
  function getDisplayPrice(baseMonthlyPrice: number) {
    const base = period === "annual" ? baseMonthlyPrice * 10 : baseMonthlyPrice;
    const pct = appliedCoupon?.percentOff ?? 0;
    const final = pct > 0 ? Math.round(base * (1 - pct / 100)) : base;
    return { base, final, pct };
  }
```
Replace with:
```tsx
  function getDisplayPrice(baseMonthlyPrice: number) {
    return computeDisplayPrice({
      monthlyPrice: baseMonthlyPrice,
      period,
      coupon: appliedCoupon,
      founding,
    });
  }
```

- [ ] **Step 6: Founding-aware discount badge on plan cards**

Find:
```tsx
                          {display && display.pct > 0 && (
                            <>
                              <span className="text-white/36 line-through">฿{display.base.toLocaleString()}</span>
                              <span className="rounded-full bg-emerald-400/12 px-2 py-1 font-bold text-emerald-300">
                                ลด {display.pct}%
                              </span>
                            </>
                          )}
```
Replace with:
```tsx
                          {display && display.pct > 0 && (
                            <>
                              <span className="text-white/36 line-through">฿{display.base.toLocaleString()}</span>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-1 font-bold",
                                  display.isFounding ? "bg-amber-400/14 text-amber-300" : "bg-emerald-400/12 text-emerald-300",
                                )}
                              >
                                {display.isFounding ? `Founding · ลด ${display.pct}% ตลอดชีพ` : `ลด ${display.pct}%`}
                              </span>
                            </>
                          )}
```

- [ ] **Step 7: Make the sticky bar show live founding seats**

Find:
```tsx
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 px-4 py-3 text-center md:px-6">
          <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold tracking-[0.18em] text-cyan-200 uppercase">
            Founding Offer
          </span>
          <p className="text-sm text-white/70">รายปีมีทั้งแบบบัตรต่ออัตโนมัติ และ PromptPay จ่ายครั้งเดียว</p>
          <a
            href="#pricing"
            className="inline-flex items-center gap-2 rounded-full bg-linear-to-r from-cyan-400 to-violet-500 px-4 py-2 text-xs font-bold text-slate-950 transition-transform hover:-translate-y-0.5"
          >
            ดูราคา
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </a>
        </div>
```
Replace with:
```tsx
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 px-4 py-3 text-center md:px-6">
          {founding?.active && !appliedCoupon ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-[11px] font-bold tracking-[0.14em] text-amber-200 uppercase">
                <Flame className="h-3.5 w-3.5" strokeWidth={2.5} />
                Founding
              </span>
              <p className="text-sm text-white/80">
                ราคา Founding ลด {founding.percentOff}% ล็อกตลอดชีพ — เหลืออีก{" "}
                <span className="font-black text-white">{founding.remaining}</span>/{founding.total} ที่นั่ง
              </p>
            </>
          ) : (
            <>
              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold tracking-[0.18em] text-cyan-200 uppercase">
                Founding Offer
              </span>
              <p className="text-sm text-white/70">รายปีมีทั้งแบบบัตรต่ออัตโนมัติ และ PromptPay จ่ายครั้งเดียว</p>
            </>
          )}
          <a
            href="#pricing"
            className="inline-flex items-center gap-2 rounded-full bg-linear-to-r from-cyan-400 to-violet-500 px-4 py-2 text-xs font-bold text-slate-950 transition-transform hover:-translate-y-0.5"
          >
            ดูราคา
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </a>
        </div>
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If `display` typing complains, confirm `getDisplayPrice` returns the `DisplayPrice` shape and `display` is `price > 0 ? getDisplayPrice(price) : null`.)

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)/pricing/page.tsx"
git commit -m "feat(pricing): redesigned /pricing with live founding-100 (seat bar + founding price)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Build + local E2E verification

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: build succeeds (Next compiles, `prisma generate` runs). No type/lint-blocking errors on the pricing route.

- [ ] **Step 2: Start local dev on the correct port**

Run: `npx next dev -p 3005`
(Reminder: `:3000` is a different project. Local `.env` has Stripe TEST keys + Clerk test keys.)

- [ ] **Step 3: Manual E2E checklist on `http://localhost:3005/pricing`**

Verify each:
  - Period toggle monthly/annual works; choosing monthly resets method to card.
  - Payment-method toggle (card/PromptPay) shows on annual only.
  - With founding active: sticky bar shows "🔥 ... เหลืออีก N/100 ที่นั่ง"; annual cards show founding price + amber "Founding · ลด X% ตลอดชีพ" badge; ฿2,995 on a ฿599/mo plan.
  - Monthly: no founding price (annual-only).
  - Apply a DISCOUNT coupon → coupon price wins; founding bar reverts to generic text; badge turns emerald "ลด X%". Remove coupon → founding returns.
  - `?payment=success` and `?payment=cancelled` banners render.
  - Click "อัปเกรดเป็น Pro" → redirects to Stripe checkout (test mode).
  - Current plan shows "Active" / "แผนปัจจุบันของคุณ".

- [ ] **Step 4: Report results**

Summarize pass/fail per checklist item. If all pass, the feature is ready for PR (coordinate deploy timing + `prisma db push` runbook with wao1234 — but note: this change adds NO schema columns, so no db push needed for this PR specifically).

---

## Self-Review

**Spec coverage:**
- Branch off main → Task 1. ✅
- Helper + verify → Task 2. ✅
- 4 founding integration points (state, fetch, price rule, badge) → Task 3 steps 3–6. ✅
- Dynamic sticky bar → Task 3 step 7. ✅
- No API/checkout/schema changes → no such task (correct; out of scope). ✅
- Must-not-regress items → Task 4 step 3 checklist. ✅
- Edge cases (status fail/sold-out/coupon-wins/monthly) → Task 2 cases 4,6,7 + Task 4 checklist. ✅
- Out of scope (sale page, color refactor) → not in plan. ✅

**Placeholder scan:** none — all steps carry exact code/commands.

**Type consistency:** `computeDisplayPrice` returns `{ base, final, pct, isFounding }`; page consumes `display.base/final/pct/isFounding`. `founding` state shape `{active,remaining,total,percentOff}` is structurally compatible with the helper's `{active,percentOff}` input. `appliedCoupon` `{code,percentOff}` compatible with helper's `{percentOff}` input. ✅
