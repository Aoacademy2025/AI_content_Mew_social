# HERO Pricing Rework — Overnight Report (2026-06-26)

> **For Mew, first thing.** Everything below is on branch **`mew/pricing-rework-p2`** — **committed, NOT pushed, NOT deployed, all behind flags that are OFF**. Your stable production is untouched. Nothing here is live until you decide.

---

## TL;DR
1. Built the **credit system end-to-end** (spend on AI-image · earn via monthly grant · buy packs · surfaced on pricing/settings) — 100% behind `CREDITS_LIVE` / `NEXT_PUBLIC_CREDITS_LIVE` (off).
2. Ran a **5-agent audit + consistency sweep** of all the rework.
3. **Fixed** the clear, *safe* bugs (money-security + 2 credit/minute leaks) — all in dormant flag-gated paths, can't affect prod today.
4. **Flagged** the bigger / riskier / judgment items for your call (§3). I did **not** touch the stable core for those — per your "warn before risky" rule.
5. Earlier: fixed a real deploy-blocker — the FREE-tier `watermark.png` asset was untracked (code shipped without it); now committed.

**One thing matters most → read §3 #1 first.** It changes your deploy plan.

---

## 1. Built + verified ✅

Branch `mew/pricing-rework-p2` (off `p1` + the watermark fix). All behind flags (default off → byte-identical to today).

**P3.4 — credit SPEND (images):** charge credits per AI-image gen (gpt-image-2 = 3cr, Nano Banana = 4cr) + refund on *every* failure path (incl. the invalid-mp4 case an audit caught). `src/lib/credits.ts` (`spendCredits`/`refundCredits`/cost map) + `fetch-stock` gating.

**P3.5 — credit EARN + surface:**
- Monthly grant PRO 50 / BIZ 150 on subscribe + lazy 30-day reset (no new cron) — `ensureMonthlyGrant`.
- Buy-credits UI + balance in Settings → billing (packs ฿199/499/999) — flag-gated, live settings page untouched when off.
- Minutes-per-plan + credit packs surfaced on `/pricing` + homepage (flag-gated).

**Verification:** `tsc --noEmit` 0 errors · credit suites **109 checks green** (grant 14 + credits 39 + packs 27 + spend 29). Every task passed an implementer→reviewer gate; each phase got a final opus whole-branch review.

---

## 2. Bugs found + fixed (safe — dormant flag-gated paths) ✅

All verified (tsc + suites + opus review), all additive, all inert in prod because the flags are off:
- **Webhook money-security:** only grant credits when `payment_status === "paid"` **and** the user exists (was: would grant on an unpaid PromptPay session / to an unvalidated id) + `CREDITS_LIVE` guard + refresh monthly credits on `invoice.paid` renewal.
- **TTS minute-leak:** minutes were reserved before `saveWav`; if the write throws (disk-full is real on this VPS) they weren't refunded → now refunded on the failure path.
- **credits checkout:** clean 400 on a bad request body (was 500).

---

## 3. 🚩 YOUR DECISIONS (morning) — prioritized

### 🔴 #1 — Flipping `MANAGED_GEMINI=1` alone will **not** unlock activation
**This is the big one — it changes the deploy plan.** The backend serves keyless users a managed Gemini key (good), **but the frontend still requires the user's *own* Gemini key.** Confirmed in code:
- `api-keys/status` reports `gemini: present(user.geminiKey)` — no managed awareness.
- `isTier1Complete = gemini && (pexels||pixabay)` — so a keyless user is "not ready" even with the managed flag on.
- `video-creator` / `video-editor` also hard-check `!user.geminiKey` and pop a "set your key" modal.

→ A keyless user gets blocked at the UI **before** the managed backend is ever reached. So the activation funnel stays blocked even after you flip the flag.
**My recommendation:** make key-status managed-aware in one place (`computeKeyStatus`/status route: when `MANAGED_GEMINI=1`, treat Gemini as satisfied) + update the 2–3 direct creation-flow gates. It's the core onboarding/creation flow + a UX choice (hide the Gemini row vs show "AI managed ✓"), so I left it for you. **I can implement it on your go** (~half a focused pass). **Do this before/with flipping `MANAGED_GEMINI`.**

