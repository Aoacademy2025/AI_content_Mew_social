# Pricing Rework — P3.4: Wire credit-SPEND (make credits LIVE)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Base branch: NEW `mew/pricing-rework-p2` off `mew/pricing-rework-p1` HEAD (8ad2a0c). Rebase onto main after Mew merges p1 (same pattern as the security rebase).
> **SCOPE (Mew, 2026-06-25): IMAGES ONLY this round — Task 1 + Task 2.** Task 3 (overflow-minutes via credits) is DEFERRED (it touches the live voice billing path); do only as a fast-follow if asked.

**Goal:** Turn the INERT credit foundation (P3.1/P3.2) into a working spend engine: spend credits on AI-gen (existing kie image) and on overflow minutes, with atomic refund-on-failure — all behind a new `CREDITS_LIVE` flag (default OFF = byte-identical to today).

## Scope decision (from the AI-gen surface map, 2026-06-25)
- ✅ `gpt-image-2-text-to-image` ALREADY exists in `fetch-stock` `KIE_IMAGE_MODELS` — no provider-add needed, only cost-mapping.
- ⛔ **Seedance AI-VIDEO does not exist** — there is NO video generation anywhere; only text-to-image. "Add Seedance" = a net-new feature (new kie video model + input shape + result/stitch handling), NOT a provider-add. **DEFERRED to its own phase** (see LATER). Credits go live without it. Cost keys `video-seedance-*` stay reserved.
- Current image gen is hardcoded **9:16, 1K** only → cost maps to the `image-*-1k` keys; 2K+ keys stay reserved until the input builder exposes resolution.

**Architecture:**
- New env flag `CREDITS_LIVE` (`process.env.CREDITS_LIVE === "1"`, mirrors `MANAGED_GEMINI`). OFF → no spend path runs anywhere; behavior byte-identical.
- `src/lib/credits.ts` (NOT the SSRF file — safe to extend): `spendCredits` returns the bucket split; new `refundCredits` restores exactly those buckets; `costKeyForKieModel` / `creditCostForKieModel` map a kie model → cost.
- `fetch-stock/route.ts` (SSRF file — **ADDITIVE ONLY**): per generated kie clip, when `CREDITS_LIVE`, spend before gen + refund on that clip's failure. Both call sites (main kie loop + auto-mix fallback). OFF-flag = today's admin-only, no-spend path untouched.
- `tts-gemini/route.ts`: opt-in `allowCreditOverflow` (default false). When `reserveMinutes` is capped AND `CREDITS_LIVE` AND opted-in → spend `minutes × 2cr` instead of `409`. Never silent.
- Telemetry: `credit_spend` / `credit_refund` / `credit_overflow` (mirror `minute_reserve`).

## Global Constraints
- Additive only. `fetch-stock` changes wrap the gen calls ONLY — no touch to fetch/URL/SSRF logic (reviewer gate).
- All new behavior behind `CREDITS_LIVE`. Flag OFF must be byte-identical → verifiable.
- Tests via `scripts/verify-*.ts` (`npx tsx`, throwaway SQLite). Route logic extracted into testable libs; the big routes themselves verified by `tsc` + reasoning + Mew's render-QA gate (consistent with how minute/clip reserve in routes are untested but their libs are).
- Overflow is **opt-in only**; never auto-drain purchased credits.
- v1 overflow = all-or-nothing for the single boundary clip (forfeits ≤max-clip free minutes on the one call that crosses the cap). Documented; refine later.

---

### Task 1: credits.ts — refund + bucket-split spend + kie cost mapping (conflict-free; NOT the SSRF file)

**Files:** Modify `src/lib/credits.ts`; Test `scripts/verify-credit-spend.ts`.

**Interfaces (later tasks consume):**
- `spendCredits(...)` success return gains `fromGranted: number; fromPurchased: number` (additive — existing callers unaffected).
- `refundCredits(userId, fromGranted, fromPurchased, action): Promise<void>` — increments each bucket back, writes a `kind:"refund"` ledger row with `balanceAfter`. No-op guard if both are 0.
- `costKeyForKieModel(model: string): string` — `gpt-image-2-text-to-image`→`image-gpt-1k`; `nano-banana-pro`/`nano-banana-2`→`image-nano-1k`; all other current models (`seedream/*`, `flux-2/pro`, `grok-imagine`, `qwen2`)→`image-nano-1k` (default until individually priced).
- `creditCostForKieModel(model): number = creditCostFor(costKeyForKieModel(model))`.

- [ ] **Step 1:** extend `spendCredits` success path to return `fromGranted`/`fromPurchased` (already computed internally at lines 187-188). Additive to the return type.
- [ ] **Step 2:** add `refundCredits` — upsert the row, `data:{ granted:{increment:fromGranted}, purchased:{increment:fromPurchased} }`, then a `creditLedger.create` (`kind:"refund"`, `delta: fromGranted+fromPurchased`, `action`, `balanceAfter`). Throw nothing if total 0 (just return).
- [ ] **Step 3:** add `costKeyForKieModel` + `creditCostForKieModel` with the mapping above. Comment that current gen is 1K-only so 1k keys apply.
- [ ] **Step 4:** write `scripts/verify-credit-spend.ts` (boilerplate from `verify-credits.ts`) asserting:
  - spend split: granted 50 / purchased 100, spend 70 → `{ok:true, fromGranted:50, fromPurchased:20}`, balances 0 / 80.
  - refund restores exact buckets: after that spend, `refundCredits(u, 50, 20, "x")` → granted 50, purchased 100 (net zero).
  - spend-then-refund writes 2 ledger rows (`spend` then `refund`); `refundCredits(u,0,0,"x")` writes none and is a no-op.
  - `creditCostForKieModel("gpt-image-2-text-to-image")===3`, `("nano-banana-2")===4`, `("seedream/4.5-text-to-image")===4` (default), `("flux-2/pro-text-to-image")===4`.
  Run → fail → implement → `npx tsx scripts/verify-credit-spend.ts` pass + `npx tsc --noEmit` 0 err. Commit `feat(credits): refundCredits + bucket-split spend + kie model cost mapping`.

