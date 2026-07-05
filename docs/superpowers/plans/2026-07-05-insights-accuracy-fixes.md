# Insights Accuracy Fixes — Implementation Plan

> **For agentic workers:** Implement all tasks in ONE branch `mew/insights-accuracy-2026-07-05`, sequentially (shared files — no parallel commits). After each task, build-verify. Write throwaway `tsx` verify scripts for the pure-logic changes (team pattern: `scripts/verify-*.ts` against logic, not a live DB).

**Goal:** Make `/admin/insights` + `/admin` numbers reflect real work, not telemetry artifacts. Owner (Mew) audited and found the funnels, error buckets, and break-even are misleading.

**Root cause (funnels):** Editor **v2 is the live default** (`NEXT_PUBLIC_EDITOR_V2=1`). The v2 create flow (`_v2/useV2Job.ts`) emits **zero** client telemetry — `editor_script_ready` and `pipeline_step_*` fire ONLY in the dead legacy v1 editor. So every telemetry-based funnel/pipeline step measures a dead path while real work flows through **VideoJob**. Fix = derive funnels from VideoJob (server truth), not telemetry.

**Tech Stack:** Next.js 15 App Router, Prisma 6 + SQLite. Files: `src/app/api/admin/insights/route.ts`, `src/app/api/admin/costs/route.ts`, `src/lib/cost-rates.ts`, `src/app/(dashboard)/admin/insights/page.tsx`, `src/components/admin/cost-margin-panel.tsx`, `src/app/(dashboard)/admin/page.tsx`.

## Global Constraints
- **Exclude internal team (`@aoacademy` emails) from ALL funnel/activation counts, but KEEP everyone else including workshop students (คลังแสง).** Internal = `email.toLowerCase().includes("@aoacademy")` — same rule as `revenue-cohorts.ts:106`.
- **Preserve API response shapes** the frontend already consumes (`current.funnel` = array of `{key,label,count,conversionPct,dropOffPct,previousCount}`), so frontend edits stay minimal.
- Backend is admin-only (`role==="ADMIN"` gate already in place). No auth/schema/migration changes.
- Do NOT touch `/video-editor`, `_v2/*`, render backend, or any charging logic. Read-only analytics only.
- Thai UI copy stays Thai. Follow existing code style in each file.

---

### Task 1: Funnel from VideoJob (kill the v2 telemetry blind spot)

**Files:**
- Modify: `src/app/api/admin/insights/route.ts`
- Modify: `src/app/(dashboard)/admin/insights/page.tsx` (funnel section labels/subtitle only)
- Test: `scripts/verify-job-funnel.ts` (new)

**Design — replace the telemetry session funnel with a VideoJob "creation funnel".**

`VideoJob.progress` is server-written, monotonic, and identical across all generation paths at these milestones: **stock=55, config=65, render=75, done→100** (see `src/lib/mcp/orchestrator.ts` step() calls). Use `status` + `progress`.

Funnel steps (each step = jobs that REACHED it; monotonic because a `done` job has progress=100 ≥ every threshold):

| key | label | reached-if |
|---|---|---|
| `created` | เริ่มสร้าง (สั่งเรนเดอร์) | every job in window |
| `broll` | ได้ B-roll | `progress >= 55` |
| `config` | จัดคลิปเสร็จ | `progress >= 65` |
| `render` | เรนเดอร์ | `progress >= 75` |
| `done` | เสร็จสมบูรณ์ | `status === "done"` |

**Steps:**

- [ ] **1a.** In the `GET` handler, extend the `currentJobs` query select to add `userId: true, progress: true` (currently selects `status, currentStep, errorMessage, startedAt, finishedAt`). Also fetch a **previous-window** VideoJob set (mirror `currentJobs` with `createdAt: { gte: previousSince, lt: since }`, same select) — needed so `previous.funnel` is also job-derived.

- [ ] **1b.** Build `internalUserIds = new Set(allUsers.filter(u => (u.email ?? "").toLowerCase().includes("@aoacademy")).map(u => u.id))`.

