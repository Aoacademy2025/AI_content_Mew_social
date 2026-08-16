# Overflow Minute-Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a managed user runs out of monthly render-minutes, silently auto-spend their credits (2 credits = 1 minute, ฿2/min) so the render proceeds — only walling (with a "buy credits" CTA) when credits are also empty.

**Architecture:** Hook the credit-overflow into the *render reserve path* (`render/route.ts`, the single place that counts minutes by output duration under `MINUTE_QUOTA`). A small orchestration lib (`reserveMinutesOrCredits`) tries minutes first, falls back to `spendCredits`; a sibling `refundReservation` makes every refund path *bucket-aware* (credit-funded renders refund credits, not minutes). A new nullable `creditsSpent` column on `RenderJob`/`ChargedClip` carries the funding source across the async/queue boundary so refunds and receipts are exact.

**Tech Stack:** Next.js 15 App Router, Prisma 6 (SQLite), existing `src/lib/credits.ts` (CreditBalance/CreditLedger) + `src/lib/minute-limits.ts`.

## Global Constraints

- **Flag-off byte-identical (HARD):** New behavior gated by `MINUTE_QUOTA==="1"` **and** `CREDITS_LIVE==="1"` (server) / `NEXT_PUBLIC_CREDITS_LIVE==="1"` (client, build-baked). With `CREDITS_LIVE` unset the render path must be provably identical to today (still reserves minutes, still 403-walls). With `MINUTE_QUOTA` unset the clip-cap path is untouched.
- **Conversion is locked:** `creditCostFor("minute") === 2` (already in `credits.ts`). 1 credit = ฿1. Do NOT hardcode `2` — call `creditCostFor("minute")`.
- **Silent auto-spend (no opt-in):** overflow spends automatically; do NOT add an `allowCreditOverflow` body param (that was the superseded P3.4 design). Transparency is delivered by a post-render receipt, not a pre-spend consent dialog.
- **Spend order:** `spendCredits` already drains `granted` (monthly, expiring) before `purchased` (paid) — do not change it.
- **Refund direction is fail-safe:** `refundCredits` restores to the `purchased` bucket; never under-refund the user.
- **Money-path rigor:** Tasks 4–5 touch the core render path → opus implementer + opus reviewer, with an explicit flag-off-byte-identical diff proof. Libs (Tasks 1–3) are TDD'd via `npx tsx scripts/verify-*.ts` (throwaway SQLite — the team's test pattern; routes themselves are tsc + reasoning + Mew's render-QA gate).
- **Do NOT touch** `tts-gemini/route.ts` (its minute reserve is already skipped when `MINUTE_QUOTA==="1"`) or `generate/route.ts` (avatar — see "Deferred" below).
- **Branch:** `mew/managed-path-ux`. NOT pushed/merged/deployed (Mew deploys). Implementers must NOT `git add` any `.superpowers/` scratch.

## Branch-topology note (verified 2026-06-25)

`mew/managed-path-ux` is stacked off p1 (`8ad2a0c`). It HAS: credit foundation (`credits.ts`: `spendCredits`/`getBalance`/`grantCredits`/`CREDIT_COST`/`CREDIT_PACKS`), the pack-checkout route `POST /api/payments/credits`, and the webhook credit-grant branch. It does NOT have (those live on the separate p2 stack — P3.4/P3.5): `refundCredits`, `src/lib/minute-credits.ts`, `GET /api/credits/balance`, `ensureMonthlyGrant`, or any `creditsSpent` schema field. This plan therefore BUILDS a minimal `refundCredits` here. **Mew: on merge, dedupe this `refundCredits` against p2's — semantics are compatible (both add-back + ledger row).**

## Deferred (documented v1 simplifications — NOT in scope)

