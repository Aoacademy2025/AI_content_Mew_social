# Managed Image Gen Go-Live (D2–D5.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute work items 2–6 of `docs/pricing-ai-gen-decisions-2026-07-03.md` (decisions D2, D3, D5, D5.1 — see ADR 0002): open kie.ai image generation to paid users as a **managed, credit-metered** feature with a mandatory pre-render **Render Receipt** and a 3-button **Mix Preset** UX in Editor v2.

**Out of scope (next plan, per D6 order):** video gen benchmark + video gen path (items 7–8), per-window upgrade on timeline, Affiliate tracking. KVM8 upgrade + Editor-v2 flag flip are Mew's manual steps.

**Verified code facts (recon 2026-07-03 — do not re-derive):**
- Image gen today spends **zero credits**. `grep spendCredits` hits only `src/lib/minute-credits.ts` (overflow). The `image-*` keys in `src/lib/credits.ts:24-38` are scaffolding with no spender.
- No `costKeyForKieModel` exists (a stale comment at `src/app/api/admin/costs/route.ts:24` references it). kie model ids (`nano-banana-pro`, `gpt-image-2-text-to-image`, …) have no mapping to cost keys.
- kie key = **user BYOK** (`User.kieKey`, base64), read at `src/app/api/videos/fetch-stock/route.ts:1355,1370`. No SiteConfig/env key. Admin gate: `fetch-stock/route.ts:1359` (403 unless `role==="ADMIN"`).
- Model list `KIE_IMAGE_MODELS` (8 models) at `fetch-stock/route.ts:761-770`; `DEFAULT_KIE_IMAGE_MODEL = "nano-banana-pro"` at `:772`.
- AutoMix = provider checkboxes + **env** weights `AUTOMIX_WEIGHT_VIDEO/PHOTO/AI` (3/2/1) read at `fetch-stock/route.ts:1465-1468`; pure planner `src/lib/automix-plan.ts` needs no change. No percentage sliders exist.
- Editor v2 render POSTs `/api/videos/jobs` from `useV2Job.ts:120`; Setup panel = `_v2/Step2Elements.tsx`; render trigger seam = `EditorV2Shell.tsx:30` (`handleRender`). Pre-TTS duration estimate exists: `_v2/estimate.ts` (`estimateClipSecV2`).
- Overflow minutes: `src/lib/minute-credits.ts:33` (`reserveMinutesOrCredits`, 2cr/min via `creditCostFor("minute")`), charged silently today (doc comment `:21-31`); sole caller `render/route.ts:432`. D5 keeps auto-spend but **discloses it pre-render** via the Receipt.
- FREE plan: `MONTHLY_GRANT.FREE = 0` (`credits.ts:70-74`) → FREE users get stock-only preset (gate = paid, per D2).

**Tech stack:** Next.js 15 App Router, Prisma 6/SQLite, existing `src/lib/credits.ts` + `src/lib/minute-credits.ts` + `src/lib/rate-limit` pattern from managed-Gemini. Verify pattern: `npx tsx scripts/verify-*.ts` against throwaway SQLite.

## Global constraints

