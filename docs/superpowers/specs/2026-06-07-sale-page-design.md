# Spec — Evergreen sale page (replace homepage `/`)

- **Date:** 2026-06-07
- **Owner:** Mew (Payment/pricing vertical)
- **Status:** Design approved — pending spec review

## Problem / context

A richer "landing-page" mockup exists at `creator studio/sale-page-mockup.html` (founding bar, hero, bento, features, how-it-works, social proof, pricing, FAQ, CTA). The current homepage `src/app/page.tsx` is already a public marketing landing (server component, live plan prices from `SiteConfig`, CTAs → `/register`) but uses an older/simpler design with none of the mockup's polish.

**Goal:** replace the homepage `/` with the mockup design as the **evergreen sale page**, porting it faithfully to Next/React/Tailwind, wired to live data, shipping only real (non-placeholder) content.

**Decided in brainstorming:**
- Placement: **replace `/`** (homepage = evergreen sale page). No new route, no duplicate surface. `/pricing` (in-app, just redesigned) stays as the post-click/logged-in pricing surface.
- Founding bar: **live, but hide the whole bar when founding is inactive / sold out / unavailable** — never show a fabricated count.
- Placeholder content (social-proof metrics, marquee of handles, demo video, "100+ creators"): **cut for v1**, add later when real assets exist. No `[placeholder]` text ships.

## Approach (chosen)

**Server component page + one client island.** `page.tsx` stays a server component (good SEO for a marketing page; matches the existing pattern), fetches plan prices and founding status server-side, and renders all sections. Only the pricing monthly/yearly toggle needs client state → a single `PricingToggle` client island. (Rejected: fully-client page = worse SEO/perf; static HTML asset = no live data / no integration.)

## Design

### Route & file
- Replace `src/app/page.tsx` (the old homepage design is discarded; recoverable from git history).
- The page lives at the app root (NOT in the `(dashboard)` group) → renders with only the root layout, no sidebar. Confirmed standalone.
- `export const metadata` on the page for SEO (title, description, Open Graph) — overrides the generic root metadata.
- Optional perf: `export const revalidate = 60` (ISR) — a marketing page tolerates a 60s-stale plan price / founding count and it cuts DB load. (If unset, the page is dynamic per-request, also fine.)

### Data sources (server-side)
1. **Plan prices** — reuse the existing `getPlanConfig()` logic from the current `page.tsx` (reads `SiteConfig` keys `plan_pro_price`/`plan_pro_features`/`plan_business_price`/`plan_business_features`, with hardcoded DEFAULTS fallback). Keep it.
2. **Founding status** — read-only, via the existing `getFoundingCoupon()` from `src/lib/founding.ts`:
   - `const c = await getFoundingCoupon().catch(() => null)`
   - derive `founding = c ? { active: (c.maxUses - c.usedCount) > 0, remaining: Math.max(0, c.maxUses - c.usedCount), total: c.maxUses, percentOff: c.percentOff } : null`
   - **Do NOT call `foundingStatus()`** — it runs `releaseStaleReservations()` which WRITES to the DB and queries `FoundingReservation` (a table that may not exist pre-db-push). `getFoundingCoupon()` only reads the `Coupon` table → safe, write-free, works in every state. The cron + `/pricing` still own seat self-healing.

### Founding bar (server-rendered, conditional)
- Rendered directly in `page.tsx` only when `founding?.active`. Otherwise the bar is omitted entirely (no fake count, no empty bar).
- Content when shown: brand mark + "🔥 ราคาผู้ก่อตั้ง 100 คนแรก" + progress bar (`width = (usedCount/total)%` → i.e. `((total-remaining)/total)*100`) + "เหลือ {remaining}/{total}" + CTA "รับสิทธิ์" → `/register`.
- No client JS needed; it's static markup driven by the server value.