- **Avatar overflow (`generate/route.ts`):** avatar reserves minutes on an *up-front estimate* (`estimateScriptMinutes`, unreconciled to actual). Charging real credits on an estimate is avoided for v1 → avatar **walls as today** when out of minutes. Fast-follow. (Result: out-of-minutes users can overflow the standard render path but not avatar — the safe direction; flag for Mew.)
- **Boundary clip = whole-clip-to-credits:** when a render needs more minutes than remain, `reserveMinutes` already fails all-or-nothing → the whole clip is credit-funded; the leftover sub-cap minutes are NOT consumed and stay in quota for a smaller next render (no forfeit). Partial-consume (use remaining minutes + top-up credits) is a future refinement.
- **Exact per-bucket refund:** v1 refunds to `purchased`; restoring to the exact spent buckets is a future refinement.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/minute-limits.ts` | `minutesFromSeconds`: ceil → **round** (one-system round-to-nearest) | 1 |
| `scripts/verify-minute-enforcement.ts` | update expectations for round-to-nearest + add sub-.5 cases | 1 |
| `docs/pricing-business-model-2026-06-24.md` | note "ceil → round-to-nearest" evolution | 1 |
| `src/lib/credits.ts` | add `refundCredits(userId, amount, action)` | 2 |
| `prisma/schema.prisma` | add `creditsSpent Int?` to `RenderJob` + `ChargedClip` | 2 |
| `src/lib/usage-limits.ts` | extend `recordChargedClip` to store `creditsSpent` | 2 |
| `scripts/verify-credit-overflow.ts` | TDD `refundCredits` + record path | 2 |
| `src/lib/minute-credits.ts` (NEW) | `reserveMinutesOrCredits` + `refundReservation` (bucket-aware) | 3 |
| `scripts/verify-minute-credits.ts` (NEW) | TDD the orchestration + refund routing | 3 |
| `src/app/api/videos/render/route.ts` | wire overflow at reserve site + bucket-aware refunds + store/surface `creditsSpent` + `canBuyCredits` wall signal | 4 |
| `src/lib/render/job-store.ts` | queue-path `refundJobReservation` reads `job.creditsSpent` | 4 |
| `src/app/(dashboard)/video-creator/page.tsx` | wall buy-credits CTA + post-render receipt toast + low-balance nudge (gated) | 5 |
| `src/app/(dashboard)/video-editor/page.tsx` | mirror the same client UX | 5 |

---

### Task 1: One-system round-to-nearest minutes

**Why:** Mew's decision — one rounding rule everywhere; round to NEAREST minute (min 1), not ceil, so a 1:05 clip = 1 min (not 2) and a 1:45 clip = 2 min. Fixes the "charged 2 min for a 1:05 clip" drama on the real-money overflow charge while staying integer-credit.

**Files:**
- Modify: `src/lib/minute-limits.ts:15-17` (`minutesFromSeconds`)
- Modify: `scripts/verify-minute-enforcement.ts` (the `minutesFromSeconds` assertions)
- Modify: `docs/pricing-business-model-2026-06-24.md` (rounding note)

**Interfaces:**
- Produces: `minutesFromSeconds(sec: number): number` — unchanged signature; now rounds to nearest, min 1, non-finite/≤0 → 1.

- [ ] **Step 1: Update the failing test expectations**

In `scripts/verify-minute-enforcement.ts`, find the `minutesFromSeconds` assertion block and replace it with these cases (note 65/89 now → 1, were 2 under ceil):

```ts
assert(minutesFromSeconds(90) === 2, "90s → 2 min");
assert(minutesFromSeconds(60) === 1, "60s → 1 min");
assert(minutesFromSeconds(30) === 1, "30s → 1 min (floor 1)");
assert(minutesFromSeconds(0) === 1, "0s → 1 min (guard)");
assert(minutesFromSeconds(150) === 3, "150s → 3 min (2.5 rounds up)");
assert(minutesFromSeconds(360) === 6, "360s → 6 min");
assert(minutesFromSeconds(NaN) === 1, "NaN → 1 min (guard)");
// round-to-nearest (NEW — these were 2 under ceil):
assert(minutesFromSeconds(65) === 1, "65s (1:05) → 1 min (nearest)");
assert(minutesFromSeconds(89) === 1, "89s (1:29) → 1 min (nearest)");
assert(minutesFromSeconds(91) === 2, "91s (1:31) → 2 min (nearest)");
assert(minutesFromSeconds(105) === 2, "105s (1:45) → 2 min (nearest)");
```

- [ ] **Step 2: Run it to verify the 65s/89s cases FAIL under current ceil**

Run: `npx tsx scripts/verify-minute-enforcement.ts`
Expected: FAIL at "65s (1:05) → 1 min" (ceil returns 2).

- [ ] **Step 3: Change ceil → round**

In `src/lib/minute-limits.ts`, replace `minutesFromSeconds`:

```ts
/** Convert a duration in seconds to whole minutes, ROUNDED TO NEAREST, minimum 1.
 *  One-system rounding (Mew 2026-06-26): nearest, not ceil — a 1:05 clip = 1 min,
 *  1:45 = 2 min. Non-finite / non-positive / NaN inputs default to 60s (→ 1 min). */