- [ ] **1c.** Add a pure function:
```ts
type JobFunnelRow = { userId: string; status: string; progress: number };
const JOB_FUNNEL_STEPS = [
  { key: "created", label: "เริ่มสร้าง (สั่งเรนเดอร์)", reached: (_j: JobFunnelRow) => true },
  { key: "broll",   label: "ได้ B-roll",              reached: (j: JobFunnelRow) => j.progress >= 55 },
  { key: "config",  label: "จัดคลิปเสร็จ",             reached: (j: JobFunnelRow) => j.progress >= 65 },
  { key: "render",  label: "เรนเดอร์",                reached: (j: JobFunnelRow) => j.progress >= 75 },
  { key: "done",    label: "เสร็จสมบูรณ์",             reached: (j: JobFunnelRow) => j.status === "done" },
] as const;

export function summarizeJobFunnel(jobs: JobFunnelRow[]) {
  const funnel = JOB_FUNNEL_STEPS.map((s) => ({
    key: s.key, label: s.label, count: jobs.filter(s.reached).length,
    conversionPct: 0, dropOffPct: 0, previousCount: 0,
  })).map((step, i, all) => {
    const previousCount = i === 0 ? step.count : all[i - 1].count;
    const conversionPct = i === 0 ? 100 : Math.min(100, pct(step.count, previousCount));
    return { ...step, previousCount, conversionPct, dropOffPct: i === 0 ? 0 : Math.max(0, 100 - conversionPct) };
  });
  return { funnel, funnelMode: "job" as const, funnelRuns: funnel[0]?.count ?? 0 };
}
```
(Export it so the verify script can import it. `pct` is already defined in the file.)

- [ ] **1d.** Thread the job funnel into the response. The cleanest way given `summarize()` builds `funnel`/`funnelRuns`/`recommendations` from telemetry: add an **optional** `jobFunnel?: ReturnType<typeof summarizeJobFunnel>` param to `summarize()`. When provided, use it for `funnel`/`funnelMode`/`funnelRuns` in the return **and** for the `dropCandidate` recommendation, instead of `summarizeEditorFunnel(rows)`. Call sites: `summarize(currentRows, currentVideos, processingPlan.summary, summarizeJobFunnel(currentJobsForFunnel))` and `summarize(previousRows, previousVideos, undefined, summarizeJobFunnel(previousJobsForFunnel))`. `currentJobsForFunnel` = `currentJobs` mapped to `{userId,status,progress}` **filtered to exclude internalUserIds**; same for previous.

- [ ] **1e.** Keep `summarizeEditorFunnel` in the file (still used if `jobFunnel` not passed) but it is now dead for the main path — leave a one-line comment that the job funnel supersedes it (v2 telemetry blind spot). Do NOT delete (other callers/tests may reference).

- [ ] **1f.** Frontend `insights/page.tsx`: the funnel renders from `current.funnel` unchanged. Update ONLY the funnel section's heading/subtitle to say it is measured from real render jobs (e.g. subtitle: `"นับจากงานเรนเดอร์จริง (VideoJob) — ตัดบัญชีทีมงานออก"`). If the UI shows a "session" wording tied to `funnelMode`, map `funnelMode==="job"` → label "งานสร้างวิดีโอ".

- [ ] **1g.** Verify script `scripts/verify-job-funnel.ts`: construct synthetic jobs (mix of progress 0/55/65/75/100 + statuses) incl. one `@aoacademy`-owned that must be excluded upstream, assert monotonic non-increasing counts, `created` ≥ others, `done` count = jobs with status done, and conversion never > 100. Run with `npx tsx scripts/verify-job-funnel.ts`, expect all asserts pass.

**Also fix the Activation funnel (same file, `activation` object ~lines 777-794):**

- [ ] **1h.** Exclude internal team + use server-truth "started":
  - `signups` = `allUsers.length - internalTeam` (exclude internal, keep students).
  - `startedPipeline` = distinct userId with ≥1 VideoJob **ever** (server truth), excluding internal. Add a query: `prisma.videoJob.findMany({ select: { userId: true }, distinct: ["userId"] })` → set, minus internal. Replaces the v1-only `editor_script_ready` telemetry (`startedUserRows`).
  - `openedEditor` = keep `openedUserRows` (editor_opened fires app-wide incl v2) but subtract internal userIds present in that set.
  - `completedFirstVideo` / `repeatCreators` = keep (from `completedByUser` Video groupBy) but subtract internal.
  - Add a comment: these funnel counts now exclude `@aoacademy` internal accounts; workshop students are intentionally kept (real prospects).

