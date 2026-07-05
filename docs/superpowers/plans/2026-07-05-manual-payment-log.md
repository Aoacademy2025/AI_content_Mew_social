# Manual / External Payment Log — Implementation Plan

> **For agentic workers:** ONE branch `mew/manual-payment-2026-07-05` off current `main`. Payments feature → security-sensitive: validate every input, admin-only, transactional. Build backend then frontend. Build-verify + a verify script. Read the actual current files before editing (locate by content, not line numbers).

**Goal:** Let an admin record off-Stripe (bank-transfer/external) payments so they count everywhere the cohort engine already reads — จ่ายจริง / MRR / cash-in / break-even — without manual DB inserts. Owner-approved shape: **bundled** (one form records the Payment + optionally grants plan/expiry + optionally marks founder) with a **list + void**.

**Why:** `revenue-cohorts.ts` anchors "paying" on `Payment status="PAID"`; off-Stripe payers have no Payment row → invisible. (This session, `taononchannel` was recorded via a raw DB insert — this feature replaces that.)

**Tech Stack:** Next.js 15 App Router, Prisma 6 + SQLite. Admin auth via `getCurrentUser()` + `role==="ADMIN"` (see any `src/app/api/admin/*/route.ts`). Founder counter via `src/lib/founding.ts` (atomic seat counter, coupon `FOUNDING100`). Cohorts read `Payment status="PAID"`.

## Global Constraints
- **Admin-only.** Every route: `const u = await getCurrentUser(); if (!u) 401; if (u.role !== "ADMIN") 403;` — copy the exact pattern from an existing `src/app/api/admin/*` route.
- **Money is in satang (integer) in the DB.** The form takes ฿ (baht); convert `฿ → satang` (`Math.round(baht*100)`) at the boundary. Never store floats.
- **Transactional:** the record action (Payment + optional plan-grant + optional founder) is ONE `prisma.$transaction` — all or nothing.
- **Soft void, not delete:** voiding sets `Payment.status="VOIDED"` (cohorts/cash filter `status="PAID"`, so VOIDED drops out) — keeps the audit trail. Void does NOT auto-revert a granted plan/founder (documented in UI); it only removes the cash record.
- Do NOT change Stripe/webhook flows, charging, render, or auth. Additive schema only.
- Thai UI copy. Follow existing `/admin` + admin-API style.

---

### Task 1: Schema + backend API