export function minutesFromSeconds(sec: number): number {
  return Math.max(1, Math.round((Number.isFinite(sec) && sec > 0 ? sec : 60) / 60));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx scripts/verify-minute-enforcement.ts`
Expected: ALL CHECKS PASSED.

- [ ] **Step 5: Note the evolution in the spec doc**

In `docs/pricing-business-model-2026-06-24.md`, near the minute/counting rule, add:

```markdown
> **Rounding (evolved 2026-06-26):** minutes are rounded to the NEAREST whole minute (min 1), one rule everywhere — NOT ceil. Rationale: a 1:05 clip charging 2 minutes felt punitive on the real-money overflow path; nearest is statistically fair and stays integer-credit. (Supersedes the earlier "ceil to whole minute".)
```

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit` → Expected: 0 errors.
```bash
git add src/lib/minute-limits.ts scripts/verify-minute-enforcement.ts docs/pricing-business-model-2026-06-24.md
git commit -m "feat(quota): round minutes to nearest (one-system), not ceil"
```

---

### Task 2: Credit primitives — `refundCredits` + `creditsSpent` column + record path

**Why:** Overflow refunds must return *credits* (not minutes) when a credit-funded render fails. That needs (a) a `refundCredits` fn, (b) a place to remember a render was credit-funded across the async/queue boundary (`creditsSpent` column), and (c) `recordChargedClip` to persist it on success for audit/receipt.

**Files:**
- Modify: `src/lib/credits.ts` (add `refundCredits` after `spendCredits`)
- Modify: `prisma/schema.prisma` (`RenderJob` ~L476-504, `ChargedClip` ~L446-454)
- Modify: `src/lib/usage-limits.ts` (`recordChargedClip`)
- Create: `scripts/verify-credit-overflow.ts`

**Interfaces:**
- Consumes: `prisma`, existing `getBalance`, `CreditLedger`/`CreditBalance` models.
- Produces:
  - `refundCredits(userId: string, amount: number, action: string): Promise<void>` — increments `purchased`, writes a `kind:"refund"` ledger row.
  - `recordChargedClip(userId: string, outputUrl: string, chargedMinutes?: number, creditsSpent?: number): Promise<void>` (extended signature; both trailing args optional/nullable).
  - `RenderJob.creditsSpent Int?`, `ChargedClip.creditsSpent Int?`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-credit-overflow.ts` (mirror the structure of `scripts/verify-credit-spend.ts` — throwaway SQLite via `tsx`, `prisma db push`, then assertions). Core assertions:

```ts
// after seeding a user + CreditBalance { granted: 0, purchased: 10 }
await refundCredits(u.id, 4, "render-overflow-refund:job1");
const bal = await getBalance(u.id);
assert(bal.purchased === 14, "refund adds to purchased");
assert(bal.total === 14, "refund total");
const row = await prisma.creditLedger.findFirst({ where: { userId: u.id, action: "render-overflow-refund:job1" } });
assert(row?.kind === "refund" && row?.delta === 4, "refund ledger row kind+delta");
let threw = false;
try { await refundCredits(u.id, 0, "x"); } catch { threw = true; }
assert(threw, "refundCredits rejects non-positive amount");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/verify-credit-overflow.ts`
Expected: FAIL — `refundCredits` is not exported.

- [ ] **Step 3: Implement `refundCredits`**

In `src/lib/credits.ts`, after `spendCredits`:

```ts
// ── Refund credits ────────────────────────────────────────────────────────────

/**
 * Refund credits previously spent (e.g. a credit-funded overflow render that
 * failed / was superseded / cancelled). Adds the amount back to the `purchased`
 * bucket and writes a `kind:"refund"` ledger row.
 *
 * v1 always restores to `purchased` (the permanent bucket): this never
 * disadvantages the user and never leaks credits against them. Exact per-bucket
 * restoration is a future refinement.
 */
export async function refundCredits(
  userId: string,
  amount: number,
  action: string
): Promise<void> {
  if (amount <= 0) throw new Error("refundCredits: amount must be positive");
  const updated = await prisma.creditBalance.upsert({
    where: { userId },
    create: { userId, granted: 0, purchased: amount },
    update: { purchased: { increment: amount } },
  });
  const balanceAfter = updated.granted + updated.purchased;
  await prisma.creditLedger.create({
    data: { userId, delta: amount, kind: "refund", action, balanceAfter },
  });
}
```

- [ ] **Step 4: Add the `creditsSpent` columns**

In `prisma/schema.prisma`, add to `model RenderJob` (next to `reservedMinutes`):

```prisma
  creditsSpent    Int?      // credits spent to fund this render via overflow (null = minute/clip-funded); for bucket-aware refund
```

and to `model ChargedClip` (next to `chargedMinutes`):

```prisma
  creditsSpent   Int?      // credits charged for a credit-funded (overflow) render; null = minute/clip-funded
```

Then sync the throwaway test DB happens inside the verify script; for the repo, do NOT run a destructive migrate — `prisma db push` is additive and runs at deploy. Run locally to regenerate the client:

Run: `npx prisma generate`
Expected: client regenerated, no error.

- [ ] **Step 5: Extend `recordChargedClip`**

Read the current `recordChargedClip` in `src/lib/usage-limits.ts`. It currently takes `(userId, outputUrl, chargedMinutes?)`. Add a 4th optional param and persist it:

```ts
export async function recordChargedClip(
  userId: string,
  outputUrl: string,
  chargedMinutes?: number,
  creditsSpent?: number,
): Promise<void> {
  // ...existing canonicalization of outputUrl + create/upsert...
  // include in the create data:
  //   chargedMinutes: chargedMinutes ?? null,
  //   creditsSpent: creditsSpent ?? null,
}
```

Keep the existing 2- and 3-arg call sites working (both new args optional → backward-compatible).

- [ ] **Step 6: Run tests to verify pass**

Run: `npx tsx scripts/verify-credit-overflow.ts` → Expected: PASS.
Run: `npx tsx scripts/verify-minute-enforcement.ts` → Expected: still PASS (recordChargedClip backward-compat).
Run: `npx tsc --noEmit` → Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/credits.ts prisma/schema.prisma src/lib/usage-limits.ts scripts/verify-credit-overflow.ts
git commit -m "feat(credits): refundCredits + creditsSpent column + record path"
```

---

### Task 3: Orchestration lib — `reserveMinutesOrCredits` + `refundReservation`

**Why:** Centralize the minutes→credits fallback and the bucket-aware refund so the route changes (Task 4) are thin and the money logic is unit-tested.

**Files:**
- Create: `src/lib/minute-credits.ts`
- Create: `scripts/verify-minute-credits.ts`

**Interfaces:**
- Consumes: `reserveMinutes`/`refundMinutes` (minute-limits), `spendCredits`/`refundCredits`/`creditCostFor` (credits), `refundClipUsage` (usage-limits).
- Produces:
  - `reserveMinutesOrCredits(userId, minutes, opts:{creditsLive:boolean; ref?:string}): Promise<ReserveResult>`
  - `refundReservation(userId, res:{reservedMinutes:number|null; creditsSpent:number|null}, action:string): Promise<void>`
  - `type ReserveResult` (discriminated on `via`).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-minute-credits.ts` (throwaway SQLite, mirror `verify-minute-enforcement.ts` setup). Assertions:

```ts
// User PRO, minutesLimit 80, minutesUsed 0; CreditBalance { granted: 0, purchased: 10 }
// within quota → minutes
let r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: true, ref: "j1" });
assert(r.allowed && r.via === "minutes" && r.reservedMinutes === 2, "within quota → minutes");