---

### Task 2: Quota errors are OUR plan cap, not customer-key (BYOK)

**Files:**
- Modify: `src/app/api/admin/insights/route.ts`
- Modify: `src/app/(dashboard)/admin/insights/page.tsx` (error tiles/labels)
- Test: `scripts/verify-error-classify.ts` (new)

**Problem:** `byokReasonFromText` (`route.ts:279`) matches bare `quota` → `QUOTA_MINUTES` (our PRO 15-min plan cap, thrown as 409) is labeled "คีย์ลูกค้า (BYOK)". Under `MANAGED_GEMINI`, real Gemini `429/RESOURCE_EXHAUSTED` are OUR managed key, also mislabeled customer-key.

- [ ] **2a.** Add a quota classifier BEFORE byok:
```ts
// Our own plan caps (minute/clip quota) — expected business rule, not a bug and not a customer-key fault.
function quotaReasonFromText(text: string): string | null {
  if (/QUOTA_MINUTES|เกินโควต้านาที|เกินนาที/i.test(text)) return "ชนเพดานแผน: โควต้านาที";
  if (/QUOTA_CLIPS|QUOTA_[A-Z]+|เกินโควต้าคลิป|clip quota/i.test(text)) return "ชนเพดานแผน: โควต้าคลิป";
  return null;
}
```
- [ ] **2b.** Remove bare `quota` from `byokReasonFromText` (line 279) — keep `429|503|RESOURCE_EXHAUSTED|too many requests|rate limit` for genuine rate-limit, and the billing/key regexes. Rationale: bare "quota" now belongs to `quotaReasonFromText`.
- [ ] **2c.** Change `classifyJobError` to return `"system" | "byok" | "quota" | "noise"`. Order: noise → **quota (`quotaReasonFromText`)** → managed-check → byok → system. Managed rule: if `process.env.MANAGED_GEMINI === "1"` and the text matches `429|RESOURCE_EXHAUSTED|rate limit`, classify as `"system"` (our managed key hitting limits — a capacity/infra signal, not a customer key). Otherwise byok logic unchanged. Keep the pure function testable — pass `managed` as a 2nd arg `classifyJobError(message, managed)` and thread `process.env.MANAGED_GEMINI==="1"` at call sites (`jobOutcomes`).
- [ ] **2d.** In `jobOutcomes` (route.ts ~807-817) add `quotaFailed: failedJobs.filter(j => classifyJobError(j.errorMessage, managed) === "quota").length`. `systemFailed`/`byokFailed`/`noiseFailed` recompute with the `managed` arg. `failedByStage` `kind` union gains `"quota"`.
- [ ] **2e.** Frontend `insights/page.tsx`: wherever the failed-job breakdown shows BYOK vs system, add a **third bucket "ชนเพดานแผน (โควต้า)"** for `quotaFailed`, worded as an expected pricing signal (e.g. "ผู้ใช้ชนเพดานนาที/คลิปของแผน — สัญญาณราคา/อัปเกรด ไม่ใช่บั๊ก"). Do not fold quota into "คีย์ลูกค้า".
- [ ] **2f.** Verify `scripts/verify-error-classify.ts`: assert `QUOTA_MINUTES` 409 body → `"quota"` (not byok); `API_KEY_INVALID` → `"byok"`; `429` with `managed=true` → `"system"`, with `managed=false` → `"byok"`; `__SUPERSEDED__` → `"noise"`; a plain render crash → `"system"`.

---

### Task 3: Break-even target from live rates (stop contradicting the profit tile)

**Files:**
- Modify: `src/app/api/admin/costs/route.ts`
- Modify: `src/lib/cost-rates.ts` (deprecate the constant to a fallback; keep export)
- Modify: `src/components/admin/cost-margin-panel.tsx` (clamp + null-safe display)
- Test: `scripts/verify-breakeven.ts` (new)

**Problem:** `BREAK_EVEN_SUBS = 14` is frozen (`cost-rates.ts:101`) and contradicts the `netProfit=+฿212` "profitable" tile on the same page. By the page's own margin, true break-even ≈ `ceil(infra / grossProfitPerSub)`.