**Files:**
- Modify: `prisma/schema.prisma` (add 3 fields to `Payment`)
- Create: `src/app/api/admin/manual-payment/route.ts` (POST record, GET list)
- Create: `src/app/api/admin/manual-payment/[id]/route.ts` (POST/PATCH void)
- Create: `src/lib/manual-payment.ts` (pure helpers: input validation + satang/period derivation, so it's unit-testable)
- Test: `scripts/verify-manual-payment.ts`

**Steps:**

- [ ] **1a. Schema** — add to `model Payment` (all additive; `prisma db push` on deploy is additive per CLAUDE.md):
```prisma
  manual       Boolean   @default(false)
  note         String?
  recordedBy   String?   // admin userId who recorded it
```
Run `npx prisma generate` after editing (do NOT run migrate/db push locally — deploy.sh does `prisma db push` on prod).

- [ ] **1b. Pure helpers** in `src/lib/manual-payment.ts` (exported, no DB):
```ts
export type ManualPaymentInput = {
  plan: "PRO" | "BUSINESS";
  billingPeriod: "monthly" | "annual";
  amountBaht: number;      // ฿ from the form
  paidAtMs: number;        // epoch ms
  note: string;
  setPlan: boolean;
  markFounder: boolean;
};
// Validate + normalize. Throw Error(reason) on invalid. Returns satang + periodDays + expiry.
export function normalizeManualPayment(input: ManualPaymentInput, nowMs: number): {
  amountSatang: number; periodDays: number; planExpiresAtMs: number;
} {
  if (input.plan !== "PRO" && input.plan !== "BUSINESS") throw new Error("แผนไม่ถูกต้อง");
  if (input.billingPeriod !== "monthly" && input.billingPeriod !== "annual") throw new Error("รอบบิลไม่ถูกต้อง");
  if (!Number.isFinite(input.amountBaht) || input.amountBaht <= 0) throw new Error("จำนวนเงินต้องมากกว่า 0");
  if (!input.note?.trim()) throw new Error("ต้องใส่หมายเหตุ (เช่น โอนธนาคาร / founder)");
  if (!Number.isFinite(input.paidAtMs) || input.paidAtMs > nowMs + 86_400_000) throw new Error("วันที่จ่ายไม่ถูกต้อง");
  const periodDays = input.billingPeriod === "annual" ? 365 : 30;
  const amountSatang = Math.round(input.amountBaht * 100);
  const planExpiresAtMs = input.paidAtMs + periodDays * 86_400_000;
  return { amountSatang, periodDays, planExpiresAtMs };
}
```

- [ ] **1c. POST `/api/admin/manual-payment`** (record). Body = `{ email, ...ManualPaymentInput }`. Steps:
  1. Admin gate.
  2. Look up target user by `email` (case-insensitive `findFirst`); 404 if not found.
  3. `normalizeManualPayment(input, Date.now())` — 400 with the thrown message on invalid.
  4. `prisma.$transaction`:
     - `payment.create`: `{ userId, stripeSessionId: "manual-"+cuid(), plan, amount: amountSatang, currency: "thb", status: "PAID", periodDays, createdAt: new Date(paidAtMs), paidAt: new Date(paidAtMs), manual: true, note: note.trim(), recordedBy: admin.id }`. (Generate cuid via `@paralleldrive/cuid2` if present, else `crypto.randomUUID()` — check what the repo uses for ids.)
     - if `setPlan`: `user.update` → `plan`, `planExpiresAt: new Date(planExpiresAtMs)`, `billingPeriod`, and CLEAR `trialEndsAt: null` + `trialStartedAt: null` (so the trial cron won't revert this paid user — mirror how a real checkout clears trial; verify against `src/lib/trial.ts` / the checkout webhook).
     - if `markFounder`: use `src/lib/founding.ts`'s existing seat-claim helper to atomically bump `FOUNDING100` usedCount and create a CONFIRMED `FoundingReservation` for the user (read that file — reuse its function; do NOT hand-roll counter math). If no seats remain, the whole transaction should fail with a clear 409 message.
  5. Return the created payment summary.
- [ ] **1d. GET `/api/admin/manual-payment`** — list: `payment.findMany({ where: { manual: true }, orderBy: { createdAt: "desc" }, take: 200 })` joined with user email; return `{ id, email, plan, amountBaht: amount/100, billingPeriod (derive from periodDays), paidAt, note, recordedBy, status }`.
- [ ] **1e. POST `/api/admin/manual-payment/[id]`** (void) — admin gate; `payment.update({ where: { id, manual: true }, data: { status: "VOIDED" } })` (only allow voiding `manual` payments — never a real Stripe one; 404 if not a manual payment). Return ok. Do NOT touch the user's plan/founder.
- [ ] **1f. Verify** `scripts/verify-manual-payment.ts`: unit-test `normalizeManualPayment` — valid PRO/annual ฿2995 → satang 299500, periodDays 365, expiry = paidAt+365d; rejects amount≤0, empty note, bad plan, future paidAt; monthly → periodDays 30. Run `npx tsx scripts/verify-manual-payment.ts`, all asserts pass.

---

### Task 2: Admin UI (form + list + void)

**Files:**
- Modify: `src/app/(dashboard)/admin/page.tsx` (Billing & Plans tab — add the panel)
- Create if cleaner: `src/components/admin/manual-payment-panel.tsx` (client component)

**Steps:**

- [ ] **2a.** In the **Billing & Plans** tab of `/admin`, add a "บันทึกการจ่ายนอกระบบ (Manual Payment)" panel (violet house tokens, match the existing admin cards). Read `admin/page.tsx` to find the Billing tab + reuse its card styling.
- [ ] **2b. Form** (client): fields —
  - Email (text, required) — the target user.
  - Plan (select PRO/BUSINESS).
  - รอบบิล (select monthly/annual).
  - จำนวนเงิน ฿ (number) — pre-fill a suggestion from plan list price when plan/period change (monthly = plan price; annual = plan price × 10), but editable (founder pays ~half).
  - วันที่จ่าย (date, default today) — so a historical payment doesn't inflate 24h cash-in.
  - หมายเหตุ (text, required) — e.g. "โอนธนาคาร · founder".
  - ☑ เซ็ต plan + วันหมดอายุให้ user (default ON).
  - ☑ นับเป็น founder (bump FOUNDING100) (default OFF).
  - Submit → POST; on success toast "บันทึกแล้ว" + refresh the list; on error show the server message.
- [ ] **2c. List** below the form: table of manual payments (email · plan · ฿ · รอบ · วันที่ · note · recordedBy · status) with a **void** button per PAID row (confirm before voiding). Voided rows shown greyed with "VOIDED". After void, refresh + toast.
- [ ] **2d.** Small caption under void: "void ลบเฉพาะบันทึกเงิน (ออกจาก จ่ายจริง/MRR/cash) — plan/founder ที่เซ็ตไว้ต้องปรับที่ /admin/users เอง".

---

## Acceptance Criteria
- [ ] Admin can record an off-Stripe payment → a `Payment status=PAID manual=true` row exists → the user appears in `getRevenueCohorts()` payingTotal + MRR + cash-in with no other action.
- [ ] "เซ็ต plan" grants plan + expiry (and clears trial so the cron won't revert); "founder" bumps the FOUNDING100 counter atomically (fails cleanly if no seats).
- [ ] The whole record is one transaction (no partial state on failure); all inputs validated; admin-only.
- [ ] Manual payments list renders; void sets status=VOIDED and the row drops out of จ่ายจริง/MRR/cash; a real Stripe payment can never be voided by this endpoint.
- [ ] `npm run build` green; `scripts/verify-manual-payment.ts` passes.

## Status
interviewed 2026-07-05 (owner: bundled + list/void) | approved: pending | executed: - | delivered: -
