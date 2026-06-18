# Render Queue & Worker Isolation (Phase 2 Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Remotion rendering out of the web process into a durable, self-healing render queue + dedicated worker, so a long or hung render can never lock the queue or take down the website.

**Architecture:** A new `RenderJob` DB table is the render-execution queue (one row per renderMedia/burn). A new long-lived PM2 app `render-worker` claims jobs atomically (same Prisma guarded-`updateMany` pattern that `VideoJob` already uses — no new dependency), renders via the *existing* render core (extracted into a shared module callable by both the legacy route and the worker), reports progress + heartbeat to the row, and cancels/kills its child process tree on stall/timeout. A sweeper cron flips dead jobs (stale heartbeat) so the slot frees automatically. Everything sits behind `RENDER_VIA_QUEUE=1`; the legacy in-process path stays intact until cutover. The app only ever talks to a stable job interface (`src/lib/render/job-store.ts`) so the future scale step (`docs/scale-upgrade-plan.md`) swaps the substrate underneath without touching pipeline code.

**Tech Stack:** Next.js 15 (App Router) / React 19 / TypeScript, Prisma 6 + SQLite (WAL already live), Remotion (`@remotion/renderer`), PM2, `tsx` for worker + verify scripts.

## Global Constraints

- `main` = production. Never push broken code to main. Work on a feature branch; Mew rebases + merges + deploys. — copied from CLAUDE.md
- **WAL is already live on prod** (`journal_mode=wal`, verified 2026-06-18) — the queue's atomic-claim prerequisite is met. Do NOT re-migrate it.
- **Atomic claim = Prisma guarded `updateMany`** (reuse `src/lib/mcp/video-job.ts:claimNextQueuedJob` pattern). Do NOT add `better-sqlite3`; the existing VideoJob queue proves this pattern works on this WAL SQLite.
- **`ecosystem.config.js` env SHADOWS `.env` for process env** → the `render-worker` app's env (incl. `RENDER_VIA_QUEUE`, render tuning) must be set in `ecosystem.config.js`, and restarts need `pm2 restart <app> --update-env`. — copied from CLAUDE.md gotchas
- **Additive migration only** — `deploy/deploy.sh` runs `prisma db push` before restart; never write a destructive migration.
- **Flag-gated rollout:** `RENDER_VIA_QUEUE` (default `0`). Legacy in-process render path stays fully intact until PR-9 cutover (out of scope for this plan).
- **Quota is per-VIDEO, single-owner, idempotent refund** — reserve once at the first render of a video; never double-reserve (burn does not re-reserve); refund at most once per `videoId`.
- **Status values (RenderJob):** `QUEUED | RUNNING | DONE | FAILED | CANCELLED` (uppercase). VideoJob keeps its own lowercase `queued|processing|done|failed|canceled` — do NOT unify them.
- **Two liveness models (phase-aware):** a `RUNNING` (on-CPU) job is alive iff progress advances + heartbeat < 90s; an externally-waiting job (future avatar-park, PR-10, NOT in this plan) uses a separate generous model. This plan implements only the CPU/render liveness.
- Tests follow the repo's `verify-*` pattern: a `tsx` script against a throwaway SQLite DB, run via `npm run`-style invocation. — copied from CLAUDE.md

---

## File Structure

**New files**
- `src/lib/render/types.ts` — `RenderJobType`, `RenderJobStatus`, `RenderPayload`, `RenderResult` type definitions (shared by store, worker, routes).
- `src/lib/render/job-store.ts` — **the stable job interface** (the scale seam): `enqueueRenderJob`, `claimNextRenderJob`, `updateRenderProgress`, `heartbeat`, `requestCancel`, `finishRenderJob`, `failRenderJob`, `sweepDeadRenderJobs`, `getRenderJob`. All RenderJob DB access goes through here — nothing else imports `prisma.renderJob` directly.
- `src/lib/render/run-render.ts` — the **extracted render core**: `runRender(payload, { onProgress, cancelSignal, jobId })` → `{ videoUrl }`. Moved (not rewritten) from `render/route.ts`; called by both the legacy route and the worker.
- `scripts/render-worker.ts` — PM2 long-lived worker: claim loop, heartbeat, stall-watchdog + wall-clock cap, child-tree kill, graceful drain.
- `scripts/verify-render-queue.ts` — logic test (throwaway SQLite): claim atomicity, sweeper requeue/fail+refund, idempotent quota refund, cancel.