// drive minutesUsed to the cap, then overflow with credits on
await prisma.user.update({ where: { id: u.id }, data: { minutesUsed: 80 } });
r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: true, ref: "j2" });
assert(r.allowed && r.via === "credits" && r.creditsSpent === 4, "over quota + creditsLive → credits (2min*2)");
const after = await prisma.user.findUnique({ where: { id: u.id } });
assert(after?.minutesUsed === 80, "minute meter NOT incremented on credit overflow");
const bal = await getBalance(u.id);
assert(bal.total === 6, "credits drained by 4 (10→6)");

// over quota + creditsLive OFF → none (wall)
r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: false, ref: "j3" });
assert(!r.allowed && r.via === "none" && !!r.message, "over quota + creditsLive off → none with message");

// over quota + on + insufficient credits → none
await prisma.creditBalance.update({ where: { userId: u.id }, data: { granted: 0, purchased: 1 } });
r = await reserveMinutesOrCredits(u.id, 2, { creditsLive: true, ref: "j4" });
assert(!r.allowed && r.via === "none", "insufficient credits → none (no partial spend)");
const bal2 = await getBalance(u.id);
assert(bal2.total === 1, "no credits spent when insufficient");

// refundReservation routing
await refundReservation(u.id, { reservedMinutes: null, creditsSpent: 4 }, "refund:j2");
assert((await getBalance(u.id)).total === 5, "refundReservation(creditsSpent) → refundCredits");
await prisma.user.update({ where: { id: u.id }, data: { minutesUsed: 80 } });
await refundReservation(u.id, { reservedMinutes: 3, creditsSpent: null }, "refund:min");
assert((await prisma.user.findUnique({ where: { id: u.id } }))?.minutesUsed === 77, "refundReservation(reservedMinutes) → refundMinutes");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/verify-minute-credits.ts`
Expected: FAIL — module `@/lib/minute-credits` not found.

- [ ] **Step 3: Implement the lib**

Create `src/lib/minute-credits.ts`:

```ts
import { reserveMinutes, refundMinutes } from "@/lib/minute-limits";
import { spendCredits, refundCredits, creditCostFor } from "@/lib/credits";
import { refundClipUsage } from "@/lib/usage-limits";

