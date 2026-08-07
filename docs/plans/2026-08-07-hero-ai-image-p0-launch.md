# Hero AI Image — P0 Public-Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 5 P0 items + trial taste grant from `docs/audits/2026-08-07-hero-ai-image-public-launch-readiness.md` (rev.3) so Hero AI Image can open to all PRO/BUSINESS/Trial users, priced at **2 credits/image (Option B — Mew signed off 2026-08-07)**.

**Architecture:** All work lands on ONE new branch off `origin/main` in a fresh worktree (the current checkout carries uncommitted hero-voice work — never touch it). Image generation converges on the existing RunPod hero seam `generateHeroImageForVideo` (durable jobs, idempotency, refunds already proven on prod); kie paths are paused behind admin, not deleted (ADR 0004 still holds: no cross-fallback). Launch itself = env flag flip after deploy, not part of this plan.

**Tech Stack:** Next.js 15 App Router, Prisma/SQLite, verify-script test pattern (`scripts/verify-*.ts` on throwaway SQLite via `tsx`).

## Decisions this plan implements (all Mew-approved 2026-08-07 — do not re-ask)

| # | Decision |
|---|---|
| B | Hero AI Image price **3cr → 2cr/รูป** (`image-open-custom-1k`). COGS verified ฿0.19/รูป (`docs/research/2026-08-07-runpod-custom-billing.md`) |
| 7 | Hero-only image stack: AutoMix AI slots + per-window regen run on the RunPod hero seam; kie paused behind admin |
| 8 | Image-count control: Hero default = **กำหนดเอง 8 รูป** (auto = opt-in); AutoMix shows its AI count + credits before render |
| b | Trial taste grant: **10cr one-time** at trial start |
| caps | Hero-path rate limits: **20 รูป/ชม./ผู้ใช้, 120 รูป/วัน/ผู้ใช้** |
| gate | Hero path requires paid plan (PRO/BUSINESS, incl. active trial); public rollout via env flag `HERO_AI_IMAGE_PUBLIC=1` through the existing `isInternalAiBetaEnabledFor(actor, publicEnabled)` seam |

