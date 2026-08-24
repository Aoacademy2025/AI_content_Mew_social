# Design — Admin "Cost & Margin" Dashboard

> Read-only admin analytics. Surfaces unit-economics (cost / usage / revenue / margin) for the new credit + minutes model. **No core-system impact** (admin-gated, reads existing data, additive). Branch: off `mew/pricing-rework-p2` (depends on `CreditLedger`). REQUIRED SUB-SKILL for build: superpowers:subagent-driven-development.

## Goal
Give Mew a single admin screen answering: *Are we making money on the new model? Where does the cost go? Who's burning it?* — with the metrics real SaaS/AI companies watch.

## Placement
- New **"💰 Cost & Margin"** section (collapsible) at the TOP of `/admin/insights` (`src/app/(dashboard)/admin/insights/page.tsx`) — matches existing dark-glass card style (metric tiles 4-col grid, tables `divide-y divide-white/10`, lucide icons).
- Fed by a new admin-gated route **`GET /api/admin/costs?days=N`** (mirrors `/api/admin/insights` auth + shape).
- A **cost-rate editor** added as a tab/section on `/admin` (`page.tsx`, mirror `PlanEditor`) → writes the `cost_*` SiteConfig keys via the existing `PATCH /api/admin/settings` (add keys to its KEYS whitelist).

## Cost-rate config (admin-editable — `SiteConfig` keys, ฿; seeded from spec, ALL marked [verify])
| key | default ฿ | meaning |
|---|---|---|
| `cost_render_per_minute` | 0.7 | Gemini TTS ($0.015/min) + text passes, all-in per video-minute |
| `cost_image_gpt_1k` | 1.05 | gpt-image-2 1K (kie) |
| `cost_image_nano_1k` | 1.4 | Nano Banana 2 1K (kie) |
| `cost_image_gpt_2k` | 1.75 | gpt-image-2 2K |
| `cost_image_nano_2k` | 2.1 | Nano Banana 2 2K |
| `cost_video_seedance_5s` | 3.06 | Seedance 1.5 pro 5s (deferred feature) |
| `cost_infra_monthly` | 2600 | fixed infra (web ฿600 + worker ฿2,000) |
| `fx_baht_per_usd` | 35 | reference only |

> Mirrors `plan-config.ts` pattern: `getCostRates()` helper with `getCfg(key, default)`; editable in `/admin`. **Numbers are estimates from the spec → Mew confirms/tunes against real billing.** Note the markup is ~uniform ≈ ฿0.35 real-cost per credit (so even a blended estimate is close).

## KPIs + exact formulas + data source (the "what values")

### Hero row (period-scoped, default = current month)
| KPI | Formula | Source |
|---|---|---|
| **MRR** | Σ(active subs by plan × plan price) | `User` where `subStatus="active" & plan∈{PRO,BUSINESS}` × `plan_*_price` (SiteConfig) |
| **Variable COGS** | TTS-min + AI-image + AI-video (below) | telemetry + CreditLedger + cost-rates |
| **Gross margin %** | (Revenue − Variable COGS) / Revenue | computed |
| **AI cost % of revenue** ⭐guardrail | Variable COGS / Revenue | computed |
| **Net profit / burn** | Revenue − Variable COGS − (infra prorated) | computed |

### Revenue (period)
- **MRR (recurring)** = active-sub counts × `plan_pro_price`/`plan_business_price`. *(Forward-looking truth — not Payment rows.)*
- **Cash collected** = `Σ Payment.amount/100 WHERE status="PAID" AND paidAt in period` (subscriptions + renewals).
- **Credit-pack cash** = `CreditLedger kind="purchase"` rows → map `delta` (credits) → pack → ฿ (200→฿199, 540→฿499, 1150→฿999). ⚠️ *Credit purchases don't create a Payment row today (known gap) — either map via ledger as here, or add a Payment row (small follow-up).*
- ⚠️ **`Payment.amount` caveat:** only count `status="PAID"` (rows can exist for abandoned/unpaid checkouts) — never `SUM(amount)` blindly.

