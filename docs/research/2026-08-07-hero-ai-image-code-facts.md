# Hero AI Image — code facts (branch `mew/hero-voice-emotion-rig`, working tree, 2026-08-07)

Read-only audit by Explore agent for the launch-readiness plan
(`docs/plans/2026-08-07-hero-ai-image-launch-readiness.md`). Facts only; verified
claims carry file:line. Feeds Task 3 (report) of that plan.

## 0. Path map (who calls what)

| Path | Entry | Provider | Credit key |
|---|---|---|---|
| **Hero AI Image (new)** | `stockSource="kie-image"` **+** `imageEngine="runpod"` | RunPod Z-Image via `generateHeroImageForVideo` | `image-open-custom-1k` = **3** |
| kie-image (legacy) | `stockSource="kie-image"`, no `imageEngine` | kie.ai | `costKeyForKieModel(...)` (2/3/4) |
| AutoMix AI slots | `stockSource="auto-mix"` | kie.ai | same 2/3/4 |
| Per-window regen | `/api/videos/broll-window/generate` | **kie.ai only** | same 2/3/4 |

- `imageEngine:"runpod"` emitted only by `_v2/useV2Job.ts:288,316`; forwarded `api/videos/jobs/route.ts:565` → `mcp/orchestrator.ts:1245`. Editor v1 (`video-editor/page.tsx:1533`) never sends it → v1 "AI Image" is still kie.
- Only caller of the hero seam: `fetch-stock/route.ts:1655`.

## 1. Per-clip image count & credits

### Hero AI Image (RunPod) — window mode
- `hero-ai-broll.ts:28-37`: **1 image per window, no clamp, no sampling, no cap** (comment at :23-27 states this).
- Charge = `results.length × 3` (`fetch-stock/route.ts:1837`, cost pinned `:1570`, `credit-costs.ts:26`).
- Preflight 402 if `balance.total < windows × 3` (`fetch-stock/route.ts:1607-1624`).
- **`kieMaxImagesPerJob()` (default 20) applies ONLY to the kie branch (`fetch-stock/route.ts:1860`); hero branch is uncapped** — only ceilings: `targetClipCount ≤ 60` (`jobs/route.ts:492`) and non-window `PER_SUBTITLE_DOWNLOAD_LIMIT=36`.

60 s clip, window mode (window ≈ 4 s → ~15 windows):

| Config | Images | Credits |
|---|---|---|
| Hero AI, auto | **15** | **45** |
| Hero AI, `targetClipCount=N` | N (≤60) | 3N (up to 180) |
| Hero AI, window mode off | 14 | 42 |

### Mix presets = a DIFFERENT product (AutoMix, kie)
`mix-presets.ts:17-23`; picking a preset sets `brollSource="automix"` (`Step2Elements.tsx:718-721`); Hero AI Image is a separate card with ai-share always 1.0. Env fallback weights `AUTOMIX_WEIGHT_VIDEO/PHOTO/AI` = 3/2/1.

| Preset | weights v:p:a | AI images @15 win | credits @3/img |
|---|---|---|---|
| ฟรีล้วน `free` | 3:2:0 | 0 (becomes `"stock"`) | 0 |
| AutoMix แนะนำ `recommended` | 3:2:1 | **3** | **6–9** |
| AutoMix · AI เด่น `full` | 1:1:2 | **7** | **18–21** |

- AutoMix AI images ARE subject to max-images-per-job (20) + hourly rate limit; hero is not.
- Ken Burns counting identical for photo/ai slots; only `ai` charged; failed photo slot dropped, never upgraded to paid AI (`fetch-stock/route.ts:2556-2560`). `STOCK_MIN_HOLD_SEC` affects segment grouping only, not counts.

## 2. UI price disclosure (exact strings)