- **Flag-safety (HARD):** all new behavior behind `MANAGED_KIE === "1"` (server) — mirrors `MANAGED_GEMINI`. Flag off ⇒ byte-identical behavior to today (BYOK admin-only, no credit spend). Client surfaces additionally respect `NEXT_PUBLIC_CREDITS_LIVE` (already build-baked on prod).
- **Money-path rigor:** never hardcode credit prices — always `creditCostFor(key)`. Spend-before-generate, refund-on-failure (exact buckets via `refundCredits(userId, fromGranted, fromPurchased, action)`).
- **Prices are LOCKED (D3 as amended 2026-07-03 after Task 1 — Mew confirmed):** ประหยัด = `flux-2/pro-text-to-image` = 2cr (new key `image-flux-1k: 2`, COGS ฿0.90) · มาตรฐาน/DEFAULT = `gpt-image-2-text-to-image` = 3cr (`image-gpt-1k`, already 3, COGS ฿1.08) · ขั้นสูง = `nano-banana-2` = 4cr (`image-nano-1k`, already 4, COGS ฿1.44). `nano-banana-pro` (COGS ฿3.24 — margin too thin at any locked price) moves to admin-only along with the other 4 models. No fractional credits.
- **Don't touch:** `automix-plan.ts` core, subtitle timing paths, `tts-gemini` reserve logic.
- **Branch:** `mew/ai-gen-image-golive` off `main` (after PR #144 merges — plan references its docs). Mew merges + deploys.
- **Deploy note for Mew (record in final report):** new env `KIE_API_KEY` goes in prod `.env`; `ecosystem.config.js` env block shadows `.env` → check it doesn't define kie vars, and restart with `pm2 restart ai-content --update-env`. Also set a **spend cap in the kie.ai dashboard** (guardrail L1, manual).

## Execution Directive

| # | Task | Agent | Mode | Review gates |
|---|------|-------|------|--------------|
| 1 | kie catalog research → pick budget model | mew-worker (research brief below) | subagent | session review vs COGS ≤฿0.5 |
| 2 | Default model switch nano → gpt-image-2 | mew-worker | subagent | build+test, code review |
| 3 | Managed kie key + credit spender + guardrails + paid un-gate | mew-worker-heavy | subagent | build+test, code review, **security-review** |
| 4 | Mix Preset 3 ปุ่ม (Editor v2) | mew-worker | subagent | build+test, code review |
| 5 | Render Receipt (Editor v2, pre-render) | mew-worker-heavy | subagent | build+test, code review, security-review (reads quota/credit APIs) |
| 6 | CONTEXT.md/admin-costs alignment + verify scripts sweep | mew-worker | subagent | build+test, code review |

Task order: 1 ∥ 2 first (independent), then 3 (needs task 1's model id), then 4 (needs 3's weight override), then 5 (needs 4's preset→credit estimate), then 6.

## Task 1: kie catalog research — budget image model

**Agent:** mew-worker (research; WebFetch/WebSearch allowed; NO code changes).

- [ ] Fetch current kie.ai pricing for text-to-image models, focusing on the already-wired candidates in `KIE_IMAGE_MODELS`: `qwen2/text-to-image`, `seedream/5-lite-text-to-image`, plus any open-source-class model kie offers that is NOT yet wired (report input shape if new).
- [ ] Report per model: USD price per image at ~1K resolution, ฿ COGS at ฿36/USD, 9:16 support, typical latency.
- [ ] Recommend ONE budget model with COGS ≤฿0.5 (target ≤฿0.35). Deliverable: a table + recommendation appended to this plan file under "Task 1 Result".

**Gate:** session model picks final model id; Mew's quality eyeball happens post-deploy with real generations (she already knows these models from admin use). If no wired model meets COGS bar, flag instead of guessing.

### Task 1 Result (2026-07-03 — COMPLETE, Mew ratified the amended tiers)

No model met COGS ≤฿0.5 (full table + kie.ai sources: `.superpowers/sdd/task-1-report.md`). All 8 wired models cluster ฿0.9–3.24 COGS. Resolution (Mew confirmed): budget tier repriced to 2cr on `flux-2/pro-text-to-image` (฿0.90, ×2.2); premium model swapped to `nano-banana-2` (฿1.44, ×2.78) keeping 4cr; `nano-banana-pro` → admin-only. Default unchanged: gpt-image-2 @ 3cr (×2.8). COGS rates for the admin cost panel (Task 6): flux $0.025 / gpt $0.03 / nano-2 $0.04 per 1K image.

## Task 2: default image model → gpt-image-2

- [ ] `fetch-stock/route.ts:772` — `DEFAULT_KIE_IMAGE_MODEL` → `"gpt-image-2-text-to-image"`.
- [ ] Client defaults: `video-creator/page.tsx` `kieModel` initial state (~:415) and v2 `useV2Project.ts:85` — switch initial value to gpt-image-2; verify the option labels in `KIE_IMAGE_MODEL_OPTIONS` (`video-creator/page.tsx:27-40`) and v2 picker (`Step2Elements.tsx:128`) list gpt-image-2 first/default.
- [ ] Check admin cost panel defaults reference the right bucket (`admin/costs/route.ts` `imageModelBucket`).
- [ ] `npm run build` passes.

## Task 3: managed kie key + credit spender + guardrails + paid un-gate (CORE, money path)

**Server key (D2):**
- [ ] New env `KIE_API_KEY`. In `fetch-stock/route.ts` key resolution: when `MANAGED_KIE==="1"` and `KIE_API_KEY` set → use it for kie calls for **paid users (PRO/BUSINESS)**; admins may still fall back to their BYOK key if env unset. Flag off → today's BYOK-admin behavior exactly.
- [ ] Never log or echo the key; server-side only (route already is).

**Model → cost-key mapping (D3):**
- [ ] Add to `src/lib/credits.ts`: `image-flux-1k: 2` in `CREDIT_COST`, and export `costKeyForKieModel(modelId: string): string | null` mapping: `flux-2/pro-text-to-image` → `image-flux-1k`; `gpt-image-2-text-to-image` → `image-gpt-1k`; `nano-banana-2` → `image-nano-1k`; all other models (incl. `nano-banana-pro`) → `null` (= admin-only, no charge, unchanged behavior). Fix the stale comment at `admin/costs/route.ts:24` to point at the real export.

**Credit spend (spend-before-generate):**
- [ ] In the kie image path of `fetch-stock` (both direct kie-image source and AutoMix AI slots): when `MANAGED_KIE==="1"` and user is non-admin paid — before each `kieCreateTask`, `spendCredits(userId, creditCostFor(key), "image-gen:<model>")`. On `{ok:false}` → skip AI for the remaining windows and fall back to stock (existing fallback machinery), surface `aiSkippedReason: "credits"` in the response. On kie generation failure after spend → `refundCredits` with the exact bucket split.
- [ ] Admins keep free generation (unchanged) — spend only applies to non-admin users on the managed key.
- [ ] Un-gate: `fetch-stock/route.ts:1359` — allow when `MANAGED_KIE==="1"` && plan ∈ {PRO, BUSINESS} && `CREDITS_LIVE==="1"`; FREE stays 403 for kie sources. Mirror on clients: `video-creator/page.tsx:412-413` (`kieImageEnabled`), v2 `Step2Elements.tsx:79` locked logic — locked becomes `o.comingSoon || (o.beta && !p.isAdmin && !p.isPaidManagedKie)` (prop plumbed from a flag+plan check).
- [ ] Non-admin users see ONLY the 3 priced models in pickers (flux-2/pro / gpt-image-2 / nano-banana-2) with credit price labels: `"ประหยัด · 2 เครดิต/ภาพ"`, `"มาตรฐาน (แนะนำ) · 3 เครดิต/ภาพ"`, `"ขั้นสูง · 4 เครดิต/ภาพ"`. Admins see all 8 (incl. nano-banana-pro).

**Guardrails (ADR 0002 — mirror managed-Gemini):**
- [ ] Per-user rate limit on kie createTask calls (reuse the managed-Gemini limiter lib/pattern; find it under `src/lib/` — added in PR-era 2026-06-28 `managed-gemini-cost-guards`). Default: 60 images/hour/user, env-tunable `KIE_IMAGE_RATE_PER_HOUR`.
- [ ] Per-job cap: max AI images per job = `KIE_MAX_IMAGES_PER_JOB` (default 20); windows beyond the cap fall back to stock.
- [ ] Input caps: prompt length cap before sending to kie (reuse existing prompt-building path's limits if present; else cap at 2,000 chars).

**Verification:**
- [ ] `scripts/verify-image-credit-spend.ts` (throwaway SQLite): spend happy path (granted-first), insufficient → skip+no charge, kie-failure → exact-bucket refund, admin bypass, FREE 403, flag-off no-spend.
- [ ] Flag-off diff proof: with `MANAGED_KIE` unset, route behavior byte-identical (reviewer must check).

## Task 4: Mix Preset — 3 ปุ่ม (Editor v2 only; D5.1)

Legacy video-creator + MCP keep today's provider toggles/env weights (unchanged).

- [ ] New request field `autoMixWeights?: {video:number, photo:number, ai:number}` sent from v2 (`useV2Job.ts` body). Server (`fetch-stock/route.ts:1465-1468`): prefer request weights over env **only when** `MANAGED_KIE==="1"` and values are sane (ints 0–9); ai weight forced to 0 server-side for FREE/unauthorized-for-kie users. Env defaults remain the fallback.
- [ ] Replace the admin-only provider-checkbox block in `Step2Elements.tsx:144-165` for non-admins with 3 preset buttons (admins keep the full checkbox + model picker under Advanced):
  - **ฟรีล้วน** — weights `{video:3, photo:2, ai:0}` — label: `ฟรีล้วน`, sub: `สต็อกฟรีทั้งหมด · 0 เครดิต`
  - **ผสม AI แนะนำ** — weights `{video:3, photo:2, ai:1}` — label: `ผสม AI แนะนำ`, sub: `สต็อก + ภาพ AI แทรก · ~6–9 เครดิต/คลิป`, badge: `แนะนำ`
  - **AI เต็มที่** — weights `{video:0, photo:0, ai:1}` — label: `AI เต็มที่`, sub: `ภาพ AI ทุกช่วง · ~25–45 เครดิต/คลิป`
- [ ] Defaults: PRO/BUSINESS → `ผสม AI แนะนำ`; FREE → `ฟรีล้วน` (others disabled with tooltip `อัปเกรดเพื่อใช้ภาพ AI`). Preset choice persists in v2 project state (`useV2Project.ts`).
- [ ] Preset drives `stockSource`/`autoMixProviders` consistently (preset ≠ ฟรีล้วน implies automix incl. `kie-ai` provider).
- [ ] Export a pure helper `estimatePresetCredits(estSec, preset, perImageCredits)` in `_v2/estimate.ts`: windows ≈ `ceil(estSec/4)`, AI share = `ai/(video+photo+ai)`, credits = `ceil(windows × share) × perImageCredits`. Unit-verifiable; used by Task 5.
- [ ] Verify: `npm run build`; manual: preset switch changes request body (worker checks via code trace, Mew QAs visually post-deploy).

## Task 5: Render Receipt (D5) — mandatory pre-render summary, Editor v2

Insert at the `EditorV2Shell.tsx:30` seam: `handleRender()` opens a Receipt dialog; `submit()` fires only on confirm. Client-side gate: `NEXT_PUBLIC_CREDITS_LIVE==="1"` (else current direct-submit behavior).

- [ ] Data: estimated minutes = `minutesFromSeconds(estimateClipSecV2(script))` (reuse both existing helpers — import, don't duplicate); remaining minutes + credit balance from the existing usage/balance endpoints (`GET /api/credits/balance` exists per overflow plan; the minutes-usage API from the quota-chip work — worker locates both, reuse, don't create new endpoints unless truly absent).
- [ ] AI credit estimate from Task 4's `estimatePresetCredits` + the selected model's `creditCostFor` price (plumb price via the existing plans/config props — do NOT hardcode).
- [ ] Receipt content (exact copy; ตัวเลขแทนที่ placeholder):
  - Title: `สรุปก่อนเรนเดอร์`
  - Minutes line: `นาทีที่จะใช้ (ประมาณ): {X} นาที — รวมในแพ็กเกจ (เหลือ {Y} จาก {Z} นาที)`
  - AI line (hide เมื่อ preset = ฟรีล้วน): `ภาพ AI (ประมาณ): ~{N} เครดิต · หักตามจำนวนที่เจนสำเร็จจริง`
  - Overflow warning (show เมื่อ X > Y): `นาทีในแพ็กเกจไม่พอ — ส่วนที่เกิน ~{M} นาที จะหักเครดิต {2×M} เครดิต (2 เครดิต/นาที)`
  - Insufficient-credit warning (show เมื่อ estimated credits > balance): `เครดิตอาจไม่พอ — ระบบจะใช้ภาพสต็อกแทนช่วงที่เครดิตหมด`
  - Avatar line (show เมื่อ avatar mode ≠ none): `อวตาร HeyGen: คิดค่าใช้จ่ายผ่านคีย์ HeyGen ของคุณ (ไม่หักเครดิต/นาทีเพิ่ม)`
  - Disclaimer: `ตัวเลขเป็นประมาณการ — ยอดจริงคำนวณจากความยาวเสียงจริงหลังสร้างเสียง`
  - Buttons: primary `เริ่มเรนเดอร์` · secondary `กลับไปแก้ไข`
- [ ] Server unchanged: overflow auto-spend stays (`minute-credits.ts`), receipt = disclosure layer. Post-render `fireCreditReceipt` toast stays as the "actual" receipt.
- [ ] Verify: `npm run build`; component renders all 4 conditional lines correctly (worker adds a lightweight render test or verify script if the repo has a component-test precedent; otherwise code-trace + reviewer check).

## Task 6: alignment sweep

- [ ] CONTEXT.md: no new terms expected (Credit Economy section from PR #144 already defines Render Receipt / Mix Preset / Overflow) — verify wording matches what shipped; adjust only if implementation diverged.
- [ ] Admin cost panel: add budget model bucket/rate so margins compute (`src/lib/cost-rates.ts`, `admin/settings/route.ts`, `cost-margin-panel.tsx`) using Task 1 COGS.
- [ ] Update `docs/pricing-ai-gen-decisions-2026-07-03.md` work-list checkboxes (items 2–6 done) + this plan's Status line.
- [ ] Full `npm run build` + run all new verify scripts; capture output for the delivery report.

## Acceptance Criteria

- [ ] With `MANAGED_KIE` unset: prod behavior byte-identical (BYOK admin-only, zero credit spend) — reviewer-verified diff reasoning.
- [ ] With flags on: PRO user with credits can render with `ผสม AI แนะนำ` and is charged exactly `images_generated × creditCostFor(model)`; kie failure refunds exact buckets; credit exhaustion mid-job degrades to stock without failing the render.
- [ ] FREE user: kie sources 403 server-side; UI shows ฟรีล้วน only.
- [ ] Default image model = gpt-image-2 everywhere a default exists.
- [ ] Every v2 render (flags on) shows the Receipt first — minutes, AI credits, overflow disclosure, avatar note, estimate disclaimer — with the exact copy above; no render starts without confirm.
- [ ] Rate limit + per-job cap + prompt cap active on the managed path.
- [ ] Build green; verify scripts pass; security review clean on tasks 3 & 5.

## Status

interviewed 2026-07-03 (grilling session, PR #144) | approved: 2026-07-03 | executed: in-progress | delivered: -