---

### Task 2: fetch-stock — gate kie-image gen behind credits (ADDITIVE, SSRF-careful)

**Files:** Modify `src/app/api/videos/fetch-stock/route.ts` (gen call sites ONLY).

- [ ] **Step 1:** import `spendCredits, refundCredits, creditCostForKieModel` from `@/lib/credits`; `const creditsLive = process.env.CREDITS_LIVE === "1"`.
- [ ] **Step 2:** main kie-image loop (~1494-1558), both download and dry-run branches: when `creditsLive`, before `generateKieImageKenBurns` / `kieCreateTask`, `const spend = await spendCredits(userId, creditCostForKieModel(resolvedKieModel), "ai-image")`. If `!spend.ok` → skip this clip (log + `noCandidateKeywords++`, do NOT generate). Wrap the existing gen in a try/catch whose catch ALSO calls `refundCredits(userId, spend.fromGranted, spend.fromPurchased, "ai-image-refund").catch(()=>{})` before the existing error handling.
- [ ] **Step 3:** mirror the same spend/refund wrap in the auto-mix kie-fallback loop (~2070-2120).
- [ ] **Step 4:** fire `credit_spend` / `credit_refund` telemetry (mirror `minute_reserve`). `npx tsc --noEmit` 0 err. Manually confirm: with `CREDITS_LIVE` unset, NO spend code runs (admin gen path identical to today). Commit `feat(credits): gate kie AI-image behind credit spend + refund (CREDITS_LIVE)`.
- ⚠️ Reviewer gate: diff must be additive around the gen calls only — zero changes to fetch/URL/SSRF logic.

---

### Task 3: tts-gemini — overflow minutes via credits (opt-in)

**Files:** Create `src/lib/minute-credits.ts`; Modify `src/app/api/videos/tts-gemini/route.ts`; Test `scripts/verify-minute-credits.ts`.

**Interface:** `reserveMinutesOrCredits(userId, minutes, opts:{ allowCreditOverflow:boolean; creditsLive:boolean }): Promise<{ allowed:boolean; via:"minutes"|"credits"|"none"; remaining?:number; message?:string; creditsSpent?:number }>`.
Logic: `reserveMinutes(userId, minutes)`; if allowed → `{allowed:true, via:"minutes", remaining}`. Else if `creditsLive && allowCreditOverflow` → `spendCredits(userId, minutes*creditCostFor("minute"), "minute-overflow")`; ok → `{allowed:true, via:"credits", creditsSpent}`; not ok → `{allowed:false, via:"none", message}`. Else → `{allowed:false, via:"none", message}`.

- [ ] **Step 1:** write `scripts/verify-minute-credits.ts` asserting: within quota → `via:"minutes"`; over quota + opted-in + enough credits → `via:"credits"`, `creditsSpent=minutes*2`, minutes meter NOT incremented; over quota + not opted-in → `via:"none"`; over quota + opted-in + insufficient credits → `via:"none"`. Run → fail.
- [ ] **Step 2:** implement `src/lib/minute-credits.ts` (imports `minute-limits` + `credits`). Pass.
- [ ] **Step 3:** in `tts-gemini/route.ts`: parse `allowCreditOverflow` (default false) from the body; at BOTH reserve sites (~425, ~451) replace `reserveMinutes(...)` + its `!allowed` 409 with `reserveMinutesOrCredits(authUser.id, minutes, { allowCreditOverflow, creditsLive: process.env.CREDITS_LIVE==="1" })`; keep the existing `409 QUOTA_MINUTES` on `!allowed`. Fire `credit_overflow` telemetry when `via==="credits"`.
- [ ] **Step 4:** `npx tsc --noEmit` 0 err; confirm flag-off / not-opted-in path is byte-identical (still reserves minutes, still 409). Commit `feat(credits): opt-in minute overflow via credits in tts-gemini (CREDITS_LIVE)`.

---

### Final review (whole-branch, opus)
- All 3 suites + the 6 existing green; `tsc` clean; `CREDITS_LIVE` OFF verified byte-identical; fetch-stock diff additive-only (SSRF); money paths atomic (spend/refund mirror the clip/minute reserve pattern); overflow never silent.

### LATER (out of P3.4 scope)
- **Seedance AI-VIDEO** — net-new feature (no video gen exists today). Its own plan.
- **2K/4K/8K image tiers** — expose resolution in `buildKieImageInput`, then map to `image-*-2k+` cost keys.
- **Buy-credits UI + balance surface** (NEXT WORK #2) — `/api/payments/credits` packs (199/499/999) + `getBalance` chip; frontend handles `409`/insufficient with a buy CTA.
- **P3.3** monthly granted reset on renewal (cron + webhook) — `resetMonthlyGranted`. Needed (with grant-on-subscribe) before flipping `CREDITS_LIVE` for real users.
- Frontend: send `allowCreditOverflow` + show "this uses N credits" consent before overflow.