export type ReserveResult =
  | { allowed: true; via: "minutes"; reservedMinutes: number; remaining: number }
  | { allowed: true; via: "credits"; reservedMinutes: number; creditsSpent: number; balanceAfter: number }
  | { allowed: false; via: "none"; remaining: number; message?: string };

/**
 * Reserve render capacity by minutes, silently falling back to credits when the
 * monthly minute quota is exhausted (the user purchased credits expressly to
 * render past their cap — no opt-in, no per-render consent dialog).
 *
 * - within quota → reserve minutes (via:"minutes")
 * - out of minutes + creditsLive + enough credits → spend minutes×2 credits
 *   (via:"credits"); the minute meter is NOT touched, leftover sub-cap minutes
 *   stay in quota.
 * - out of minutes + (creditsLive off OR insufficient credits) → via:"none"
 *   (caller walls). No partial spend.
 */
export async function reserveMinutesOrCredits(
  userId: string,
  minutes: number,
  opts: { creditsLive: boolean; ref?: string }
): Promise<ReserveResult> {
  const r = await reserveMinutes(userId, minutes);
  if (r.allowed) {
    return { allowed: true, via: "minutes", reservedMinutes: minutes, remaining: r.remaining };
  }
  if (opts.creditsLive) {
    const cost = minutes * creditCostFor("minute"); // 2 credits / minute
    const action = opts.ref ? `render-overflow:${opts.ref}` : "render-overflow";
    const spend = await spendCredits(userId, cost, action);
    if (spend.ok) {
      return { allowed: true, via: "credits", reservedMinutes: minutes, creditsSpent: cost, balanceAfter: spend.balanceAfter };
    }
  }
  return { allowed: false, via: "none", remaining: r.remaining, message: r.message };
}

/**
 * Refund a reservation, choosing the correct bucket:
 *  - credit-funded (creditsSpent>0) → refundCredits
 *  - minute-funded (reservedMinutes!=null) → refundMinutes
 *  - legacy clip-funded → refundClipUsage
 */
