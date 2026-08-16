# Pricing Rework — P3: Credit system foundation (Implementation Plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A unified credit currency (1 credit = ฿1) with an atomic balance + ledger: spend on AI-gen / overflow minutes, granted-monthly (reset) vs purchased (rollover). This phase builds the FOUNDATION only — wiring AI-gen and Stripe packs come later.

**Architecture:** New `CreditBalance` (granted + purchased buckets) + `CreditLedger` (audit). `src/lib/credits.ts` provides atomic `spendCredits` (granted-first, then purchased), `grantCredits`, `resetMonthlyGranted`, `creditCostFor`. Mirrors the atomic conditional-`where` style of `reserveMinutes` (`src/lib/minute-limits.ts`).

**Conflict note:** all-new files + additive schema. ZERO overlap with the parallel security audit (render/thumbnail/fetch-stock/MCP). Safe to build ahead of the security merge.

## Global Constraints
- Additive schema only (`@default`). `1 credit = ฿1`. Markup baked into `CREDIT_COST` (already decided): minute 2 · image-gpt-1k 3 · image-nano-1k 4 · image-gpt-2k 5 · image-nano-2k 6 · video-seedance-5s 10.
- Monthly granted allowance: FREE 0 · PRO 50 · BUSINESS 150. Granted resets monthly (use-it-or-lose-it); purchased rolls over.
- Test pattern `scripts/verify-*.ts` via `npx tsx`. Thai user-facing copy where surfaced (not in this lib).

---

### Task 1: Credit schema + atomic balance/ledger lib

**Files:**
- Modify: `prisma/schema.prisma` (add `CreditBalance`, `CreditLedger`)
- Create: `src/lib/credits.ts`
- Test: `scripts/verify-credits.ts`

**Interfaces (later tasks consume):**
- `creditCostFor(action: string): number`
- `getBalance(userId): Promise<{ granted: number; purchased: number; total: number }>` (creates the row if missing)
- `spendCredits(userId, amount, action): Promise<{ ok: true; balanceAfter: number } | { ok: false; reason: "insufficient"; balanceAfter: number }>` — granted-first then purchased, atomic, writes a ledger row on success
- `grantCredits(userId, amount, kind: "grant" | "purchase", action?): Promise<void>` — adds to granted (grant) or purchased (purchase) + ledger row
- `resetMonthlyGranted(userId, plan): Promise<void>` — sets granted := monthly allowance for plan, `grantedResetAt = now`, ledger row

- [ ] **Step 1:** schema (additive, all defaults):
```prisma
model CreditBalance {
  userId         String   @id
  granted        Int      @default(0)
  purchased      Int      @default(0)
  grantedResetAt DateTime?
  updatedAt      DateTime @updatedAt
}
model CreditLedger {
  id           String   @id @default(cuid())
  userId       String
  delta        Int
  kind         String   // grant | purchase | spend | expire
  action       String?
  balanceAfter Int
  createdAt    DateTime @default(now())
  @@index([userId, createdAt])
}
```
  Apply with `npm run db:migrate`; `npx prisma validate`.
- [ ] **Step 2:** write `scripts/verify-credits.ts` (throwaway SQLite, same boilerplate as `scripts/verify-minute-meter.ts`) asserting:
  - spend from granted first: granted 50 / purchased 100, `spendCredits(u,30,"x")` → granted 20, purchased 100, ok true
  - spend spans both: granted 10 / purchased 100, spend 30 → granted 0, purchased 80
  - insufficient: granted 5 / purchased 5, spend 20 → `{ok:false,reason:"insufficient"}`, balances UNCHANGED
  - `grantCredits(u,200,"purchase")` → purchased += 200
  - `resetMonthlyGranted(u,"PRO")` → granted === 50 regardless of prior
  - `creditCostFor("image-nano-1k")===4`, `creditCostFor("video-seedance-5s")===10`, unknown → 0
  - a `CreditLedger` row is written per successful spend/grant/reset
  Run → fail.