**Modified files**
- `prisma/schema.prisma` — add `model RenderJob`.
- `src/app/api/videos/render/route.ts` — behind `RENDER_VIA_QUEUE`: enqueue a RenderJob + return `jobId` (instead of starting in-process render); legacy path unchanged when flag off. Extract render core to `run-render.ts`.
- `src/app/api/videos/render-progress/route.ts` — when flag on, read the RenderJob row (not `.tmp` files).
- `src/app/api/videos/render-cancel/route.ts` — when flag on, set `cancelRequested=true` on the row (cross-process).
- `scripts/reconcile-processing.js` (or its cron) — add the RenderJob sweeper pass.
- `ecosystem.config.js` — add `render-worker` PM2 app + `RENDER_VIA_QUEUE` env.
- `deploy/deploy.sh` — restart `render-worker` after `ai-content` (same as `mcp-video-worker`).
- `package.json` — add `verify:render-queue` script.

---

## Task 1: RenderJob schema + types (PR-6)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/render/types.ts`

**Interfaces:**
- Produces: `model RenderJob` (Prisma); `RenderJobType = "RENDER" | "BURN"`, `RenderJobStatus = "QUEUED"|"RUNNING"|"DONE"|"FAILED"|"CANCELLED"`, `RenderPayload` (JSON shape stored in the row), `RenderResult = { videoUrl: string }`.

- [ ] **Step 1: Add the RenderJob model to the schema**

Append to `prisma/schema.prisma` (mirror the existing `VideoJob` conventions: `cuid()` id, `DateTime` defaults):

```prisma
model RenderJob {
  id              String    @id @default(cuid())
  userId          String
  videoId         String?   // gallery Video row, set when known
  parentJobId     String?   // VideoJob.id when created by the MCP orchestrator; null for web jobs
  type            String    // RENDER | BURN
  status          String    @default("QUEUED") // QUEUED|RUNNING|DONE|FAILED|CANCELLED
  attempts        Int       @default(0)
  maxAttempts     Int       @default(2)
  payload         String    // JSON: full render config — no in-memory dependence
  progress        Float     @default(0)
  phase           String?   // bundling | rendering | encoding
  heartbeatAt     DateTime?
  cancelRequested Boolean   @default(false)
  reservedQuota   Boolean   @default(false) // true iff THIS job reserved a clip for its video
  error           String?   // JSON, PR-5 error taxonomy
  idempotencyKey  String?   @unique
  videoUrl        String?
  createdAt       DateTime  @default(now())
  startedAt       DateTime?
  finishedAt      DateTime?

  @@index([status, type])
  @@index([userId, createdAt])
  @@index([parentJobId])
}
```

- [ ] **Step 2: Push the schema to a local dev DB and verify it applies cleanly**

Run: `npx prisma db push && npx prisma generate`
Expected: "Your database is now in sync with your Prisma schema." and the client regenerates with `prisma.renderJob` available. (Additive only — no data loss prompt.)

- [ ] **Step 3: Create the shared types**

Create `src/lib/render/types.ts`:

```typescript
export type RenderJobType = "RENDER" | "BURN";
export type RenderJobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** Everything run-render needs to produce an MP4 — copied from the legacy render route's POST body. */
export type RenderPayload = {
  shortVideoConfig: unknown;          // the Remotion input props (existing config shape)
  fps?: number;
  jpegQuality?: number;
  subtitleOverlayConfig?: unknown;    // present for BURN jobs
};

export type RenderResult = { videoUrl: string };
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (0 errors).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma src/lib/render/types.ts
git commit -m "feat(render-queue): add RenderJob model + shared render types"
```

---

## Task 2: Job store — the stable interface (PR-6)

**Files:**
- Create: `src/lib/render/job-store.ts`
- Create: `scripts/verify-render-queue.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `prisma` (`src/lib/prisma.ts`), `RenderJobType/Status` (Task 1), `reserveClipUsage`/`refundClipUsage` (`src/lib/usage-limits.ts`).
- Produces:
  - `enqueueRenderJob(input: { userId: string; type: RenderJobType; payload: RenderPayload; videoId?: string; parentJobId?: string; idempotencyKey?: string; reserveQuotaFor?: string }): Promise<{ id: string }>`
  - `claimNextRenderJob(): Promise<RenderJobRow | null>` — atomic, oldest QUEUED → RUNNING.
  - `updateRenderProgress(id: string, progress: number, phase?: string): Promise<void>` — also bumps `heartbeatAt`.
  - `heartbeat(id: string): Promise<void>`
  - `isCancelRequested(id: string): Promise<boolean>`
  - `requestCancel(id: string): Promise<void>`
  - `finishRenderJob(id: string, videoUrl: string): Promise<void>`
  - `failRenderJob(id: string, error: unknown, opts?: { requeue?: boolean }): Promise<void>` — requeue if attempts left, else FAILED + idempotent quota refund.
  - `sweepDeadRenderJobs(staleMs: number): Promise<number>` — RUNNING + stale heartbeat → fail/requeue; returns count swept.
  - `getRenderJob(id: string): Promise<RenderJobRow | null>`

- [ ] **Step 1: Write the failing logic test**

Create `scripts/verify-render-queue.ts` (repo verify-* pattern — throwaway SQLite via a temp `DATABASE_URL`). Start with the atomic-claim + sweeper + refund cases:

```typescript
// Run with: npm run verify:render-queue
// Spins a throwaway SQLite DB, exercises job-store transitions, asserts, exits non-zero on failure.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rq-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.error("FAIL:", msg); } else console.log("ok:", msg); };