export async function refundReservation(
  userId: string,
  res: { reservedMinutes: number | null; creditsSpent: number | null },
  action: string
): Promise<void> {
  if (res.creditsSpent && res.creditsSpent > 0) {
    await refundCredits(userId, res.creditsSpent, action);
  } else if (res.reservedMinutes != null) {
    await refundMinutes(userId, res.reservedMinutes);
  } else {
    await refundClipUsage(userId);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx scripts/verify-minute-credits.ts` → Expected: PASS.
Run: `npx tsc --noEmit` → Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/minute-credits.ts scripts/verify-minute-credits.ts
git commit -m "feat(credits): reserveMinutesOrCredits + bucket-aware refundReservation lib"
```

---

### Task 4: Wire overflow into render route + queue refund (CORE — opus)

**Why:** This is where minutes are actually reserved/refunded/recorded. After this task, an out-of-minutes user with `CREDITS_LIVE=1` renders by spending credits; refunds and the queue path stay correct; the wall response signals "buy credits"; the job carries `creditsSpent` for the receipt.

**Files:**
- Modify: `src/app/api/videos/render/route.ts` (reserve ~402, `quotaExceededResponse` ~211, `refundReservedClip` ~869, setup-error refund ~1097, record ~1028, RenderJob enqueue, status response)
- Modify: `src/lib/render/job-store.ts` (`refundJobReservation` ~10-23)

**Interfaces:**
- Consumes: `reserveMinutesOrCredits`, `refundReservation` (Task 3); extended `recordChargedClip` (Task 2); `RenderJob.creditsSpent` (Task 2).
- Produces: 403 quota body now optionally carries `error.canBuyCredits: true`; job status carries `creditsSpent` + `creditBalanceAfter` when credit-funded.

**Flag-off proof requirement (must be in the task report):** show that with `CREDITS_LIVE` unset, (a) `reserveMinutesOrCredits(creditsLive:false)` returns exactly `reserveMinutes`'s allow/deny + message, (b) `creditsSpent` stays `null` so every refund calls `refundMinutes` verbatim, (c) `quotaExceededResponse(msg)` with no/false `canBuyCredits` is byte-identical JSON to today, (d) `recordChargedClip(..., undefined)` is unchanged. With `MINUTE_QUOTA` unset the `useMinuteQuota` branch is not entered at all.

- [ ] **Step 1: Add flags + funding-source local**

Near `const useMinuteQuota = process.env.MINUTE_QUOTA === "1";` (L234) add:
```ts
const creditsLive = process.env.CREDITS_LIVE === "1";
```
Near `let quotaReserved`/`reservedUserId` declarations (~L230-231) add:
```ts
let creditsSpent: number | null = null;
let creditBalanceAfter: number | null = null;
```

- [ ] **Step 2: Extend `quotaExceededResponse` (byte-identical when no opts)**

Replace the function (~L211-225) with:
```ts
function quotaExceededResponse(message: string, opts?: { canBuyCredits?: boolean }) {
  return NextResponse.json(
    {
      error: {
        code: "quota_exceeded",
        provider: "heroai",
        message,
        userAction: opts?.canBuyCredits
          ? "ซื้อเครดิตเพื่อเรนเดอร์ต่อ หรืออัปเกรดแพ็กเกจ"
          : "อัปเกรดแพ็กเกจที่หน้า Pricing เพื่อสร้างคลิปต่อ",
        retryable: false,
        ...(opts?.canBuyCredits ? { canBuyCredits: true } : {}),
      },
      detail: message,
    },
    { status: 403 }
  );
}
```
(When `opts` is omitted or `canBuyCredits` falsy → identical body to the original.)

- [ ] **Step 3: Wire the reserve site**

Replace the `} else if (useMinuteQuota) {` reserve branch (~L401-406):
```ts
} else if (useMinuteQuota) {
  const result = await reserveMinutesOrCredits(userId, reservedMinutes, { creditsLive, ref: jobId });
  if (!result.allowed) return quotaExceededResponse(result.message ?? "โควต้านาทีรอบนี้ใช้ครบแล้ว", { canBuyCredits: creditsLive });
  quotaReserved = true;
  reservedUserId = userId;
  if (result.via === "credits") {
    creditsSpent = result.creditsSpent;
    creditBalanceAfter = result.balanceAfter;
  }
}
```
Add the import at top: `import { reserveMinutesOrCredits, refundReservation } from "@/lib/minute-credits";`

- [ ] **Step 4: Make the refund sites bucket-aware**

In `refundReservedClip` (~L869-881) replace the `refundMinutes(...)` / `refundClipUsage(...)` body with:
```ts
await refundReservation(reservedUserId, { reservedMinutes: useMinuteQuota ? reservedMinutes : null, creditsSpent }, `render-refund:${jobId}`);
```
Do the same in the setup-error refund block (~L1097-1102). (Both already guard on `quotaReserved && reservedUserId`; keep those guards.)

- [ ] **Step 5: Record funding source on success + store on RenderJob**

At the `recordChargedClip` call (~L1028):
```ts
await recordChargedClip(userId, videoUrl, useMinuteQuota ? reservedMinutes : undefined, creditsSpent ?? undefined);
```
Where the RenderJob row is created for the queue path (wherever `reservedMinutes` is written onto the job), also write `creditsSpent`.

- [ ] **Step 6: Surface receipt data in the job/render status**

Wherever the render route returns/sets the job status the client polls, include `creditsSpent` and `creditBalanceAfter` (only non-null when credit-funded). If the status is read from `RenderJob`, ensure the status endpoint selects `creditsSpent` (balance can be recomputed client-side via the existing balance source, or carried through if convenient).

- [ ] **Step 7: Queue-path refund reads `creditsSpent`**

In `src/lib/render/job-store.ts`, change `refundJobReservation` to accept `creditsSpent` and route via the same logic:
```ts
async function refundJobReservation(
  job: { userId: string; reservedMinutes: number | null; creditsSpent: number | null },
  context: string
): Promise<void> {
  try {
    await refundReservation(job.userId, { reservedMinutes: job.reservedMinutes, creditsSpent: job.creditsSpent }, `queue-${context}`);
  } catch (e) { /* keep existing fail-open log */ }
}
```
Update its two callers (`supersedeScope`, `failRenderJob`) to select/pass `job.creditsSpent`. Import `refundReservation` from `@/lib/minute-credits` (replacing the direct `refundMinutes` import if now unused).

- [ ] **Step 8: Verify (tsc + suites + flag-off reasoning)**

Run: `npx tsc --noEmit` → 0 errors.
Run: `npx tsx scripts/verify-minute-enforcement.ts && npx tsx scripts/verify-minute-credits.ts && npx tsx scripts/verify-credit-overflow.ts` → all PASS.
Write the flag-off byte-identical proof (per the requirement above) into the task report.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/videos/render/route.ts src/lib/render/job-store.ts
git commit -m "feat(credits): overflow to credits at render reserve + bucket-aware refunds (CREDITS_LIVE)"
```

---

### Task 5: Status surfacing + balance route + frontend CTA/receipt/nudge (CORE — opus)

**Why:** Option A (silent auto-spend) is only acceptable *with a clear receipt* — otherwise it's an invisible charge. The genuine wall (out of minutes AND credits) needs a "buy credits" recourse. Task 4 *persists* `creditsSpent` but the status routes the client polls don't return it yet, and the queue path has no `creditBalanceAfter` on the DB row — so this task also adds the minimal status surfacing + a balance endpoint, then the UX. All client UX gated by `NEXT_PUBLIC_CREDITS_LIVE`; server additions are additive/flag-safe.

**creditBalanceAfter decision (from Task 4 review):** do NOT rely on `creditBalanceAfter` from the render status — the queue path doesn't carry it. Instead surface only `creditsSpent`, and have the client fetch the remaining balance from a new `GET /api/credits/balance`. Uniform across queue + legacy paths; sidesteps the asymmetry. (Mew: dedupe this balance route vs p2's P3.5 one on merge.)

**Files:**
- Modify: the render-STATUS route + the render-PROGRESS route the client polls (find them; the Task 4 report names them — render-status reads the `.tmp` job, render-progress reads `RenderJob` in the `RENDER_VIA_QUEUE` branch). Add `creditsSpent` to each response, **gated by `CREDITS_LIVE` so the response is byte-identical when off**.
- Create: `src/app/api/credits/balance/route.ts` — `GET`, auth-required, returns the caller's own `getBalance(userId)`.
- Modify: `src/app/(dashboard)/video-creator/page.tsx` (`friendlyError` ~707-760; render catch ~1284-1305; job-complete handler)
- Modify: `src/app/(dashboard)/video-editor/page.tsx` (mirror)

**Interfaces:**
- Consumes: 403 body `error.code === "quota_exceeded"` + optional `error.canBuyCredits` (Task 4); job status now carries `creditsSpent` (this task); existing `POST /api/payments/credits` (`{ pack }` → `{ url }`); `getBalance` from `@/lib/credits`.
- Produces: `GET /api/credits/balance` → `{ granted, purchased, total }`; client UX.

**Flag-off requirement:** with `NEXT_PUBLIC_CREDITS_LIVE` unset, both pages are byte-identical (no CTA, no receipt, no balance fetch); the quota wall shows today's message. With `CREDITS_LIVE` unset, the status routes return their original JSON verbatim (the `creditsSpent` field is added only when `CREDITS_LIVE==="1"`).

- [ ] **Step 1: Surface `creditsSpent` in the render-status route**

Read the Task 4 report (`/Users/mewsocialmacmini/projects/AI_content_Mew_social/.superpowers/sdd/task-4-report.md`) for the exact route file + the `.tmp` job fields. Add `creditsSpent` to the JSON it returns, gated so the field is present ONLY when credits are live:
```ts
...(process.env.CREDITS_LIVE === "1" ? { creditsSpent: job.creditsSpent ?? null } : {}),
```

- [ ] **Step 2: Surface `creditsSpent` in the render-progress (queue) route**

In the `RENDER_VIA_QUEUE` branch, add `creditsSpent` to the `RenderJob` `select` and to the returned JSON, gated identically (`...(CREDITS_LIVE==="1" ? { creditsSpent: row.creditsSpent ?? null } : {})`).

- [ ] **Step 3: Minimal balance route**

Create `src/app/api/credits/balance/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { getBalance } from "@/lib/credits";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const bal = await getBalance(user.id);
  return NextResponse.json(bal); // { granted, purchased, total }
}
```
(Confirm the auth import matches how other `src/app/api/credits|payments` routes get the user — mirror an existing one.)

- [ ] **Step 4: Frontend — buy-credits wall CTA**

In `video-creator/page.tsx` `friendlyError` (~707-760), after extracting `structuredErr`, gated:
```ts
const creditsLiveClient = process.env.NEXT_PUBLIC_CREDITS_LIVE === "1";
if (creditsLiveClient && structuredErr?.code === "quota_exceeded" && (structuredErr as { canBuyCredits?: boolean }).canBuyCredits) {
  setOutOfMinutes(true); // new state, default false; renders [ซื้อเครดิต] button → buyCredits()
}
```
Add `const [outOfMinutes, setOutOfMinutes] = useState(false);` and:
```ts
async function buyCredits(pack: "starter" | "popular" | "pro" = "popular") {
  const res = await fetch("/api/payments/credits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pack }) });
  const data = await res.json();
  if (data?.url) window.location.href = data.url;
}
```
Render the CTA in the `renderProgressError` UI, only when `outOfMinutes`.

- [ ] **Step 5: Frontend — receipt toast (fetch balance, not status)**

In the job-complete handler, when `creditsLiveClient` and the completed status has `creditsSpent > 0`:
```ts
const spent = status.creditsSpent;
let left: number | null = null;
try { const b = await fetch("/api/credits/balance").then(r => r.ok ? r.json() : null); left = b?.total ?? null; } catch {}
toast(`ใช้ ${spent} เครดิต (฿${spent})${left != null ? ` · เหลือ ${left} เครดิต` : ""}`);
if (left != null && left < 20) toast("เครดิตใกล้หมด เติมเลยไหม?", { action: { label: "ซื้อเครดิต", onClick: () => buyCredits() } });
```
(Use the page's existing toast/notification primitive — match the surrounding code; snippet shows intent.)

- [ ] **Step 6: Mirror in video-editor**

Apply Steps 4-5 (`outOfMinutes` CTA + receipt + `buyCredits`) to `video-editor/page.tsx`, gated identically.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` → 0 errors.
Confirm by reading: with `NEXT_PUBLIC_CREDITS_LIVE` unset every client branch is dead (no CTA, no toast, no balance fetch) → pages byte-identical; with `CREDITS_LIVE` unset the status routes omit `creditsSpent` → byte-identical JSON. State both proofs in the task report. (Screenshots blocked in this env — view live after merge per Mew.)

- [ ] **Step 8: Commit**

```bash
git add "src/app/api/credits/balance/route.ts" "src/app/(dashboard)/video-creator/page.tsx" "src/app/(dashboard)/video-editor/page.tsx" <the two status route files>
git commit -m "feat(credits): status creditsSpent + balance route + out-of-minutes CTA/receipt (CREDITS_LIVE/NEXT_PUBLIC_CREDITS_LIVE)"
```

---

## Final whole-branch review (after Task 5)

Opus whole-branch review with: money-safety (no leak / no double-spend / no double-refund across all 3 render-refund sites + queue path), exactly-once (credit OR minute, never both; reuse `ChargedClip` once-per-video marker), flag-off byte-identical across `MINUTE_QUOTA`×`CREDITS_LIVE`×`NEXT_PUBLIC_CREDITS_LIVE`, and the round-to-nearest change. Then one fix-wave. Update `.superpowers/sdd/progress.md`. Present to Mew (she rebases/merges/deploys; dedupe `refundCredits` vs p2). Add a minutes-mode + credits-mode queue-refund test before go-live (carried).

## Self-Review

- **Spec coverage:** UX=A silent auto-spend (Task 4 reserve + Task 5 receipt) ✓; round-to-nearest one-system (Task 1) ✓; bucket-aware refund (Tasks 2-4) ✓; wall buy-credits CTA (Task 5) ✓; conversion 2cr/min via `creditCostFor` ✓; gating MINUTE_QUOTA+CREDITS_LIVE+NEXT_PUBLIC_CREDITS_LIVE ✓; queue path ✓. Avatar/boundary/exact-refund explicitly deferred ✓.
- **Placeholders:** lib code is complete (Tasks 1-3); route/UI steps give exact sites + snippets + a flag-off proof requirement (matches the project's route-testing convention — routes are tsc+reasoning, libs are TDD'd).
- **Type consistency:** `ReserveResult.via` discriminator, `creditsSpent`/`reservedMinutes` nullable threading, `recordChargedClip` 4-arg signature, and `refundReservation({reservedMinutes, creditsSpent})` shape are consistent across Tasks 2→3→4.
