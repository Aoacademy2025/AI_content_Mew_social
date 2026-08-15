# Hero AI Image Public-Launch Readiness Audit — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a Thai-language launch-readiness audit answering: can PRO/BUSINESS/Trial users *actually afford to use* Hero AI Image at 3 credits/image, is the system technically ready for 100% public exposure, and which pricing option best serves "ใช้แล้วติด → เติมเครดิต".

**Architecture:** Data-first consulting audit. One worker pulls read-only production stats; the session (which holds the interview context) synthesizes the report; a fresh-context critic gates it against the acceptance criteria. No production code changes in this plan.

**Tech Stack:** SSH + sqlite3 (read-only) against prod SQLite; markdown deliverable.

## Interview decisions (2026-08-07, Mew)

1. **Report first** — implementation of any approved change is a separate follow-up plan.
2. **Prod access granted** — read-only only, for this audit.
3. **All pricing axes open** for recommendation: per-image price, monthly grant, per-clip bundling, default-mix tuning. Report proposes 2–3 options with math; Mew decides.
4. **Success model (Mew's own framing)** — three usage modes must each be viable: เจนคลิปเยอะ → b-roll ฟรี · อยากตรงขึ้น → AutoMix · อยากตรงมากๆ → Hero AI Image ล้วน · ไม่พอ → เติมเครดิต. Readiness = each mode affordable at its tier, with top-up as the natural overflow (not churn).
5. **Trial policy: option (b)** — small one-time taste grant (~9–10cr ≈ 3 images, non-renewing); exact size to be recommended in the report.
6. **Deliverable + acceptance criteria approved** as listed below.
7. **Hero-only image stack (added 2026-08-07, pre-execute):** ALL image generation — Hero AI Image mode AND AutoMix's AI slots AND per-window regen — must run on our RunPod system; kie.ai and its models are paused (not removed). B-roll video stays free stock. Code today: AutoMix AI slots and BrollWindowInspector regen still call kie — the report must size this migration gap (rewire to the hero seam vs disable at launch) as part of the go/no-go checklist.
8. **User-controllable image count (added 2026-08-07):** users must be able to cap images per clip. Hero mode already supports it (`targetClipCount` 1–60, fixed-count windows map N images evenly across the clip). AutoMix supports total-piece count but has NO direct AI-image-count control (AI share comes from 3:2:1 weights) — the report must cover this gap in the recommended launch spec.

Reference (do not restate here): `CONTEXT.md` §Credit Economy + §AI Generation, ADR 0002 (kie credits model), ADR 0004 (no cross-fallback), `docs/pricing-ai-gen-decisions-2026-07-03.md` (D1–D7), `docs/audits/2026-07-22-quota-credit-audit.md` (ledger health).

## Global Constraints

- Prod access is **read-only**: SELECT/`.schema` only, no INSERT/UPDATE/DELETE/DDL, no `.env` reads beyond what's needed to confirm flags, never touch customer BYOK keys (hard rule).
- Mask PII in every output file: emails as `substr(email,1,3)||'***'`; never copy full prompts containing personal data.
- Deliverable language: Thai. Plan/infra docs: English.
- Hero AI Image price context — **corrected during execution 2026-08-07**: `HERO_AI_IMAGE_CREDITS = 3` (`image-open-custom-1k`) is already on origin/main and live on prod (921 settled custom jobs at 3cr); the "uncommitted" reading came from diffing against a stale local main. This branch is BEHIND main for hero-image files — nothing here needs merging for launch.
- SSH: `root@72.62.196.230`, key `~/.ssh/hostinger_heroai_codex`, DB `/var/www/ai-content/prisma/dev.db`, timestamps are ms epoch (`datetime(x/1000,'unixepoch','+7 hours')`).

---

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Prod usage-stats pull (read-only) | mew-worker | subagent | — | session sanity-check vs 07-22 audit numbers |
| 2 | Code-facts consolidation (Explore agent already in flight) | (session) | inline | — | session cross-check vs code |
| 3 | Analysis + Thai readiness report | (session model) | inline | 1, 2 | mew-critic vs acceptance criteria |
| 4 | Critic review + revisions (≤3 rounds) | mew-critic | subagent | 3 | session final gate |

---

### Task 1: Prod usage-stats pull (read-only)

**Files:**
- Create: `docs/research/2026-08-07-hero-ai-image-prod-stats.md` (structured findings, PII-masked)

**Interfaces:**
- Produces: one markdown file with every query, its raw result table, and a one-line reading of each. Task 3 consumes this file verbatim — no interpretation beyond arithmetic.

- [ ] **Step 1: Confirm schema before querying** (prod may predate this branch)

```bash
ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 \
  "sqlite3 'file:/var/www/ai-content/prisma/dev.db?mode=ro' '.schema AiGenerationJob' '.schema CreditLedger' '.schema CreditBalance'"
```
Adapt column lists below to what actually exists; note any missing column in the findings file.

- [ ] **Step 2: Image-generation overview** — volume, price actually charged, failure/refund rates

```sql
SELECT provider, providerRoute, model, status, chargeState,
       COUNT(*) n, SUM(creditCost) credits,
       ROUND(AVG(executionTimeMs)) avg_exec_ms,
       SUM(COALESCE(providerReportedCostUsdMicros, estimatedCostUsdMicros)) cost_usd_micros
FROM AiGenerationJob WHERE kind='image'
GROUP BY 1,2,3,4,5 ORDER BY n DESC;
```

```sql
SELECT strftime('%Y-%W', createdAt/1000, 'unixepoch', '+7 hours') week,
       COUNT(*) jobs, SUM(creditCost) credits, COUNT(DISTINCT userId) users
FROM AiGenerationJob WHERE kind='image' GROUP BY 1 ORDER BY 1;
```

- [ ] **Step 3: Who used it + how hard** (mask emails)

```sql
SELECT substr(u.email,1,3)||'***' who, u.plan, u.role,
       COUNT(*) imgs, SUM(j.creditCost) credits,
       MIN(date(j.createdAt/1000,'unixepoch','+7 hours')) first_use,
       MAX(date(j.createdAt/1000,'unixepoch','+7 hours')) last_use
FROM AiGenerationJob j JOIN User u ON u.id=j.userId
WHERE j.kind='image'
GROUP BY j.userId ORDER BY imgs DESC;
```

- [ ] **Step 4: Images per clip (the affordability crux)** — distribution of images and credits per video job

```sql
SELECT json_extract(inputJson,'$.videoJobId') vj,
       COUNT(*) imgs, SUM(creditCost) credits
FROM AiGenerationJob
WHERE kind='image' AND json_extract(inputJson,'$.videoJobId') IS NOT NULL
GROUP BY 1;
```
Then summarize in SQL or by hand: min / median / avg / max images per clip and credits per clip. If `videoJobId` is absent from old rows, say so and give the distribution for the rows that have it.

- [ ] **Step 5: Real COGS per image** — provider-reported cost stats per model/route

```sql
SELECT model, providerRoute,
       COUNT(*) n,
       ROUND(AVG(providerReportedCostUsdMicros)) avg_usd_micros,
       MAX(providerReportedCostUsdMicros) max_usd_micros
FROM AiGenerationJob
WHERE kind='image' AND providerReportedCostUsdMicros IS NOT NULL
GROUP BY 1,2;
```
Convert to ฿ at 36 THB/USD and compute gross margin at both 2cr and 3cr retail.

- [ ] **Step 6: Failure detail** — top error codes + refund correctness signal

```sql
SELECT errorCode, COUNT(*) n FROM AiGenerationJob
WHERE kind='image' AND status='failed' GROUP BY 1 ORDER BY n DESC LIMIT 15;
SELECT chargeState, COUNT(*) FROM AiGenerationJob WHERE kind='image' AND status='failed' GROUP BY 1;
```

- [ ] **Step 7: Credit economy context**

```sql
SELECT kind, action, COUNT(*) n, SUM(delta) total FROM CreditLedger GROUP BY 1,2 ORDER BY 1,2;
SELECT u.plan, COUNT(*) users, ROUND(AVG(b.granted)) avg_granted_left, ROUND(AVG(b.purchased)) avg_purchased
FROM CreditBalance b JOIN User u ON u.id=b.userId
WHERE u.plan IN ('PRO','BUSINESS') GROUP BY 1;
```

- [ ] **Step 8: Audience sizes** — how many people does "public" mean

```sql
SELECT plan, role,
       SUM(CASE WHEN trialEndsAt IS NOT NULL AND trialEndsAt > strftime('%s','now')*1000 THEN 1 ELSE 0 END) trialing,
       COUNT(*) total
FROM User GROUP BY 1,2;
```
(If `trialEndsAt` is stored as ISO text instead of ms epoch, compare with `datetime('now')` instead — check `.schema User` output from Step 1.)

- [ ] **Step 9: Flags snapshot** — confirm which gates are live on prod

```bash
ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230 \
  "grep -E '^(MANAGED_KIE|CREDITS_LIVE|MINUTE_QUOTA|RUNPOD_IMAGE_[A-Z_]+)=' /var/www/ai-content/.env | sed 's/=.*ENDPOINT_ID=.*/=<set>/' "
```
Record flag *names and on/off state only* — never copy key/secret values into the findings file.

- [ ] **Step 10: Write findings file** — `docs/research/2026-08-07-hero-ai-image-prod-stats.md`: every query, its result table, one factual line each. End with a "data caveats" section (missing columns, small-n warnings). No recommendations.

### Task 2: Code-facts consolidation (session)

**Files:**
- Uses: report from the already-dispatched Explore agent (per-clip planning math in `planHeroAiWindowGeneration`, mix-preset weights, UI price-disclosure strings in Step2Elements/BrollWindowInspector/RenderReceiptDialog, gating flags, trial-user failure path, refund UX)

**Interfaces:**
- Produces: verified facts folded directly into Task 3. If the Explore agent's report conflicts with code, the session re-reads the cited lines before using the claim.

- [ ] **Step 1:** Cross-check the Explore report's file:line citations for the four claims the report's verdict will lean on: (a) planned images per clip per mix preset, (b) price shown before spend in every path, (c) exact gate set for the hero path, (d) refund-on-failure coverage.
- [ ] **Step 2:** Note deltas between prod (deployed main) and this branch's uncommitted state — the readiness verdict must say what must merge before launch.

### Task 3: Analysis + Thai readiness report (session)

**Files:**
- Create: `docs/audits/2026-08-07-hero-ai-image-public-launch-readiness.md` (Thai)

**Interfaces:**
- Consumes: Task 1 findings file + Task 2 verified facts.
- Produces: the deliverable, structured exactly as the acceptance criteria below.

- [ ] **Step 1:** Write สถิติการใช้จริง section (from Task 1, cite the research file).
- [ ] **Step 2:** Write simulation: credits/clip for each mix preset × PRO/BUSINESS/Trial, at 2cr and 3cr, → คลิปต่อเดือนใน grant per Mew's three usage modes (b-roll ฟรี / AutoMix / Hero ล้วน).
- [ ] **Step 3:** Write COGS-margin table from real provider-reported costs.
- [ ] **Step 4:** Write readiness verdict: พร้อม/ไม่พร้อม + go/no-go checklist (technical gates to flip, branch changes to merge, guardrails, monitoring), including the trial taste-grant design (size, one-time mechanics, abuse caps).
- [ ] **Step 5:** Write 2–3 pricing options, each with: คลิป/เดือนที่ได้ per plan, margin, expected top-up behavior, one-line recommendation which to pick and why.
- [ ] **Step 6:** Write the kie→Hero migration section (decision 7): what still runs on kie (AutoMix AI slots, per-window regen), rewire-vs-disable options with effort sizing, and the count-control gap for AutoMix (decision 8) including the fixed-count UX note (few images on a long clip = long Ken Burns holds, e.g. 5 images / 120 s ≈ 24 s per still).

### Task 4: Critic review + final gate

- [ ] **Step 1:** Dispatch `mew-critic` with ONLY the acceptance criteria + deliverable path + research file path (not the conversation).
- [ ] **Step 2:** Session revises per critic findings; ≤3 rounds (escalation rule per mew-kickoff).
- [ ] **Step 3:** Session final gate: verify every acceptance criterion, update this plan's Status line, deliver summary to Mew with the decision ask (pick a pricing option / order the follow-up implementation plan).

---

## Acceptance Criteria

- [ ] Real prod stats section: volume, users, images+credits per clip distribution, failure/refund rates, real COGS — all from the research file, none assumed.
- [ ] Simulation table: every mix preset × PRO/BUSINESS/Trial at both 2cr and 3cr, expressed as "คลิปที่ทำได้/เดือนใน grant".
- [ ] Mew's three usage modes each assessed viable/not-viable with numbers.
- [ ] COGS-margin table from real provider-reported costs (not just the 5,000-micros estimate).
- [ ] Readiness verdict + concrete go/no-go checklist including what must merge from this branch.
- [ ] Trial taste-grant (option b) sized and specified with abuse caps.
- [ ] 2–3 pricing options with per-plan clip math + margin + a single recommendation.
- [ ] kie→Hero migration gap sized (AutoMix AI slots + per-window regen), rewire-vs-disable options stated.
- [ ] AutoMix AI-image-count control gap covered in the recommended launch spec.
- [ ] Thai language; PII masked; every stat traceable to the research file.

## Out of scope

- Implementing any pricing/grant/UI change (separate plan after Mew picks an option).
- Flipping any prod flag or deploying (launch itself is a later step).
- AI *video* generation pricing (D4) and Hero AI Voice.

## Status

interviewed 2026-08-07 | approved: 2026-08-07 (Mew: "execute เลย") | executed: 2026-08-07 (all 4 tasks; critic round 1 → rev.2; RunPod billing verified → rev.3) | delivered: docs/audits/2026-08-07-hero-ai-image-public-launch-readiness.md rev.3 — COGS ฿0.19/รูป verified; **Mew signed off Option B (2cr) 2026-08-07** → follow-up: docs/plans/2026-08-07-hero-ai-image-p0-launch.md