### Variable COGS (period)
- **TTS / render-minutes** = `Σ TelemetryEvent(name="minute_reserve").properties.minutes` × `cost_render_per_minute`. *(minute_reserve fires only in managed mode = exactly our-cost minutes; BYOK users cost us nothing. Period-accurate; `User.minutesUsed` is a rolling counter, not suitable for period sums. Cross-check count vs RenderJob done.)*
- **AI-image** = `CreditLedger kind="spend", action="ai-image"` → group by `|delta|` (3=gpt-1k→฿1.05, 4=nano-1k→฿1.4, …) × cost-rate. *(Richer model attribution available via `TelemetryEvent name="credit_spend".properties.{model,cost}` — use as the per-model breakdown source.)*
- **AI-video (Seedance)** = 0 until that feature ships (deferred).

### Fixed = `cost_infra_monthly` (shown monthly + prorated into Net).

### Breakdown panel — cost by provider/feature
Stacked bar / table: Gemini TTS · KIE images (by model) · Seedance · Infra → see where the money goes.

### Usage panel
Render minutes (period) · AI images generated (count) · credits spent (granted vs purchased, from ledger) · active creators (distinct active users) · renders (`RenderJob status="DONE"`, web `parentJobId IS NULL` vs MCP).

### Top-cost users (table)
Per-user COGS = their minutes×rate + their image-credits×rate. Top N — catches abuse / whales / outliers.

### Break-even gauge
Active subs vs **~14** (Founder break-even from the cost model). Visual gauge.

### Trend (period)
Daily Revenue run-rate vs daily Variable COGS (line/bar) — spot cost creep.

### (Phase 2) Alerts
Cron-driven: margin < threshold · daily COGS spike · single-user COGS > threshold → notify. (Note only; not in v1.)

## New code (no schema change — reuses SiteConfig + existing tables)
1. `src/lib/cost-rates.ts` — `getCostRates()` (SiteConfig `cost_*` + defaults) + `cost-margin` aggregation helpers (pure functions: take rows+rates → KPIs, unit-testable).
2. `src/app/api/admin/costs/route.ts` — `GET ?days=N`, admin-gated (`getCurrentUser` + `role==="ADMIN"`), returns the full KPI/breakdown/usage/top-users/trend JSON.
3. Extend `PATCH/GET /api/admin/settings` KEYS whitelist with the `cost_*` keys.
4. UI: a `CostMarginPanel` section on `/admin/insights` + a cost-rate editor on `/admin` (mirror `PlanEditor`).

## Build plan (subagent-driven-development). Steps use `- [ ]`.

### Task 1: Cost-rate config + pure cost/margin calc lib
**Files:** Create `src/lib/cost-rates.ts`; modify `src/app/api/admin/settings/route.ts` (add `cost_*` keys to its KEYS whitelist); Test `scripts/verify-cost-margin.ts`.
**Interfaces (Task 2 consumes):**
- `getCostRates(): Promise<{ renderPerMinute, imageGpt1k, imageNano1k, imageGpt2k, imageNano2k, videoSeedance5s, infraMonthly, fxBahtPerUsd }>` — reads SiteConfig `cost_*` with the spec defaults (mirror `plan-config.ts getCfg`).
- Pure functions (data in → numbers out, no DB): `computeMrr(active:{pro,business}, price:{pro,business}): number`; `computeCogs(input:{ managedMinutes:number; imageCredits:{gpt1k,nano1k,gpt2k,nano2k}; rates }): { tts, image, video, total }`; `computeMargins({ revenue, variableCogs, infraMonthly, periodDays }): { grossProfit, grossMarginPct, aiCostPct, netProfit }`; `BREAK_EVEN_SUBS = 14`.
- [ ] **Step 1:** write `scripts/verify-cost-margin.ts` (no DB needed for the pure fns; same `npx tsx` style) asserting: `computeMrr({pro:2,business:1},{pro:599,business:990})===2188`; COGS = managedMinutes×0.7 + Σ(imageCredits×rate); `grossMarginPct = (rev-cogs)/rev`; `aiCostPct = cogs/rev`; net = gross − infraMonthly prorated to periodDays; `getCostRates()` returns defaults when SiteConfig empty. Run → fail.
- [ ] **Step 2:** implement `cost-rates.ts`. `getCostRates` mirrors `getCfg(key, default)`. Defaults: renderPerMinute 0.7, imageGpt1k 1.05, imageNano1k 1.4, imageGpt2k 1.75, imageNano2k 2.1, videoSeedance5s 3.06, infraMonthly 2600, fxBahtPerUsd 35.
- [ ] **Step 3:** add the 8 `cost_*` keys to the `KEYS` whitelist in `admin/settings/route.ts` (so existing GET/PATCH handle them — no new write code).
- [ ] **Step 4:** `npx tsx scripts/verify-cost-margin.ts` pass; `npx tsc --noEmit` 0. Commit `feat(admin): cost-rate config + cost/margin calc lib`.