- Customer source card `Step2Elements.tsx:706`: `Hero AI Image · ภาพ AI ล้วน · ไม่ใช้สต็อก · 3 เครดิต/ภาพ` ✅ (per-image only, no total). Admin card `:50-55` has **no price** ❌.
- Model row `Realistic · Z-Image Turbo · RunPod · 3 เครดิต/ภาพ` sits inside `<Advanced>` collapsed by default (`:937`) ⚠️.
- Preset copy: `AutoMix แนะนำ … ~6–9 เครดิต/คลิป` ✅; `AutoMix · AI เด่น` **no credit figure** ❌ (actual 18–21). `ฟรีล้วน` defined but filtered out of the preset buttons (`:808`).
- Count hint `:196` shows count only, no ×3 total.
- **Render Receipt only mounts when `NEXT_PUBLIC_CREDITS_LIVE==="1"`** (`EditorV2Shell.tsx:154-159,634`) — flag NOT in this repo's `.env`; without it submission happens with **no dialog at all** ❌.
- Receipt math correct for hero auto (15×3=45, `receipt.ts:118-126`, `estimate.ts:50-61`); drift on AutoMix `full` (receipt ~24 vs planner 21). Insufficient-credit warning is **advisory — เริ่มเรนเดอร์ never disabled** (`RenderReceiptDialog.tsx:174-181`).
- BrollWindowInspector (per-window regen, kie-only): price chips + CTA `สร้างภาพ (ใช้ {N} เครดิต)` ✅; default model gpt-image-2 = 3cr; 402 → `เครดิตไม่พอ … ดูแพ็กเกจ` (link /pricing).
- MCP / `create_video_job` API path: **no receipt** ❌.

## 3. Gating (five AND-ed layers)

A. **Allowlist** `internal-ai-access.ts:52-56`: ADMIN, or email in {duckyhero@gmail.com}+`INTERNAL_AI_ALLOWED_EMAILS`, or domain in {aoacademy.co}+`INTERNAL_AI_ALLOWED_DOMAINS`. Enforced at `jobs/route.ts:469-471` (403 "Hero AI Image ยังเปิดเฉพาะทีมงาน (Beta)") and `fetch-stock/route.ts:1059-1061`.
B. Model pinned `z-image-turbo`.
C. Route must be `runpod-custom`: requires ALL of `AI_STUDIO_IMAGE_ENABLED=1` ∧ `CREDITS_LIVE=1` ∧ `RUNPOD_API_KEY` ∧ `AI_STUDIO_Z_IMAGE_ROUTE="custom"` ∧ `RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID` (≠"z-image-turbo") ∧ `RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH` (file exists) (`runpod-serverless.ts:35-60`). Else route=public → hero 503s pre-spend.
D. Cost-policy check passes at 3cr (budget 58,333 µUSD vs estimate 50,000).
E. Credits: balance ≥ 3×images; **NO plan check on the hero path** — FREE-plan allowlisted user with credits passes (kie path DOES check PRO/BUSINESS via `resolveKieImageAccess`). `MANAGED_KIE` irrelevant to hero.

Local `.env` state: route resolves public → nobody (incl. admin) can generate; 503 pre-spend.

### Trial user (plan=PRO, trialEndsAt future)
- Grant = 0 (`credits.ts:417` early-return; MONTHLY_GRANT FREE 0 / PRO 50 / BIZ 150).
- Not allowlisted (normal): card disabled `เร็ว ๆ นี้`, server 403; **no upsell link**.
- Allowlisted trial: passes gates → 402 `เครดิตไม่พอสำหรับ Hero AI Image 15 ฉาก ต้องใช้ 45 เครดิต (คงเหลือ 0)`; surfaces as raw pipeline error under "เรนเดอร์ไม่สำเร็จ" (`EditorV2Shell.tsx:786-801`) — **no top-up CTA** (only HeyGen branch has a recovery link).

## 4. Failure / refund

Refund ✅ with Thai "เครดิตถูกคืนแล้ว" on: submit fail, no providerJobId, terminal FAILED/TIMED_OUT/CANCELLED, output-persist fail (`video-hero-image.server.ts`).
Batch: any failure → `refundSettledVideoImageBatch` refunds **settled** scenes of the job (`fetch-stock/route.ts:1786-1828`; messages include `ระบบ…คืนเครดิตของงานนี้แล้ว`). Circuit-open rejects pre-spend.

**GAP:** two paths keep the reservation with NO refund and no reconciler cron:
1. 5 consecutive poll errors (`video-hero-image.server.ts:262-271`);
2. hard deadline 240 s (`:325-330`).
Job stays `chargeState:"reserved"` — batch refund filters `settled` so it never matches; grep found no sweep outside `/api/ai-studio/jobs/[id]`. UI shows raw 503 with no credit mention. Same-job retry reuses the reservation (idempotency `video:<jobId>:scene:<i>`), but v2 "ลองใหม่" creates a NEW videoJobId → new charge.

AutoMix/kie path refunds inline in `finally` (`fetch-stock/route.ts:2607-2618`).