Reference (don't restate): audit rev.3 §5 (migration map), §6 (taste grant), §8 (P0 list) · CONTEXT.md §AI Generation · ADR 0004.

## Global Constraints

- **Base = `origin/main`** (`46cfe37a` at planning time). Branch: `mew/hero-image-public-p0`. Work in a fresh worktree; the main checkout (branch `mew/hero-voice-emotion-rig`, dirty) must not be modified.
- Fresh worktree needs `.env` copied from the main checkout + `npx prisma generate` before anything runs (known gotcha).
- `main` = production. No direct pushes; final output is a PR. Mew merges + deploys.
- Credits are integers; every charge path must disclose before spending; failed generation must refund (existing seam guarantees this — do not bypass it).
- Thai user-facing strings, English code/comments. Follow existing code style.
- Each task: `npm run build` must pass + targeted verify scripts green before review.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 0 | Worktree + branch setup | (session) | inline | — | — |
| 1 | Reprice 2cr + fix quote estimate | mew-worker | subagent | 0 | build+verify, mew-reviewer |
| 2 | AutoMix AI + per-window regen → hero seam; kie behind admin | mew-worker-heavy | subagent | 1 | build+verify, mew-reviewer |
| 3 | Reserved-credit sweeper (cron) | mew-worker-heavy | subagent | 1 | build+verify, mew-reviewer |
| 4 | Plan gate + rate caps + public flag | mew-worker | subagent | 2 | build+verify, mew-reviewer |
| 5 | Disclosure UX (defaults, totals, disable, CTA) | mew-worker | subagent | 2, 4 | build+verify, mew-reviewer |
| 6 | Trial taste grant 10cr | mew-worker | subagent | 1 | build+verify, mew-reviewer |
| 7 | Integration: full verify suite + security review + PR | (session) + mew-reviewer | inline+subagent | 1-6 | /security-review, final gate |

(3 and 6 are file-disjoint from 2/4/5 but run in the same worktree — dispatch them in the gaps between dependent tasks, never two agents in the worktree at once.)

---

### Task 0: Worktree + branch setup (session)

- [ ] `git worktree add /private/tmp/heroai-p0-worktree -b mew/hero-image-public-p0 origin/main`
- [ ] Copy `.env` from the main checkout into the worktree; run `npm install` if needed (or reuse node_modules via symlink only if the repo tooling allows) + `npx prisma generate`.
- [ ] Sanity: `npm run build` passes on the untouched base.

### Task 1: Reprice 2cr + fix quote estimate

**Files (worktree, based on origin/main):**
- Modify: `src/lib/credit-costs.ts` — `"image-open-custom-1k": 3` → `2`
- Modify: `src/lib/image-generation-provider.server.ts` (~line 105) — the z-image custom-route estimate default `50_000` µUSD → `10_000` (real cost ≈ 5,200 µUSD, ~2× headroom). Keep the env-override mechanism (note its env var name in the task report).
- Check/Update: any verify script or UI copy asserting 3cr (`grep -rn "3 เครดิต" src/ scripts/`; `HERO_AI_IMAGE_CREDITS` consumers auto-update — only literal "3" strings need touching).

**Interfaces:**
- Produces: `HERO_AI_IMAGE_CREDITS === 2` and `describeHeroImageOffer().quote.credits === 2` with `isAiImageQuoteCostSafe` passing on the custom route (budget at 2cr = 38,888 µUSD > estimate 10,000).

**Steps:**
- [ ] Read the two files first; make the changes above.
- [ ] Extend/author a verify script (pattern: throwaway SQLite via `tsx`, see existing `scripts/verify-*.ts`) asserting: cost-key = 2, quote credits = 2, quote cost-safe = true at the new estimate, and a reserved job charges exactly 2 credits and refunds exactly 2 on failure.
- [ ] `npm run build` + run the verify script. Commit.

### Task 2: AutoMix AI + per-window regen → hero seam; kie behind admin

**Files (worktree — READ each on origin/main first; the session's earlier audit described the pre-branch versions and line numbers will differ):**
- Modify: `src/app/api/videos/fetch-stock/route.ts` — the AutoMix branch's `"ai"` slots (planned by `planAutoMixSources`) currently generate via kie (`generateKieImageKenBurns`, managed-kie gate). Rewire non-admin AI slots to `generateHeroImageForVideo` (idempotencyKey `video:<videoJobId>:automix:<sourceIndex>` — a DIFFERENT namespace from the hero mode's `:scene:` so the two modes never collide), charged at the hero cost key. Keep Ken Burns post-processing identical. Admin BYOK-kie path may remain admin-only.
- Modify: `src/app/api/videos/broll-window/generate/route.ts` — swap the kie model call for the hero seam (single model z-image-turbo, 2cr), idempotencyKey `video:<videoJobId>:window:<windowIndex>:<attempt>`; preserve the existing charge/refund contract of this route.
- Modify: `src/app/api/videos/jobs/route.ts` — AutoMix with AI slots must no longer require `canUseKieImages`; it follows the same hero gate as Hero mode (Task 4 centralizes that gate — here just route AutoMix AI eligibility onto the hero seam's availability).
- Modify: `src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx` — replace the 3-model kie chip row with one Hero AI Image option showing `2 เครดิต` (derive from `HERO_AI_IMAGE_CREDITS`, no literal); keep the 402→"ดูแพ็กเกจ" surface. kie models render only for admins.
- Check: `src/app/(dashboard)/video-editor/_v2/receipt.ts` / `estimate.ts` — AutoMix estimate must price AI slots at `HERO_AI_IMAGE_CREDITS` and use the planner's slot count (fixes the documented 24-vs-21 drift while the numbers are being touched).

**Interfaces:**
- Consumes: `generateHeroImageForVideo` (unchanged signature) and Task 1's 2cr quote.
- Produces: no non-admin request path reaches kie for images anywhere; AutoMix AI slots and per-window regen both quote, charge, and refund through the hero seam.

**Steps:**
- [ ] Read the current origin/main versions of every file above end-to-end before editing.
- [ ] Implement in the order listed; after each file, `npm run build`.
- [ ] Verify script: simulate an AutoMix plan (15 pieces, weights 3:2:1) → assert exactly 3 AI slots priced 2cr each, reserved via the hero seam, refunded on injected provider failure; assert a per-window regen charges 2 and refunds on failure; assert a non-admin request can never produce a kie provider call (grep-level assert on the request builder or a spy/stub).
- [ ] Run existing suites that cover this area: `npm run verify:render-receipt`, subtitle-invariant and quota/credit verify scripts if present in `package.json`. Commit.

### Task 3: Reserved-credit sweeper (cron)

**Files:**
- Create: `src/app/api/cron/reconcile-ai-images/route.ts` (follow the structure/auth of `src/app/api/cron/reconcile-processing/route.ts`: CRON_SECRET check, dryRun param, heartbeat)
- Modify: `src/lib/ai-generation-jobs.server.ts` — add `sweepStaleReservedImageJobs({olderThanMinutes, limit})`
- Modify: `ecosystem.config.js` — add cron app entry (mirror existing cron pattern; note in PR that Mew starts it manually with CRON_SECRET per CLAUDE.md)

**Behavior spec:**
- Target: `AiGenerationJob` `kind='image'`, `chargeState='reserved'`, `updatedAt` older than 30 minutes.
- For each (cap 50/run): if it has a `providerJobId`, poll RunPod once via the existing attempt-poll helper — COMPLETED → settle exactly as the normal path does (persist output if retrievable; else refund with code `SWEEP_OUTPUT_LOST`); terminal failure/unknown/no providerJobId → `failAndRefundAiJob` with code `SWEEP_STALE_RESERVED`.
- Idempotent: re-running never double-refunds (the existing `chargeState` transition guards already ensure this — keep all mutations inside those helpers, never raw balance writes).

**Steps:**
- [ ] Read `reconcile-processing/route.ts`, `ai-generation-jobs.server.ts`, and the poll helper in `image-generation-provider.server.ts` first.
- [ ] Implement; verify script: seed a temp DB with reserved-stale, reserved-fresh, settled, and refunded jobs → run sweep → assert exactly the stale-reserved rows are refunded once (balances restored to the exact granted/purchased buckets), fresh/settled/refunded untouched, second run is a no-op.
- [ ] `npm run build` + verify. Commit.

### Task 4: Plan gate + rate caps + public flag

**Files:**
- Modify: `src/lib/internal-ai-access.ts` — hero image eligibility becomes: `isHeroAiBetaUser(actor) || (process.env.HERO_AI_IMAGE_PUBLIC === "1" && isPaidPlanActor)`. Add one helper (e.g. `isHeroAiImageEligible(actor: {email, role, plan, trialEndsAt})`) so both routes share it; active trial (plan PRO + future trialEndsAt) counts as paid. FREE stays excluded even with credits.
- Modify: `src/app/api/videos/jobs/route.ts` + `src/app/api/videos/fetch-stock/route.ts` — replace the two `isHeroAiBetaUser` checks with the new helper; 403 copy for FREE: `Hero AI Image ใช้ได้กับแผน PRO/BUSINESS — อัปเกรดเพื่อใช้งาน` (+ `upgradeUrl: "/pricing"` field).
- Create: `src/lib/hero-image-rate-limit.ts` — per-user sliding caps **20 images/hour, 120 images/day**, counted against `AiGenerationJob` rows (`kind='image'`, createdAt window, all chargeStates — refunded attempts still count) so it works across processes without new tables. Enforced in fetch-stock (both hero mode and AutoMix AI slots) and broll-window/generate BEFORE reserving credits; 429 with Thai message stating when to retry.

**Interfaces:**
- Produces: `isHeroAiImageEligible` used by every hero entry point; `HERO_AI_IMAGE_PUBLIC` is the single launch switch (unset = beta allowlist behavior unchanged).

**Steps:**
- [ ] Read current gate sites; implement helper + wire both routes + limiter.
- [ ] Verify script: matrix of {ADMIN, allowlisted USER, PRO, PRO-trial, FREE} × {flag on/off} → assert allow/deny per the table above; rate limit: seed 20 jobs in the last hour → 21st denied 429; seed 120 in a day → denied; refunded rows count toward the cap.
- [ ] `npm run build` + verify. Commit.

### Task 5: Disclosure UX

**Files:**
- Modify: `src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx`:
  - Hero AI Image selected → default `targetClipCount = 8` (mode "กำหนดเอง"; "อัตโนมัติ (1 รูป/ช่วง)" becomes the explicit opt-in with its estimated count shown).
  - Source card + count hint show the TOTAL: `~{n} รูป × {HERO_AI_IMAGE_CREDITS} = {total} เครดิต` (no literal prices).
  - AutoMix preset "AI เด่น" gets its credit line (derive from planner math × `HERO_AI_IMAGE_CREDITS`); admin card names the same price as the customer card.
  - Count picker hint: `รูปละ ~{Math.round(durationSec/n)} วิ` when n makes holds exceed ~12s.
- Modify: `src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx` — when the receipt computes a credit deficit, `เริ่มเรนเดอร์` is disabled with the deficit line + a `เติมเครดิต` link to `/pricing?from=editor`.
- Modify: `src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx` — the render-failure view: when the failure message carries `INSUFFICIENT_CREDITS` (or the 402 marker from fetch-stock), render a dedicated Thai explanation + `เติมเครดิต` button instead of the raw pipeline string.

**Steps:**
- [ ] Read the current components; implement. All price strings derive from `HERO_AI_IMAGE_CREDITS`.
- [ ] `npm run build`; extend the quota-credit UI verify script if it asserts editor strings. Manual QA checklist for Mew appended to the PR description (default=8, totals visible, disabled button, 402 CTA).
- [ ] Commit.

### Task 6: Trial taste grant 10cr

**Files:**
- Modify: `src/lib/trial.ts` — inside `grantTrial` success path: `grantCreditsOnce(userId, 10, "trial-taste:" + userId)` (exact existing helper, credits.ts:160 on origin/main; its unique-ref check + `UsedTrialEmail` re-trial dedup are the abuse guards).
- Check: `src/lib/credits.ts` `ensureMonthlyGrant` early-returns for active trials (line ~444) — the taste grant must NOT be wiped by that path (it isn't: early-return skips writes) and must be superseded naturally by `grantOnPaidActivation` on conversion. Assert both in the verify script, don't assume.

**Steps:**
- [ ] Read `trial.ts` + `credits.ts` grant paths; implement.
- [ ] Verify script: new trial → balance 10 granted; repeat grant → still 10 (once-only); convert to paid → balance = plan grant per existing semantics; expiry → follows existing trial-expiry credit behavior (assert current behavior, whatever it is, and print it in the task report for the PR notes).
- [ ] `npm run build` + verify. Commit.

### Task 7: Integration (session)

- [ ] Run the full verify set named in `package.json` + `npm run build` in the worktree.
- [ ] Dispatch `mew-reviewer` over the whole branch diff vs origin/main (spec = this plan).
- [ ] Run `/security-review` (credits/payments/user-input touched: Tasks 2, 3, 4, 6).
- [ ] Open PR `mew/hero-image-public-p0` → `main`, body: audit link, decision table, per-task verify evidence, Mew's manual QA checklist, launch runbook line: deploy → set `HERO_AI_IMAGE_PUBLIC=1` + `pm2 restart ai-content --update-env` → start `reconcile-ai-images` cron with CRON_SECRET → post `/updates` (isPinned) → watch dashboard.
- [ ] Update this plan's Status + memory. Mew merges + deploys (convention).

## Acceptance Criteria

- [ ] Hero AI Image charges exactly 2cr/รูป end-to-end (quote, card, receipt, ledger) with cost-safety passing.
- [ ] No non-admin image request can reach kie on any path; AutoMix AI slots + per-window regen generate via the RunPod hero seam with refund-on-failure proven by verify scripts.
- [ ] Stale reserved credits are swept + refunded within ~30 min; sweeper idempotent (verify script evidence).
- [ ] Eligibility matrix enforced (paid + trial, FREE excluded) and `HERO_AI_IMAGE_PUBLIC=1` is the only switch needed at launch; 20/hr + 120/day caps active on every hero entry point.
- [ ] Hero default = กำหนดเอง 8 รูป; total credits visible before start on every path; start button disabled on deficit; 402 surfaces carry a เติมเครดิต CTA.
- [ ] Trial accounts start with exactly 10 granted credits, once ever.
- [ ] Full build + verify suite green; security review findings resolved; PR open with QA checklist.

## Out of scope

- Flipping `HERO_AI_IMAGE_PUBLIC` on prod / deploying (Mew's runbook step after merge).
- AI video gen (D4), Hero AI Voice, monitoring dashboard (P1-9), GeneratedImage 33-row discrepancy.
- Deleting kie code (paused behind admin only — ADR 0004).

## Status

interviewed 2026-08-07 (decisions inherited from readiness audit; Option B signed off "เคราะ option B") | approved: pending | executed: - | delivered: -