### Task 2: `/api/admin/costs` aggregation route (admin-gated)
**Files:** Create `src/app/api/admin/costs/route.ts`.
- [ ] **Step 1:** `GET ?days=N` — auth `getCurrentUser` + `if (role!=="ADMIN") 403` (mirror `/api/admin/insights`). Compute the window `from = now - days` (default 30 / current month).
- [ ] **Step 2:** gather: active subs by plan (`User` `subStatus="active"` & plan); prices (`getPlanConfig`); managed minutes (`Σ TelemetryEvent name="minute_reserve"` `properties.minutes` in window); AI-image credits (`CreditLedger kind="spend" action="ai-image"` grouped by `|delta|` → gpt1k=3/nano1k=4/gpt2k=5/nano2k=6); credit-pack cash (`CreditLedger kind="purchase"` → map delta→pack→฿); subscription cash (`Payment status="PAID"` `SUM(amount)/100` in window); renders (`RenderJob status="DONE"`, web `parentJobId IS NULL` vs MCP); per-user COGS (top 10); daily trend (rev vs cogs). Call Task 1's pure fns for the math.
- [ ] **Step 3:** return `{ period, hero:{mrr,variableCogs,grossMarginPct,aiCostPct,netProfit}, breakdown, usage, topUsers, breakEven:{subs,target:14}, trend }`. try/catch → apiError.
- [ ] **Step 4:** `npx tsc --noEmit` 0. (Route — no unit test by convention; math is in the Task 1 tested lib.) Commit `feat(admin): /api/admin/costs cost+margin aggregation`.

### Task 3: UI — Cost & Margin panel + cost-rate editor
**Files:** Create `src/components/admin/cost-margin-panel.tsx`; modify `src/app/(dashboard)/admin/insights/page.tsx` (render the panel at top); modify `src/app/(dashboard)/admin/page.tsx` (cost-rate editor section, mirror `PlanEditor`).
- [ ] **Step 1:** `CostMarginPanel` (client) — `fetch('/api/admin/costs?days='+days)`; render hero KPIs (5 tiles), cost-breakdown (by provider), usage, top-cost-users table, break-even gauge, daily trend — matching the existing insights dark-glass style (cards `border-white/10 bg-white/[0.03]`, lucide icons, 4-col tile grid). Thai labels. Loading/error states.
- [ ] **Step 2:** render `<CostMarginPanel />` as a new collapsible section at the TOP of `/admin/insights`.
- [ ] **Step 3:** cost-rate editor on `/admin` (mirror `PlanEditor`): 8 number fields for the `cost_*` keys, GET `/api/admin/settings` to load + PATCH to save.
- [ ] **Step 4:** `npx tsc --noEmit` 0; admin-only confirmed; visual QA = Mew's (note it). Commit `feat(admin): Cost & Margin dashboard panel + cost-rate editor`.

### Final whole-branch review (opus) + verify, then STOP (no push/merge/deploy).

## Open decisions for Mew (can default + tune later)
1. **Cost-rate numbers** — defaults above are spec estimates [verify]. Confirm or I ship defaults + you tune in the admin editor.
2. **Credit-pack revenue** — map via ledger (above, zero new code) OR add a Payment row on credit purchase (cleaner billing-history too; small follow-up). Recommend: ledger-map for v1, Payment-row as a follow-up.
3. **Period default** — current calendar month vs trailing 30 days. Recommend: selectable, default current month (matches billing mindset).

## Safety
Read-only, admin-only, additive, no flag needed, no schema change, no core/render/payment-write path touched. Build on a branch off `p2`; rebase like the others.