### Sections (in order — mockup, real content only)
1. **Founding bar** (server, conditional — above).
2. **Hero** — chip "✨ สำหรับสาย Faceless & คนทำคอนเทนต์", headline "มีแค่ สคริปต์ 1 ชุด → ได้คลิปพร้อมโพสต์ อัตโนมัติ", sub, CTA buttons: primary "เริ่มใช้ฟรี" → `/register`, secondary "เข้าสู่ระบบ" → `/login`. **No** demo-video frame, **no** "100+ creators" avatars row.
3. **What it does** — feature tiles (ซับไทยอัตโนมัติ, B-roll 3–5 วิ, มี/ไม่มี Avatar). Drop the mockup's big demo-video tile; rebalance the grid to the real tiles.
4. **Feature grid** (6) — AI Avatar, โคลนเสียงตัวเอง, เพลง+เสียง effect, B-roll, ซับไทย 2 สไตล์, พร้อมโพสต์.
5. **How it works** (3 steps) — วางสคริปต์ → เลือกสไตล์ → กดสร้าง.
6. **Pricing** (`PricingToggle` client island) — FREE / PRO / BUSINESS tiers; monthly/yearly toggle; prices from `getPlanConfig` (passed as props); yearly shows the honest "ประหยัด 2 เดือน" framing (yearly = monthly×10; optional strikethrough of monthly×12). Tier CTAs → `/register`. Payment-method chips (PromptPay / บัตร / คืนเงิน 7 วัน / จ่ายครั้งเดียวไม่ตัดอัตโนมัติ). **No founding price math here** — founding lives in the bar and is realized on `/pricing` after login.
7. **FAQ** (4) — annual one-time payment, ease of use, payment methods, refund.
8. **Final CTA** + footer — headline + "เริ่มใช้ฟรี" → `/register`. Founding line ("เหลือ N/100") shown only when `founding?.active` (reuse the server value); otherwise a generic line.

### Cut from the mockup (v1)
Social-proof metrics (90% / ~10 นาที / 100+), the `@handle` marquee, the "⚠️ team will add real content" note, the hero + bento demo-video placeholders, the "100+ creators" avatars row. (Add back when real assets exist — future spec.)

### Components & files
- `src/app/page.tsx` — server component (replaced). Holds section markup + data fetch; section data (FEATURES, STEPS, FAQS) as module consts (like the current file).
- `src/components/marketing/pricing-toggle.tsx` — `"use client"` island: monthly/yearly state + renders the 3 tiers from `{ pro, business }` price props. Single responsibility (pricing display + toggle).
- (Founding bar + all other sections are server-rendered inline in `page.tsx`. If `page.tsx` grows unwieldy, extract section components, but inline is acceptable for a landing page.)
- **Fonts:** Bai Jamjuree + IBM Plex Sans Thai are ALREADY loaded by the root layout's Google Fonts `<link>` — just apply (`font-family: 'Bai Jamjuree'` for headings, `'IBM Plex Sans Thai'` for body) via a wrapper style / classes. No new font setup.
- **Styling:** port the mockup's aesthetic (aurora orbs, glass cards, gradient text, founding/brand gradients) using Tailwind classes + inline styles for gradients/aurora (the current `page.tsx` already uses inline-style glows — same approach). Honor `prefers-reduced-motion` for the aurora.

### CTAs
All conversion CTAs → `/register` (public, logged-out audience). Secondary → `/login`. Founding "รับสิทธิ์" → `/register` (the actual founding claim happens on `/pricing` post-signup/login).

## Edge cases
- `getFoundingCoupon()` returns null / throws → `founding = null` → founding bar omitted, final-CTA uses generic line. Page renders fully.
- `getPlanConfig()` DB failure → existing try/catch returns DEFAULTS. Keep.
- Logged-in visitor hitting `/` → existing middleware already redirects to `/dashboard` (unchanged).

## Verification
- `npx tsc --noEmit` + `npm run build` (route `/` compiles; it's a server component with a client island).
- Local E2E (`npx next dev -p 3005`, **logged-out** — the real audience): page renders all sections; founding bar hidden when founding inactive locally; pricing monthly/yearly toggle switches prices; all CTAs navigate to `/register` (or `/login`); no console errors; mobile-responsive (mockup breakpoints at 820px).
- No pure-logic unit needed (page is presentational); if the yearly-savings calc is extracted, a tiny `tsx` check is optional.

## Out of scope (YAGNI)
- Scroll-reveal (IntersectionObserver) animation — optional polish for later.
- Founding price math on the homepage tiers (founding only in the bar + on `/pricing`).
- Testimonials / real metrics / demo video / `@handle` marquee (need real assets).
- A separate `/launch` founding campaign page (possible future spec).
- Any change to `/pricing`, founding backend, schema, or middleware.

## Risks
- Visual fidelity to the mockup in Tailwind vs hand-CSS — mitigated by porting the mockup's exact palette/gradients via inline styles where Tailwind is awkward (aurora, gradient text).
- `revalidate` staleness on founding count — 60s is acceptable for a bar; if exactness matters, leave the page dynamic (no revalidate).