- [ ] **3a.** In `costs/route.ts`, before the response, compute:
```ts
// Live break-even: infra ÷ gross-profit-per-paying-customer (uses THIS page's own margin,
// so it can never contradict the profit tile). Falls back to the static constant only when
// there are no payers yet to derive a contribution from.
const contributionPerSub = cohorts.payingTotal > 0 ? margins.grossProfit / cohorts.payingTotal : 0;
const breakEvenTarget = contributionPerSub > 0
  ? Math.ceil(rates.infraMonthly / contributionPerSub)
  : BREAK_EVEN_SUBS;
```
(`margins.grossProfit` = monthly `mrr − cogs.total`; both monthly. `rates.infraMonthly` already loaded.)
- [ ] **3b.** Change the response `breakEven` to `{ subs: cohorts.breakEvenSubs, target: breakEvenTarget }`.
- [ ] **3c.** `cost-rates.ts`: update the `BREAK_EVEN_SUBS` doc comment to "fallback only, used when payingTotal=0; the live target is computed in costs/route.ts from actual margin." Keep the export (used as fallback + by any tests).
- [ ] **3d.** `cost-margin-panel.tsx` (break-even bar ~329-331): the "ต้องการอีก N ราย" number must be `Math.max(0, target - subs)` (never negative). When `subs >= target`, show a positive "cover infra แล้ว ✓ (คุ้ม infra)" state instead of "ต้องการอีก". Keep the bar fill clamped 0-100%.
- [ ] **3e.** Verify `scripts/verify-breakeven.ts`: with mrr=3520, cogs=209, paying=6, infra=2600 → grossProfit=3311, contribution≈552 → target=`ceil(2600/552)`=5, and `max(0,5-6)`=0 (covered). With paying=0 → target falls back to 14. Assert both.

---

### Task 4: Small label/caption honesty fixes

**Files:**
- Modify: `src/app/(dashboard)/admin/insights/page.tsx`
- Modify: `src/app/(dashboard)/admin/page.tsx`

- [ ] **4a.** `admin/page.tsx:1395` — the "สถิติแผนการใช้งาน" caption `${paidUsers} Paid · ${freeUsers} Free` uses `plan IN (PRO,BUSINESS)` which includes trials+comps (118). Relabel to make that explicit, e.g. `${paidUsers} แผน PRO/BUSINESS (รวม trial/comp) · ${freeUsers} Free`, so it is not read as "118 paying customers" (the honest paying count = จ่ายจริง on Insights).
- [ ] **4b.** `insights/page.tsx` — the two "system error" surfaces must not both read as "Error ระบบ": rename the telemetry error CARD (from `totals.errors`) to "Error events (client+server telemetry)" wording and keep the VideoJob panel as "บั๊กระบบ (งานเรนเดอร์ที่ล้มเหลวจริง)". Add a one-line note that the VideoJob panel is the authoritative bug count.
- [ ] **4c.** `insights/page.tsx` MRR/paying area — add a small caption that MRR is **list-price based** (founding/coupon members counted at full price) so it is not read as exact collected cash; point to Cash-in for actual cash.

---

## Acceptance Criteria
- [ ] Session/creation funnel is computed from VideoJob (`progress`/`status`), not telemetry; counts monotonic; v2 jobs are counted (no fake 96% cliff).
- [ ] All funnel + activation counts exclude `@aoacademy` internal accounts and KEEP non-internal students.
- [ ] `QUOTA_MINUTES`/plan-cap errors show as a distinct "ชนเพดานแผน (โควต้า)" bucket, never "คีย์ลูกค้า (BYOK)"; managed-Gemini 429 → system, not customer-key.
- [ ] Break-even `target` is computed from live margin (≈5 at current numbers), display never shows negative "ต้องการอีก", and no longer contradicts the profit tile.
- [ ] `/admin` "Paid" caption reworded so 118 is not read as paying customers; the two "system error" surfaces are distinctly labeled; MRR carries a list-price caption.
- [ ] `npm run build` green; all four `scripts/verify-*.ts` pass.

## Status
interviewed 2026-07-05 | approved: yes (Mew "ลุยเลย") | executed: pending | delivered: -