- [ ] **Step 3:** implement `src/lib/credits.ts`. `spendCredits` must be atomic: compute `fromGranted=min(granted,amount)`, `fromPurchased=amount-fromGranted`; `prisma.creditBalance.updateMany({ where:{ userId, granted:{gte:fromGranted}, purchased:{gte:fromPurchased} }, data:{ granted:{decrement:fromGranted}, purchased:{decrement:fromPurchased} } })`; if `count!==1` re-read and return `{ok:false}` (lost race / insufficient). Write the ledger row with `balanceAfter`. `getBalance` upserts an empty row if missing. `MONTHLY_GRANT={FREE:0,PRO:50,BUSINESS:150}`.
- [ ] **Step 4:** run `npx tsx scripts/verify-credits.ts` → pass; `npx tsc --noEmit` 0 errors. Commit (`feat(credits): atomic credit balance + ledger (granted/purchased) + cost table`).

---

### Task 2: Credit-pack checkout + grant-on-payment (conflict-free — payments/* not in security scope)

**Files:**
- Modify: `src/lib/credits.ts` (add `CREDIT_PACKS` + `creditPack(id)`)
- Create: `src/app/api/payments/credits/route.ts` (NEW route — does NOT touch the existing plan-checkout `payments/checkout/route.ts`)
- Modify: `src/app/api/payments/webhook/route.ts` (one early branch in `checkout.session.completed`)
- Test: `scripts/verify-credit-packs.ts`

**Interface:** `CREDIT_PACKS: Record<"starter"|"popular"|"pro", { baht: number; credits: number }>` = `starter {baht:199,credits:200}`, `popular {499,540}`, `pro {999,1150}`. `creditPack(id): {baht,credits} | null`.

- [ ] **Step 1:** add `CREDIT_PACKS` + `creditPack` to `credits.ts`. Write `scripts/verify-credit-packs.ts`: assert the three packs' baht/credits exactly; assert `creditPack("nope")===null`; assert `grantCredits(u, CREDIT_PACKS.popular.credits, "purchase")` → `getBalance(u).purchased===540`. Run → fail.
- [ ] **Step 2:** create `src/app/api/payments/credits/route.ts` — `POST`: auth via `getCurrentUser`; `await ensureStripeConfig()`; parse `{ pack }`; `const p = creditPack(pack)`; 400 if null; ensure a Stripe customer (mirror lines 33-39 of `payments/checkout/route.ts` — reuse `user.stripeCustomerId` or create one); `const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";` create `stripe.checkout.sessions.create({ mode: "payment", customer, line_items: [{ price_data: { currency: "thb", unit_amount: p.baht * 100, product_data: { name: \`HERO Credits — ${pack}\` } }, quantity: 1 }], metadata: { userId, type: "credits", credits: String(p.credits) }, expires_at: Math.floor(Date.now()/1000)+30*60, success_url: \`${origin}/settings?tab=billing&credits=success\`, cancel_url: \`${origin}/pricing?credits=cancelled\` })`; return `{ url: session.url }`. Wrap in try/catch → `apiError`.
- [ ] **Step 3:** in `payments/webhook/route.ts` `if (event.type === "checkout.session.completed")`, add at the TOP of that block (before the existing plan-activation code): `if (s.metadata?.type === "credits" && s.metadata.userId) { await grantCredits(s.metadata.userId, parseInt(s.metadata.credits ?? "0", 10), "purchase", "pack").catch(e => console.error("[webhook] credit grant:", e)); return NextResponse.json({ ok: true }); }` — import `grantCredits` from `@/lib/credits`. This returns early so credit purchases never run plan-activation.
- [ ] **Step 4:** `npx tsx scripts/verify-credit-packs.ts` passes, `npx tsc --noEmit` 0 errors, existing tests still green. Commit (`feat(credits): credit-pack checkout route + webhook grant-on-payment`).

### LATER (after security rebase)
- P3.3 monthly granted reset on subscription renewal/cycle (cron + webhook) — reuses `resetMonthlyGranted`.
- P3.4 (overlaps security) gate AI-gen (kie image/video) + overflow-minutes behind `spendCredits` in fetch-stock / tts-gemini — DEFER (fetch-stock = security SSRF target).