async function main() {
  const store = await import("../src/lib/render/job-store");
  const { prisma } = await import("../src/lib/prisma");

  // 1. enqueue → claim moves QUEUED→RUNNING exactly once
  const a = await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  const c1 = await store.claimNextRenderJob();
  const c2 = await store.claimNextRenderJob();
  ok(c1?.id === a.id, "first claim returns the queued job");
  ok(c2 === null, "second claim returns null (no double-claim)");

  // 2. concurrent claim: two enqueued, two parallel claimers, no double-claim
  await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  await store.enqueueRenderJob({ userId: "u1", type: "RENDER", payload: { shortVideoConfig: {} } });
  const [x, y] = await Promise.all([store.claimNextRenderJob(), store.claimNextRenderJob()]);
  ok(!!x && !!y && x!.id !== y!.id, "two parallel claimers get two different jobs");

  // 3. sweeper requeues a RUNNING job with a stale heartbeat (attempts left)
  const stale = await prisma.renderJob.create({ data: { userId: "u1", type: "RENDER", payload: "{}", status: "RUNNING", attempts: 0, maxAttempts: 2, heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
  const swept = await store.sweepDeadRenderJobs(90_000);
  const after = await store.getRenderJob(stale.id);
  ok(swept >= 1, "sweeper reports work");
  ok(after?.status === "QUEUED", "stale RUNNING job requeued (attempts left)");

  // 4. sweeper fails (not requeues) when attempts exhausted, and refunds quota once
  const dead = await prisma.renderJob.create({ data: { userId: "u1", type: "RENDER", payload: "{}", status: "RUNNING", attempts: 2, maxAttempts: 2, reservedQuota: true, videoId: "v1", heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
  await store.sweepDeadRenderJobs(90_000);
  const deadAfter = await store.getRenderJob(dead.id);
  ok(deadAfter?.status === "FAILED", "exhausted job → FAILED");

  // 5. idempotent refund: failing an already-FAILED job does not double-refund (no throw, status stays FAILED)
  await store.failRenderJob(dead.id, new Error("again"));
  const deadAfter2 = await store.getRenderJob(dead.id);
  ok(deadAfter2?.status === "FAILED", "re-failing a FAILED job is a no-op (idempotent)");

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nALL PASS");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `package.json` scripts:

```json
"verify:render-queue": "tsx scripts/verify-render-queue.ts"
```

- [ ] **Step 2: Run it to confirm it fails (job-store not implemented yet)**

Run: `npm run verify:render-queue`
Expected: FAIL — `Cannot find module '../src/lib/render/job-store'`.

- [ ] **Step 3: Implement the job store**

Create `src/lib/render/job-store.ts`. Use the proven guarded-`updateMany` atomic claim (same as `video-job.ts:claimNextQueuedJob`):

```typescript
import { prisma } from "@/lib/prisma";
import { refundClipUsage, reserveClipUsage } from "@/lib/usage-limits";
import type { RenderJobType, RenderPayload } from "@/lib/render/types";

export type RenderJobRow = Awaited<ReturnType<typeof prisma.renderJob.findFirst>>;

export async function enqueueRenderJob(input: {
  userId: string; type: RenderJobType; payload: RenderPayload;
  videoId?: string; parentJobId?: string; idempotencyKey?: string;
  reserveQuotaFor?: string; // videoId this job is responsible for reserving quota for (first render of a video)
}): Promise<{ id: string }> {
  let reserved = false;
  if (input.reserveQuotaFor) {
    await reserveClipUsage(input.userId); // throws/handled by caller on quota_exceeded
    reserved = true;
  }
  const job = await prisma.renderJob.create({
    data: {
      userId: input.userId, type: input.type, payload: JSON.stringify(input.payload),
      videoId: input.videoId ?? null, parentJobId: input.parentJobId ?? null,
      idempotencyKey: input.idempotencyKey ?? null, reservedQuota: reserved, status: "QUEUED",
    },
  });
  return { id: job.id };
}

/** Atomic claim: oldest QUEUED → RUNNING. Guarded updateMany; returns null if another claimer won. */
export async function claimNextRenderJob(): Promise<RenderJobRow | null> {
  const next = await prisma.renderJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!next) return null;
  const res = await prisma.renderJob.updateMany({
    where: { id: next.id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date(), heartbeatAt: new Date(), attempts: { increment: 1 } },
  });
  if (res.count !== 1) return null; // lost the race
  return prisma.renderJob.findUnique({ where: { id: next.id } });
}

export async function updateRenderProgress(id: string, progress: number, phase?: string): Promise<void> {
  await prisma.renderJob.update({ where: { id }, data: { progress, phase: phase ?? undefined, heartbeatAt: new Date() } });
}

export async function heartbeat(id: string): Promise<void> {
  await prisma.renderJob.update({ where: { id }, data: { heartbeatAt: new Date() } });
}

export async function isCancelRequested(id: string): Promise<boolean> {
  const r = await prisma.renderJob.findUnique({ where: { id }, select: { cancelRequested: true } });
  return !!r?.cancelRequested;
}

export async function requestCancel(id: string): Promise<void> {
  await prisma.renderJob.updateMany({ where: { id, status: { in: ["QUEUED", "RUNNING"] } }, data: { cancelRequested: true } });
}

export async function finishRenderJob(id: string, videoUrl: string): Promise<void> {
  await prisma.renderJob.update({ where: { id }, data: { status: "DONE", progress: 100, videoUrl, finishedAt: new Date() } });
}

/** Fail with retry policy. Requeue if attempts remain (unless requeue:false); else FAILED + one-time quota refund. */
export async function failRenderJob(id: string, error: unknown, opts?: { requeue?: boolean }): Promise<void> {
  const job = await prisma.renderJob.findUnique({ where: { id } });
  if (!job || job.status === "FAILED" || job.status === "DONE") return; // idempotent: terminal stays terminal
  const errStr = JSON.stringify({ message: error instanceof Error ? error.message : String(error) }).slice(0, 1000);
  const canRetry = (opts?.requeue ?? true) && job.attempts < job.maxAttempts;
  if (canRetry) {
    await prisma.renderJob.update({ where: { id }, data: { status: "QUEUED", error: errStr, heartbeatAt: null, startedAt: null } });
    return;
  }
  // terminal: refund exactly once (reservedQuota flag is the single-owner guard)
  await prisma.renderJob.update({ where: { id }, data: { status: "FAILED", error: errStr, finishedAt: new Date() } });
  if (job.reservedQuota) {
    await refundClipUsage(job.userId);
    await prisma.renderJob.update({ where: { id }, data: { reservedQuota: false } }); // prevent double-refund
  }
}

/** Sweep RUNNING jobs whose heartbeat is older than staleMs → fail (with retry policy). Returns count. */
export async function sweepDeadRenderJobs(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const dead = await prisma.renderJob.findMany({ where: { status: "RUNNING", heartbeatAt: { lt: cutoff } } });
  for (const job of dead) await failRenderJob(job.id, new Error("stale heartbeat — worker presumed dead"));
  return dead.length;
}

export async function getRenderJob(id: string): Promise<RenderJobRow | null> {
  return prisma.renderJob.findUnique({ where: { id } });
}
```

> Note: `reserveClipUsage`/`refundClipUsage` signatures are `(userId: string)` per `src/app/api/videos/render/route.ts:6` imports. If `reserveClipUsage` returns a quota object rather than throwing on exceeded, the enqueue caller (Task 4) must check it and surface `quota_exceeded` — confirm the actual signature when implementing and adjust the `reserveQuotaFor` branch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify:render-queue`
Expected: PASS — "ALL PASS", exit 0.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (expect PASS)

```bash
git add src/lib/render/job-store.ts scripts/verify-render-queue.ts package.json
git commit -m "feat(render-queue): job-store interface (atomic claim, sweeper, idempotent refund) + verify script"
```

---

## Task 3: Extract the render core into a shared module (PR-7)

**Files:**
- Create: `src/lib/render/run-render.ts`
- Modify: `src/app/api/videos/render/route.ts`

**Interfaces:**
- Produces: `runRender(payload: RenderPayload, ctx: { jobId: string; onProgress: (pct: number, phase?: string) => void; cancelSignal: import("@remotion/renderer").CancelSignal }): Promise<RenderResult>` — performs bundle → selectComposition → renderMedia → output upload, exactly as the legacy route does today; returns the final `{ videoUrl }`.
- Consumes: the existing helpers in `render/route.ts` (bundle/cache/cancel-registry) — these MOVE with the core or are imported.

> **This is a mechanical extraction, not a rewrite.** The render logic currently lives inline in `src/app/api/videos/render/route.ts` (~lines 361–1035: dynamic import of `@remotion/renderer`, `selectComposition` with bundle-retry, `renderMedia` with `cancelSignal`, progress writes, error/cancel classification, output handling). Move that body verbatim into `runRender`, parameterized by `payload` + `ctx`. Preserve every existing behavior: bundle-missing rebuild-once retry (route.ts:~785, ~954), thread/cache scaling under concurrency (route.ts:~852/~864), and cancel classification (route.ts:~1010). The legacy POST handler then calls `runRender` for its in-process path so behavior is identical when the flag is off.

- [ ] **Step 1: Read the current render route end-to-end**

Run: open `src/app/api/videos/render/route.ts` and identify the exact span of the in-process render (from the `@remotion/renderer` import through the terminal `setRenderJob(..., {status:"done", videoUrl})`). Confirm what local helpers it uses (`cancel-registry`, bundle cache, image caching). Do NOT change behavior yet.

- [ ] **Step 2: Create `run-render.ts` wrapping the existing core**

Create `src/lib/render/run-render.ts` exporting `runRender(payload, ctx)`. Move the render body in; replace the route's `setRenderJob(jobId, {progress})` calls with `ctx.onProgress(pct, phase)`, and replace the route's `makeCancelSignal()` usage with the passed `ctx.cancelSignal`. Return `{ videoUrl }` instead of writing the route's in-memory map.

```typescript
import type { RenderPayload, RenderResult } from "@/lib/render/types";
import type { CancelSignal } from "@remotion/renderer";

export async function runRender(
  payload: RenderPayload,
  ctx: { jobId: string; onProgress: (pct: number, phase?: string) => void; cancelSignal: CancelSignal },
): Promise<RenderResult> {
  const { renderMedia, selectComposition } = await import(/* webpackIgnore: true */ "@remotion/renderer" as string);
  // ... moved verbatim from render/route.ts:361–1035, with:
  //   - bundle ensure + rebuild-once retry (preserve)
  //   - selectComposition with overrides (preserve)
  //   - renderMedia({ ..., cancelSignal: ctx.cancelSignal, onProgress: ({progress}) => ctx.onProgress(progress*100, "rendering") })
  //   - thread/cache scaling under concurrency (preserve)
  //   - output write + return { videoUrl }
  return { videoUrl: /* computed */ "" };
}
```

- [ ] **Step 3: Point the legacy route at `runRender` (flag OFF path unchanged in behavior)**

In `render/route.ts`, replace the inline render body in the background task with a call to `runRender(payload, { jobId, onProgress: (p, phase) => setRenderJob(jobId, { status: "running", startedAt, progress: p }), cancelSignal })`. Keep `setRenderJob`/`.tmp` progress + `reserveClipUsage` exactly as today. The route's external contract (returns `{ jobId }`, polled via render-progress) is unchanged.

- [ ] **Step 4: Manual smoke test of the legacy path (flag still off)**

Run: `npm run build` (expect success), then in dev do one full web render (Style → Content → Video) and confirm the preview renders + downloads as before.
Expected: identical behavior to pre-change (legacy in-process render works).

- [ ] **Step 5: Commit**

```bash
git add src/lib/render/run-render.ts src/app/api/videos/render/route.ts
git commit -m "refactor(render): extract render core into run-render.ts (callable by route + worker); no behavior change"
```

---

## Task 4: Thin route — enqueue behind the flag (PR-7)

**Files:**
- Modify: `src/app/api/videos/render/route.ts`
- Modify: `src/app/api/videos/render-progress/route.ts`
- Modify: `src/app/api/videos/render-cancel/route.ts`

**Interfaces:**
- Consumes: `enqueueRenderJob`, `getRenderJob`, `requestCancel` (Task 2).
- Produces: when `RENDER_VIA_QUEUE=1`, `POST /api/videos/render` returns `{ jobId }` of a DB RenderJob; `render-progress?jobId=` returns `{ status, progress, videoUrl, error }` read from the row; `render-cancel` flips `cancelRequested`.

- [ ] **Step 1: Gate the POST handler on the flag**

In `render/route.ts` POST handler, after the existing quota pre-check (route.ts:~263), branch:

```typescript
if (process.env.RENDER_VIA_QUEUE === "1") {
  // quota: reserve once per VIDEO. BURN of the same video does NOT re-reserve.
  const isBurn = !!body?.subtitleOverlayConfig;
  const { id } = await enqueueRenderJob({
    userId,
    type: isBurn ? "BURN" : "RENDER",
    payload: { shortVideoConfig: body.shortVideoConfig, fps: body.fps, jpegQuality: body.jpegQuality, subtitleOverlayConfig: body.subtitleOverlayConfig },
    videoId: body.videoId,
    parentJobId: body.parentJobId,           // set by MCP orchestrator; undefined for web
    reserveQuotaFor: isBurn ? undefined : body.videoId ?? "pending", // reserve only on the base RENDER
  });
  return Response.json({ jobId: id });
}
// else: existing legacy in-process path (unchanged)
```

> The legacy path already reserves/refunds; the queue path reserves at enqueue (base render only) and refunds via `failRenderJob`. Confirm `reserveClipUsage`'s return/throw contract and map quota failure to the existing `403 quota_exceeded` (route.ts:~223) before enqueue.

- [ ] **Step 2: Gate render-progress on the flag**

In `render-progress/route.ts`, when `RENDER_VIA_QUEUE === "1"`, read the row instead of the `.tmp` file:

```typescript
if (process.env.RENDER_VIA_QUEUE === "1") {
  const job = await getRenderJob(jobId);
  if (!job) return Response.json({ status: "error", error: "job not found" });
  const status = job.status === "DONE" ? "done" : job.status === "FAILED" || job.status === "CANCELLED" ? "error" : "running";
  return Response.json({ status, progress: job.progress, videoUrl: job.videoUrl ?? undefined, error: job.error ?? undefined });
}
// else: existing .tmp-file read (unchanged)
```

- [ ] **Step 3: Gate render-cancel on the flag**

In `render-cancel/route.ts`, when the flag is on, `await requestCancel(jobId)` (cross-process, cross-restart) instead of the in-memory cancel map.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS. (No worker yet, so do not flip the flag in dev — jobs would queue with nothing to claim. This step only proves the flagged branches compile.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/videos/render/route.ts src/app/api/videos/render-progress/route.ts src/app/api/videos/render-cancel/route.ts
git commit -m "feat(render-queue): thin render/progress/cancel routes behind RENDER_VIA_QUEUE (legacy path intact)"
```

---

## Task 5: render-worker (PR-7)

**Files:**
- Create: `scripts/render-worker.ts`
- Modify: `ecosystem.config.js`
- Modify: `deploy/deploy.sh`

**Interfaces:**
- Consumes: `claimNextRenderJob`, `updateRenderProgress`, `heartbeat`, `isCancelRequested`, `finishRenderJob`, `failRenderJob` (Task 2); `runRender` (Task 3).
- Produces: a long-lived process that drains the QUEUED→DONE/FAILED lifecycle. Heartbeat is **progress-derived** + a **stall watchdog** + a **wall-clock cap**; cancels via Remotion `makeCancelSignal` and kills the child process tree.

- [ ] **Step 1: Implement the worker**

Create `scripts/render-worker.ts`:

```typescript
import { makeCancelSignal } from "@remotion/renderer";
import { claimNextRenderJob, updateRenderProgress, heartbeat, isCancelRequested, finishRenderJob, failRenderJob } from "../src/lib/render/job-store";
import { runRender } from "../src/lib/render/run-render";
import type { RenderPayload } from "../src/lib/render/types";

const POLL_MS = 3000;
const STALL_MS = Number(process.env.RENDER_STALL_MS) || 120_000;   // no progress for 2 min ⇒ stuck
const WALLCLOCK_MS = Number(process.env.RENDER_WALLCLOCK_MS) || 45 * 60_000; // hard cap per job
let draining = false;
let current: { id: string; cancel: () => void } | null = null;

async function runOne(job: NonNullable<Awaited<ReturnType<typeof claimNextRenderJob>>>) {
  const { cancel, cancelSignal } = makeCancelSignal();
  current = { id: job.id, cancel };
  const startedAt = Date.now();
  let lastProgress = 0, lastProgressAt = Date.now();

  // Watchdog: stall (no progress) OR wall-clock cap OR external cancel ⇒ cancel the render.
  const watchdog = setInterval(async () => {
    try {
      const now = Date.now();
      if (now - lastProgressAt > STALL_MS) { console.warn(`[render-worker] stall ${job.id}`); cancel(); }
      else if (now - startedAt > WALLCLOCK_MS) { console.warn(`[render-worker] wallclock ${job.id}`); cancel(); }
      else if (await isCancelRequested(job.id)) { console.log(`[render-worker] cancel requested ${job.id}`); cancel(); }
      else await heartbeat(job.id); // liveness only ticks while the watchdog itself is healthy
    } catch {}
  }, 10_000);

  try {
    const payload = JSON.parse(job.payload) as RenderPayload;
    const result = await runRender(payload, {
      jobId: job.id,
      cancelSignal,
      onProgress: (pct, phase) => { lastProgress = pct; lastProgressAt = Date.now(); void updateRenderProgress(job.id, pct, phase).catch(() => {}); },
    });
    await finishRenderJob(job.id, result.videoUrl);
  } catch (e) {
    // runRender must clean up its own Chromium on cancel; ffmpeg/normalize children are killed inside run-render's finally.
    const cancelled = /cancel|aborted|Request closed/i.test(e instanceof Error ? e.message : String(e));
    await failRenderJob(job.id, e, { requeue: !cancelled }); // explicit user-cancel ⇒ do not retry
  } finally {
    clearInterval(watchdog);
    current = null;
    void lastProgress;
  }
}

async function loop() {
  while (!draining) {
    const job = await claimNextRenderJob().catch((e) => { console.error("[render-worker] claim error", e); return null; });
    if (!job) { await new Promise((r) => setTimeout(r, POLL_MS)); continue; }
    console.log(`[render-worker] claimed ${job.id} (${job.type})`);
    await runOne(job);
  }
}

// Graceful drain: stop claiming, cancel current, set it back to QUEUED without consuming an attempt.
async function shutdown() {
  draining = true;
  if (current) { current.cancel(); await failRenderJob(current.id, new Error("worker draining (deploy)"), { requeue: true }); }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[render-worker] started");
loop().catch((e) => { console.error("[render-worker] fatal", e); process.exit(1); });
```

> **Child-tree kill:** Remotion's `cancelSignal` terminates its own headless Chromium. The ffmpeg/normalize children spawned inside `run-render` must be tracked and `.kill()`-ed in `run-render`'s `finally` (the legacy route already kills a proc at route.ts:~545 — preserve/extend that). Add this as part of Task 3's extraction if not already covered; verify no orphan `ffmpeg`/`chrome` after a cancelled render (Step 4 below).

- [ ] **Step 2: Register the PM2 app + flag (env in ecosystem — it shadows .env)**

In `ecosystem.config.js`, add a new app mirroring `mcp-video-worker`:

```javascript
{
  name: "render-worker",
  cwd: "/var/www/ai-content",
  script: "node_modules/.bin/tsx",
  args: "scripts/render-worker.ts",
  autorestart: true,
  watch: false,
  kill_timeout: 30000,        // allow graceful drain
  max_memory_restart: "5G",   // worker heap; web heap shrinks in PR-8
  env: {
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=4096",
    RENDER_VIA_QUEUE: "1",
    DATABASE_URL: process.env.DATABASE_URL || "file:/var/www/ai-content/prisma/dev.db",
    // render tuning for the worker process:
    RENDER_OFFTHREAD_CACHE_MB: "128",
    RENDER_JPEG_QUALITY: "60",
  },
},
```

> The web `ai-content` app must ALSO get `RENDER_VIA_QUEUE: "1"` in its `ecosystem.config.js` env so the thin routes enqueue. Add it there too. Restart both with `--update-env`.

- [ ] **Step 3: deploy.sh restarts render-worker**

In `deploy/deploy.sh`, after the `pm2 restart ai-content` line, add:

```bash
pm2 restart render-worker --update-env || pm2 start ecosystem.config.js --only render-worker --update-env
pm2 save
```

- [ ] **Step 4: End-to-end test in dev with the flag ON**

Run: set `RENDER_VIA_QUEUE=1` locally, start `tsx scripts/render-worker.ts` in one terminal + `npm run dev` in another. Do one full web render. Confirm: route returns `jobId` fast; worker logs "claimed"; progress advances in the UI (reading the row); video completes + downloads. Then run a render and `kill -9` the worker mid-render → within ~90s the sweeper (Task 6) or a fresh worker requeues it and it completes on retry. Check `ps aux | grep -E "ffmpeg|chrome"` shows no orphans after a cancel.
Expected: render completes via the queue; killed worker self-recovers; no orphan children.

- [ ] **Step 5: Commit**

```bash
git add scripts/render-worker.ts ecosystem.config.js deploy/deploy.sh
git commit -m "feat(render-queue): render-worker (progress heartbeat, stall+wallclock watchdog, graceful drain) + PM2 app + deploy restart"
```

---

## Task 6: Sweeper cron (PR-7)

**Files:**
- Modify: `scripts/reconcile-processing.js` (or add a `RenderJob` pass to the existing reconcile cron)

**Interfaces:**
- Consumes: `sweepDeadRenderJobs` (Task 2).

- [ ] **Step 1: Add the sweeper pass**

In the reconcile cron body, add (alongside the existing stale-PROCESSING reconciliation):

```javascript
// RenderJob sweeper: RUNNING with heartbeat older than 90s ⇒ worker dead ⇒ requeue or FAIL+refund.
const { sweepDeadRenderJobs } = await import("../src/lib/render/job-store");
const swept = await sweepDeadRenderJobs(90_000);
if (swept) console.log(`[reconcile] swept ${swept} dead RenderJob(s)`);
```

> The reconcile cron already runs every 15 min (ecosystem.config.js). For ≤2-min dead-job detection, EITHER lower its `cron_restart` to `*/2 * * * *` OR have the worker itself run a lightweight sweep each idle poll. Prefer the cron change (simpler, isolated). Confirm `reconcile-processing` runs with `RENDER_VIA_QUEUE` available if any branch depends on it — the sweep itself does not need the flag.

- [ ] **Step 2: Verify via the logic test (already covers sweep)**

Run: `npm run verify:render-queue`
Expected: PASS — the sweep requeue/fail+refund cases (Task 2 test cases 3–5) cover this logic.

- [ ] **Step 3: Commit**

```bash
git add scripts/reconcile-processing.js
git commit -m "feat(render-queue): sweeper pass in reconcile cron (stale RenderJob ⇒ requeue/fail+refund)"
```

---

## Task 7: RAM/CPU containment (PR-8) — prod-applied, flag-gated

**Files:**
- Modify: `ecosystem.config.js`
- (Ops, on the VPS) cgroup/oom_score_adj — documented, applied by Mew during deploy

**Interfaces:** none (config/ops only).

> Apply this ONLY after Tasks 1–6 are deployed and the queue is proven stable with the flag on (chaos test passes). Shrinking the web heap before renders actually leave the process would OOM the web app.

- [ ] **Step 1: Shrink web heap (only valid once renders run in the worker)**

In `ecosystem.config.js` `ai-content` app: change `NODE_OPTIONS` and `node_args` from `--max-old-space-size=12288` to `--max-old-space-size=3072`; lower `max_memory_restart` from `13G` to `4G`. (Worker carries the render heap now.) **Do this in the SAME deploy that enables `RENDER_VIA_QUEUE=1` everywhere, and keep the old values one revert away.**

- [ ] **Step 2: oom_score_adj steering (ops, documented in `docs/ops/ops-guardrails-runbook.md`)**

After PM2 start, set the worker tree to be killed first under memory pressure:

```bash
# web stays (low score), worker dies first (high score) — kernel kills worker, sweeper requeues, web never dies
for pid in $(pgrep -f "render-worker"); do echo 500 > /proc/$pid/oom_score_adj; done
for pid in $(pgrep -f "next start"); do echo -500 > /proc/$pid/oom_score_adj; done
```

Document this as a post-deploy step in the runbook (and a candidate for a small PM2 post-start hook later).

- [ ] **Step 3: Chaos acceptance test on prod, off-peak (the gate before trusting PR-8)**

Run (off-peak, box idle): (1) `kill -9` worker mid-render ⇒ job back to QUEUED ≤90s + completes without user action; (2) deploy mid-render ⇒ graceful drain + requeue, zero lost jobs; (3) start a render then `stress`/memory pressure ⇒ worker dies first, web keeps serving HTTP 200.
Expected: all three pass. If any fails, revert the heap change (flip env, `mv` rollback) and diagnose before retrying.

- [ ] **Step 4: Commit the config (ops steps stay in the runbook)**

```bash
git add ecosystem.config.js docs/ops/ops-guardrails-runbook.md
git commit -m "feat(render-queue): PR-8 containment — shrink web heap once renders are isolated + oom_score_adj runbook"
```

---

## Out of scope for this plan (tracked, not built here)

- **PR-9 cutover** (remove legacy in-process render path + refresh-resume UX) — do after PR-8 is stable in prod.
- **PR-10 avatar parking** (HeyGen webhook + `AVATAR_POLL`, phase-aware liveness for `AWAITING_EXTERNAL`, split the inline `await runAvatarComposite` at orchestrator.ts:145) — the fix for "long HeyGen avatar blocks the queue". Separate plan; the queue built here is its prerequisite.
- **Fast-lane / 2nd worker** (Rung 2 of `docs/scale-upgrade-plan.md`) — only if short jobs queue behind long CPU renders becomes a real complaint.

## Self-Review

- **Spec coverage:** PR-6 (schema+store) = Tasks 1–2; PR-7 (worker+queue+sweeper+thin routes) = Tasks 3–6; PR-8 (containment) = Task 7. Our agreed refinements: RenderJob↔VideoJob nesting via `parentJobId` (Task 1 schema); quota single-owner + idempotent refund (`reservedQuota` flag, Task 2 `failRenderJob`); progress-derived heartbeat + stall + wall-clock watchdog (Task 5); child-tree kill (Task 3/5 notes + Task 5 Step 4 verify). Avatar-park + fast-lane explicitly deferred. ✓
- **Placeholder scan:** `run-render.ts` body is intentionally an extraction reference (real code lives in the existing route) — Task 3 gives the exact line range + signature + behaviors to preserve, not a "TODO". Quota signature noted as "confirm at implementation" because `reserveClipUsage`'s throw-vs-return contract wasn't read in full. These are explicit verification points, not vague placeholders.
- **Type consistency:** `RenderPayload`/`RenderResult` (Task 1) used identically in `run-render.ts` (Task 3) + worker (Task 5); `enqueueRenderJob`/`claimNextRenderJob`/`failRenderJob`/`sweepDeadRenderJobs` signatures defined in Task 2 and consumed unchanged in Tasks 4–6; status strings uppercase throughout; `reservedQuota` used consistently as the refund single-owner guard. ✓