### 🔴 #2 — `409 KEY_REQUIRED` shows "Unknown error" instead of the key modal
The managed/BYOK rework changed ~10 generation routes to return `409 {code:"KEY_REQUIRED"}`, but the editor/creator/preview branch on the *old* `missingKey` field → users see a meaningless "TTS: Unknown error" toast and no key-setup modal. **Masked when `MANAGED_GEMINI=1`** (managed key serves keyless users, so the 409 rarely fires). **Safe fix:** add `missingKey:<provider>` back into the 409 body so the existing modal detection works. Small. I can do it on your go (it's the core gen pipeline, so I flagged rather than auto-changed).

### 🟡 #3 — "clips" vs "minutes": dual quota + stale copy
Two quota systems run in parallel right now: the old **clip cap** (`reserveClipUsage` 2/100/300) **and** the new **minutes meter** (`reserveMinutes` 5/80/150). Decision needed: **which governs?** (Recommend: minutes is the meter; relax or retire the clip cap.) Then I'll sweep all the customer-facing "X คลิป/เดือน" copy → minutes (plan-config defaults, admin defaults, upgrade modals, video-editor upsell, /pricing nudges, the quota error message, MCP instructions). Tell me the rule and I'll do the copy sweep.

### 🟡 #4 — Homepage price line
`src/app/page.tsx:75` says **"เริ่ม ฿499/เดือน"**. New PRO monthly = ฿599 (฿499 is the *annual-equivalent* per month). Is that line intentional (annual framing) or stale? One-word answer → I fix or leave it.

### 🟡 #5 — "ใส่ key ฟรี" / BYOK copy is now wrong
With the managed key, users don't need their own Gemini key — but onboarding wizard, settings key-guide, the sale page, the docs page, error messages, and the MCP instructions all still say "Gemini key จำเป็น / ใส่ key ฟรี / ใช้คีย์ของคุณเอง." This is a cohesive "managed-path messaging" pass (make it conditional on `MANAGED_GEMINI`). Tied to #1. I can do it once you've decided the managed-path UX in #1.

### 🟢 Smaller (flagged, low priority)
- **`grantCreditsOnce`** dedup is check-then-act with no DB constraint (theoretical double-grant under truly-concurrent Stripe events; low risk). ⚠️ The "obvious" fix `@@unique([userId,action])` is **wrong** — it'd break the normal multi-row ledger. Needs a careful dedup design.
- **balance GET** does a write (lazy grant) on read — minor amplification; gated/dormant.
- **spendCredits** can falsely reject a split-bucket spend under concurrency (fail-closed, no money lost) — deferred a retry fix (don't want to add risk to the money lib without a concurrency test).
- **fetch-stock dry-run** refund hole is *latent* (can't happen today) — deferred (won't touch the SSRF file for a latent issue).
- Pre-existing (not mine): settings `loadPayments` has no `.catch`; a scroll-lock isn't reset on browser-back.

---

## 4. 📋 GO-LIVE CHECKLIST (when you're ready to turn credits on — not tonight)

**To deploy the branch (credits stay OFF):** merge `p1` → `p2` → main (your usual rebase), `bash deploy/deploy.sh` (db push syncs the new tables/columns — no migration needed). Nothing user-facing changes while flags are off.

**To actually turn credits live, in order:**
1. Resolve **#1** (managed-path UX) — otherwise activation stays blocked.
2. Resolve **#3** (clips vs minutes) + do the copy sweep (#3/#5).
3. Decide AI-image un-gate (it's admin-only today — credits have no user-facing spend path until you un-gate it OR I build the deferred overflow-minutes).
4. Do the deferred careful fixes (spendCredits retry; `ensureMonthlyGrant` before spend in fetch-stock; the invoice.paid/activatePlan ordering comment).
5. Set env: `CREDITS_LIVE=1`, `NEXT_PUBLIC_CREDITS_LIVE=1`, and `MANAGED_GEMINI=1`. ⚠️ **`NEXT_PUBLIC_CREDITS_LIVE` is baked at build time → you must REBUILD + restart, not just edit `.env` + `pm2 restart`.** (`CREDITS_LIVE` & `MANAGED_GEMINI` are runtime — restart is enough.)
6. `GEMINI_SERVER_KEY` must be set + prepaid-billed (it carries all managed users).

**Rollback:** unset the flags + rebuild/restart. Backup branch: `backup/pricing-p1-prerebase`.

---

## 5. Where things are
- **Branch:** `mew/pricing-rework-p2` (local; not pushed). P3.4+P3.5+fixes on top of `p1` + watermark.
- **Plans:** `docs/superpowers/plans/2026-06-25-pricing-rework-P3.4-credit-spend.md`, `…-P3.5-credit-earn-surfacing.md`.
- **Full task+audit ledger:** `.superpowers/sdd/progress.md` (every commit, finding, decision).
- **This report:** `docs/2026-06-26-overnight-report.md`.

**Net:** the credit system is built, tested, and safe-off; the audit's safe bugs are fixed; the rest is a short list of *your* calls (start with #1). Ping me and I'll knock out whichever you greenlight.
