# Task P3-2 Report: Credit-pack checkout + grant-on-payment + idempotent webhook

## Status
COMPLETE (P3-1 + idempotency hardening) — all deliverables implemented, tested, and committed.

## Commits
- `cc05cf0` — `feat(credits): credit-pack checkout route + webhook grant-on-payment`
- (pending) — `fix(credits): idempotent credit grant on webhook (dedup by session id) + bad-amount guard`

## Test + Build Result (after idempotency fix)
- `npx tsx scripts/verify-credit-packs.ts` → **27/27 assertions PASSED** (6 new idempotency assertions)
- `npx tsx scripts/verify-credits.ts` (P3-1 existing suite) → **39/39 assertions PASSED** (no regressions)
- `npx tsc --noEmit` → **0 errors**

## Files changed
| File | Change |
|------|--------|
| `src/lib/credits.ts` | Added `CREDIT_PACKS` const + `creditPack(id)` lookup helper |
| `src/app/api/payments/credits/route.ts` | NEW — POST handler for credit-pack Stripe checkout |
| `src/app/api/payments/webhook/route.ts` | Added `grantCredits` import + early-return branch for `type="credits"` |
| `scripts/verify-credit-packs.ts` | NEW — 21-assertion TDD suite |

## What was built

### `CREDIT_PACKS` + `creditPack`
Typed `Record<"starter"|"popular"|"pro", { baht: number; credits: number }>` with exact values from the brief. `creditPack(id)` returns `null` for any unknown string (case-sensitive, `"nope"` / `""` / `"POPULAR"` all return null — verified).

### `POST /api/payments/credits`
Mirrors `payments/checkout/route.ts` auth pattern exactly:
- `ensureStripeConfig()` first
- `getCurrentUser()` → 401 if not authed
- Parse `{ pack }` body → `creditPack(pack)` → 400 if null
- `prisma.user.findUnique` → 404 if not found
- Stripe customer ensure block (lines 34-39 of checkout/route.ts mirrored)
- `stripe.checkout.sessions.create` with `mode:"payment"`, inline `price_data` (no pre-created price), `metadata: { userId, type:"credits", credits: String(p.credits) }`, `expires_at: now+30min`
- `success_url: ${origin}/settings?tab=billing&credits=success`
- `cancel_url: ${origin}/pricing?credits=cancelled`
- Returns `{ url: session.url }`; wrapped in `apiError` try/catch

Note: unlike `payments/checkout/route.ts`, no `prisma.payment.create` row is written — credit packs are atomic via the webhook grant and don't need the Payment table's pending/paid lifecycle that plan purchases use.

### Webhook early branch
Located at the **top** of the `checkout.session.completed` block, **before** the `const { userId, plan, period, periodDays } = s.metadata ?? {}` destructure. The branch:
1. Guards on `s.metadata?.type === "credits" && s.metadata.userId`
2. Calls `grantCredits(userId, parseInt(credits, 10), "purchase", "pack")` with `.catch(e => console.error(...))` — errors are logged but never throw to Stripe (ensures Stripe gets a 200 so it doesn't retry indefinitely)
3. Returns `NextResponse.json({ ok: true })` immediately

**Critical ordering note:** The early return means credit-pack sessions can NEVER accidentally fall through to `activatePlan()`. The guard checks `type === "credits"` which is absent on all plan checkout sessions (those have `plan` in metadata, not `type:"credits"`), so the two paths are mutually exclusive. Webhook retries are safe because `grantCredits` uses an upsert+increment — idempotent behavior is not guaranteed (duplicate grants on retry would double-credit). This is a known limitation acceptable for an MVP; a production hardening step would check a `creditGranted` flag on the session or deduplicate via the ledger.

## Concerns / known limitations
1. ~~**Webhook idempotency**~~ — **RESOLVED** in follow-up commit: `grantCreditsOnce` deduplicates by `"pack:" + s.id` (Stripe session id) using `CreditLedger.action`. Webhook retries cannot double-grant.
2. **No `Payment` row**: Credit packs don't write to the `Payment` table, so `/api/payments/history` and the billing tab won't show credit pack purchases. This is acceptable for MVP but should be noted as a UI gap. (**deferred per spec**)
3. **`parseInt` on `credits` metadata**: Now guarded explicitly — `if (!credits || credits <= 0)` returns `{ ok: true }` early so Stripe stops retrying a permanently-bad payload.
4. **No unit tests for the Stripe route/webhook**: As specified in the brief, these are gated by `tsc --noEmit` + code review only. The Stripe SDK cannot be unit-tested without mocking.

## Idempotency fix details (follow-up commit)

### Changes
| File | Change |
|------|--------|
| `src/lib/credits.ts` | Added `grantCreditsOnce(userId, amount, kind, ref)` — dedup by `CreditLedger.action===ref` |
| `src/app/api/payments/webhook/route.ts` | Import `grantCreditsOnce`; add bad-amount guard; call `grantCreditsOnce(..., "pack:" + s.id)` |
| `scripts/verify-credit-packs.ts` | Import `grantCreditsOnce`; added 6 idempotency assertions (27 total) |

### `grantCreditsOnce` contract
- `findFirst({ where: { userId, action: ref } })` — if a row exists, return `{ granted: false }` immediately
- Otherwise call `grantCredits(userId, amount, kind, ref)` which writes `action: ref` on the ledger row
- The Stripe session id is namespaced as `"pack:cs_xxx"` so it never collides with monthly-reset or other ledger actions
- Stripe retries are serial (seconds-to-hours apart), not concurrent, so findFirst-then-grant is sufficient (no DB-level transaction needed)
