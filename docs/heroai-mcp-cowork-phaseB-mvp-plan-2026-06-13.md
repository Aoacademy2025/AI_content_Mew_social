# HERO AI MCP — Phase B MVP (Headless `create_video_job`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a PRO/BUSINESS member's agent call MCP `create_video_job` to produce a finished standard (voice + b-roll + burned Thai subtitles, non-avatar) video headlessly, by reusing the existing stable pipeline endpoints via an additive service-auth seam.

**Architecture:** `create_video_job` (MCP, Phase A auth) inserts a `VideoJob(queued)` and returns a jobId. A new PM2 worker polls `VideoJob`, and an in-process orchestrator chains the SAME `/api/videos/*` endpoints over localhost HTTP, authenticating as the member via an additive `getCurrentUser()` service branch (server-only secret header). Captions are built in-process by reusing the pure `captionsFromTtsTiming`. Nothing in the stable pipeline is modified.

**Tech Stack:** Next.js 15 route handlers · Prisma 6 (SQLite) · `mcp-handler` (Phase A) · `tsx` PM2 worker (cron pattern) · reuse `src/lib/tts-timing.ts`.

**Source spec:** `docs/heroai-mcp-cowork-phaseB-mvp-design-2026-06-13.md`. Builds on Phase A (`mew/heroai-mcp-cowork` branch).

**HARD RULE:** Additive only. Do NOT change any `/api/videos/*` handler, the render route, tts/transcribe, or `tts-timing.ts`. The ONLY edits to existing files are: `getCurrentUser` (+2 lines), `src/middleware.ts` (+1 branch), `prisma/schema.prisma` (+model), the MCP route (add 1 tool + upgrade 1), `ecosystem.config.js` (+1 app), `.env`.

---

## Real-code contracts this plan is built on (verified 2026-06-13)

Non-avatar chain + exact payloads (from `video-editor/page.tsx`):
1. `POST /api/videos/tts-gemini {text, voiceName}` OR `/api/videos/tts {text, voiceId, languageCode:"th"}` → `{ voiceUrl, audioDurationMs, timing }`
2. captions = `captionsFromTtsTiming(timing, audioDurationMs, maxCardChars, undefined)` (pure, in-process)
3. `POST /api/videos/extract-keywords {scenes: captions.map(c=>c.text), audioDurationSec, preferredLLM:null}` → `{ keywords, keywordAlternatives, keywordsPerScene, sceneClipCounts, sceneDurations, visualDirection }`
4. `POST /api/videos/fetch-stock {keywords, download:true, totalDurationSec, stockSource, preferredLLM, ...perSubtitle, visualDirection?, keywordAlternatives?}` → `{ results: StockVideo[] }`
5. `POST /api/videos/generate-config {sceneCaptions, stockVideos, voiceFile, audioDurationMs, ...style, scenes, keywordsPerScene, sceneClipCounts, sceneDurations, preferredLLM:null}` → `{ config }`
6. `POST /api/videos/render {shortVideoConfig:{...config, keywordPopups:[]}, fps:30, jpegQuality:85}` → `{ jobId }`; poll `GET /api/videos/render-progress?jobId=` until `stage==="done"` → `videoUrl`
7. `POST /api/videos {videoUrl, audioUrl, thumbnail:null, script, avatarModel:"none", voiceModel, sceneCount, renderConfig, status:"PROCESSING"}` → `{ id }`
8. burn: `POST /api/videos/render {subtitleOverlayConfig:{videoUrl, keywordPopups, durationInFrames, fontFamily, subtitleStylePreset, subtitleTextEffect, subtitleAccentColor}}` → jobId → poll → burned `videoUrl`
9. `PATCH /api/videos/{id} {videoUrl:burned, status:"COMPLETED"}`

Confirmed facts: `reserveClipUsage` runs on EVERY render POST (base + burn = 2 clips) — orchestrator refunds 1 after burn via `refundClipUsage` (lib import, no route edit). Defaults: `fps=30`, style `{fontFamily:"'Kanit', sans-serif", subtitlePosition:82, subtitleSize:80, subtitleColor:"#ffffff", subtitleAccentColor:"#FFE500", subtitleStylePreset:"stroke", subtitleTextEffect:"pop", subtitleFontWeight:900}`, `maxCardChars = Math.max(10, Math.floor((1080-160)/(subtitleSize*0.47)))`. `keywordPopups` per caption: `{text, start:round(startMs/1000*30), end:round(endMs/1000*30), tag, isHighlight:tag==="hook", color, accentColor, fontWeight, topPercent:subtitlePosition, size:subtitleSize, stylePreset}`.

---

## File Structure

**Create:**
- `src/lib/mcp/service-actor.ts` — internal service-credential validator + `resolveServiceActor()`
- `src/lib/mcp/orchestrator-steps.ts` — PURE payload builders (one per endpoint) + defaults
- `src/lib/mcp/pipeline-client.ts` — service-authed fetch + render poll helper
- `src/lib/mcp/orchestrator.ts` — `runOrchestrator(jobId, userId, deps)` chaining the steps + VideoJob updates + refund-1
- `scripts/mcp-video-worker.ts` — PM2 worker polling `VideoJob(queued)`
- `scripts/verify-service-actor.ts`, `scripts/verify-mcp-orchestrator-steps.ts`, `scripts/verify-mcp-videojob.ts`, `scripts/verify-mcp-orchestrator.ts`

**Modify (additive only):**
- `src/lib/clerk-auth.ts` — `getCurrentUser()` +2 lines (service branch first)
- `src/middleware.ts` — +1 branch (let valid service header through)
- `prisma/schema.prisma` — +`VideoJob` model, +`videoJobs` relation on User
- `src/app/api/[transport]/route.ts` — +`create_video_job` tool, upgrade `get_video_status` to read VideoJob
- `ecosystem.config.js` — +`mcp-video-worker` app
- `.env` — `MCP_SERVICE_SECRET`, `MCP_INTERNAL_BASE_URL`

---

### Task 1: Verify all pipeline endpoints auth via `getCurrentUser` (so the seam covers them)

**Files:** none (verification gate)

- [ ] **Step 1: Grep each pipeline route for its auth call**

Run:
```bash
for r in tts tts-gemini extract-keywords fetch-stock generate-config render; do
  echo "== $r =="; grep -nE "getCurrentUser|requireUser|await auth\(" "src/app/api/videos/$r/route.ts" | head -3
done
grep -nE "getCurrentUser|requireUser|await auth\(" src/app/api/videos/route.ts "src/app/api/videos/[id]/route.ts" | head
```
Expected: every route resolves identity via `getCurrentUser()` or `requireUser()` (which calls `getCurrentUser()`). 

- [ ] **Step 2: Handle exceptions**

If any route calls `auth()` directly (NOT through getCurrentUser), note it. The service seam lives in `getCurrentUser`, so such a route would NOT see the acted-as user. If found, the contingency is to also short-circuit in that route via `resolveServiceActor()` — but do NOT proceed to build assuming coverage. Record findings in the task PR description. (Expected: all use getCurrentUser/requireUser — proceed.)

---

### Task 2: Service-actor seam (additive auth)

**Files:**
- Create: `src/lib/mcp/service-actor.ts`
- Modify: `src/lib/clerk-auth.ts` (top of `getCurrentUser`)
- Modify: `src/middleware.ts`
- Test: `scripts/verify-service-actor.ts`

- [ ] **Step 1: Write the failing test** — `scripts/verify-service-actor.ts`

```typescript
// Pure validator for the internal service credential. No DB needed.
//   npx tsx scripts/verify-service-actor.ts
import { isValidServiceCredential } from "../src/lib/mcp/service-actor";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

assert(isValidServiceCredential("s3cret", "s3cret", "user_1") === true, "valid secret + actAs → true");
assert(isValidServiceCredential("s3cret", "wrong", "user_1") === false, "wrong secret → false");
assert(isValidServiceCredential("s3cret", "s3cret", null) === false, "missing actAs → false");
assert(isValidServiceCredential("s3cret", null, "user_1") === false, "missing header secret → false");
assert(isValidServiceCredential(undefined, "s3cret", "user_1") === false, "no env secret (feature off) → false");
assert(isValidServiceCredential("", "", "user_1") === false, "empty env secret → false");

console.log(`\n✅ ALL ${passed} SERVICE-ACTOR CHECKS PASSED`);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-service-actor.ts`
Expected: FAIL — cannot resolve `../src/lib/mcp/service-actor`.

- [ ] **Step 3: Implement `src/lib/mcp/service-actor.ts`**

```typescript
import { headers } from "next/headers";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncUserEntitlement } from "@/lib/entitlements";

export const SERVICE_SECRET_HEADER = "x-heroai-service-secret";
export const SERVICE_ACTAS_HEADER = "x-heroai-act-as";

/** Pure: is this (envSecret, headerSecret, actAsUserId) a valid internal service credential? */
export function isValidServiceCredential(
  envSecret: string | undefined,
  headerSecret: string | null,
  actAsUserId: string | null,
): boolean {
  if (!envSecret) return false;                  // feature off unless env set
  if (!headerSecret || headerSecret !== envSecret) return false;
  if (!actAsUserId) return false;
  return true;
}

/** The acted-as User if the request carries a valid internal service credential, else null. */
export async function resolveServiceActor(): Promise<User | null> {
  if (!process.env.MCP_SERVICE_SECRET) return null; // fast off-switch
  const h = await headers();
  const headerSecret = h.get(SERVICE_SECRET_HEADER);
  const actAs = h.get(SERVICE_ACTAS_HEADER);
  if (!isValidServiceCredential(process.env.MCP_SERVICE_SECRET, headerSecret, actAs)) return null;
  const user = await prisma.user.findUnique({ where: { id: actAs! } });
  if (!user) return null;
  await syncUserEntitlement(user.id).catch(() => {});
  return prisma.user.findUnique({ where: { id: user.id } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/verify-service-actor.ts`
Expected: `✅ ALL 6 SERVICE-ACTOR CHECKS PASSED`.

- [ ] **Step 5: Add the additive branch to `getCurrentUser`** — `src/lib/clerk-auth.ts`

Add the import at the top of the file (after the existing imports):
```typescript
import { resolveServiceActor } from "@/lib/mcp/service-actor";
```
Then make these the FIRST two lines inside `getCurrentUser()` (before `const { userId } = await auth();`):
```typescript
  const serviceActor = await resolveServiceActor();
  if (serviceActor) return serviceActor;
```
Leave every other line unchanged.

- [ ] **Step 6: Add the additive branch to `src/middleware.ts`**

Add, immediately after the line `if (isPublicRoute(req)) return NextResponse.next();` and BEFORE `if (!userId) {`:
```typescript
  // Internal service calls (MCP orchestrator) carry a server-only secret header.
  // PAT/entitlement are enforced inside each route via getCurrentUser → no Clerk session needed.
  const mcpSecret = process.env.MCP_SERVICE_SECRET;
  if (mcpSecret && req.headers.get("x-heroai-service-secret") === mcpSecret && req.headers.get("x-heroai-act-as")) {
    return NextResponse.next();
  }
```

- [ ] **Step 7: Confirm the existing Clerk path is unchanged (build + grep)**

Run: `npx tsc --noEmit 2>&1 | grep -E "clerk-auth|middleware|service-actor" || echo "OK no type errors"`
Expected: `OK no type errors`. The Clerk branch only runs when no valid service header is present (verified by the pure test + the early-return structure).

- [ ] **Step 8: Commit**

```bash
git add src/lib/mcp/service-actor.ts src/lib/clerk-auth.ts src/middleware.ts scripts/verify-service-actor.ts
git commit -m "feat(mcp): additive service-auth seam (getCurrentUser + middleware)"
```

---

### Task 3: `VideoJob` schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `videoJobs` relation to `User`**

Inside `model User`, after `mcpTokens     McpToken[]`, add:
```prisma
  videoJobs     VideoJob[]
```

- [ ] **Step 2: Add the `VideoJob` model** (after the `McpToken` model)

```prisma
model VideoJob {
  id             String    @id @default(cuid())
  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  videoId        String?
  type           String    @default("create")
  status         String    @default("queued") // queued|processing|done|failed|canceled
  currentStep    String?
  progress       Int       @default(0)
  inputJson      String
  outputJson     String?
  errorMessage   String?
  idempotencyKey String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  startedAt      DateTime?
  finishedAt     DateTime?

  @@unique([userId, idempotencyKey])
  @@index([status])
  @@index([userId])
}
```

- [ ] **Step 3: Sync dev DB + regenerate**

Run: `npx prisma db push && npx prisma generate`
Expected: "in sync"; client now exposes `prisma.videoJob`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(mcp): VideoJob model for headless create jobs"
```

---

### Task 4: Pure payload builders (TDD)

**Files:**
- Create: `src/lib/mcp/orchestrator-steps.ts`
- Test: `scripts/verify-mcp-orchestrator-steps.ts`

- [ ] **Step 1: Write the failing test** — `scripts/verify-mcp-orchestrator-steps.ts`

```typescript
//   npx tsx scripts/verify-mcp-orchestrator-steps.ts
import {
  DEFAULT_STYLE, maxCardCharsFor, buildKeywordsPayload, buildStockPayload,
  buildConfigPayload, buildBurnConfig,
} from "../src/lib/mcp/orchestrator-steps";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const caps = [
  { text: "สวัสดี", startMs: 0, endMs: 1000, tag: "hook" as const },
  { text: "โลก", startMs: 1000, endMs: 2000, tag: "body" as const },
];

assert(maxCardCharsFor(80) === Math.max(10, Math.floor((1080 - 160) / (80 * 0.47))), "maxCardChars matches editor formula");

const kw = buildKeywordsPayload(caps.map((c) => c.text), "สคริปต์", 2000);
assert(JSON.stringify(kw.scenes) === JSON.stringify(["สวัสดี", "โลก"]), "keywords payload scenes = caption texts");
assert(kw.audioDurationSec === 2 && kw.preferredLLM === null, "keywords payload duration + preferredLLM:null");

const stock = buildStockPayload(["a", "b"], 12, "both", caps);
assert(stock.keywords.length === 2 && stock.download === true && stock.stockSource === "both", "stock payload basics");
assert(stock.perSubtitleMode === true && stock.overrideClipCount === 2, "per-subtitle mode when caps==keywords count");

const cfg = buildConfigPayload(caps, [{ src: "x" }], "/v.mp3", 2000, ["สวัสดี", "โลก"], 5, [1, 1], [1, 1]);
assert(cfg.voiceFile === "/v.mp3" && cfg.audioDurationMs === 2000, "config payload voice/duration");
assert(cfg.subtitleStylePreset === DEFAULT_STYLE.subtitleStylePreset && cfg.fontFamily === DEFAULT_STYLE.fontFamily, "config uses default style");
assert(JSON.stringify(cfg.sceneClipCounts) === JSON.stringify([1, 1]), "config sceneClipCounts passthrough");

const burn = buildBurnConfig("/base.mp4", caps, 2000, 30);
assert(burn.videoUrl === "/base.mp4" && burn.durationInFrames === 60, "burn durationInFrames = round(ms/1000*fps)");
assert(burn.keywordPopups.length === 2, "one popup per caption");
const p0 = burn.keywordPopups[0];
assert(p0.start === 0 && p0.end === 30 && p0.isHighlight === true && p0.tag === "hook", "popup frame timing + hook highlight");
assert(p0.size === DEFAULT_STYLE.subtitleSize && p0.topPercent === DEFAULT_STYLE.subtitlePosition, "popup uses default style");

console.log(`\n✅ ALL ${passed} ORCHESTRATOR-STEP CHECKS PASSED`);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-mcp-orchestrator-steps.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mcp/orchestrator-steps.ts`**

```typescript
// PURE request-payload builders that reproduce the video-editor's non-avatar
// chain (verified against page.tsx 2026-06-13). No I/O — unit-testable.

export interface OrchCaption { text: string; startMs: number; endMs: number; tag: "hook" | "body" | "cta" }

export const DEFAULT_STYLE = {
  fontFamily: "'Kanit', sans-serif",
  subtitlePosition: 82,
  subtitleSize: 80,
  subtitleColor: "#ffffff",
  subtitleAccentColor: "#FFE500",
  subtitleStylePreset: "stroke",
  subtitleTextEffect: "pop",
  subtitleFontWeight: 900,
} as const;

export const DEFAULT_STOCK_SOURCE = "both";
export const RENDER_FPS = 30;
export const RENDER_JPEG_QUALITY = 85; // 720p

export function maxCardCharsFor(subtitleSize = DEFAULT_STYLE.subtitleSize): number {
  return Math.max(10, Math.floor((1080 - 160) / (subtitleSize * 0.47)));
}

export function buildKeywordsPayload(captionTexts: string[], script: string, audioDurationMs: number) {
  const scenes = captionTexts.length > 0 ? captionTexts : script.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return {
    scenes,
    audioDurationSec: Math.min(1800, Math.max(1, Math.round(audioDurationMs / 1000))),
    preferredLLM: null as string | null,
  };
}

export function buildStockPayload(
  keywords: string[],
  totalDurationSec: number,
  stockSource: string,
  captions: OrchCaption[],
  visualDirection?: string,
  keywordAlternatives?: string[][],
) {
  const perSubtitle = captions.length > 0 && captions.length === keywords.length;
  return {
    keywords,
    download: true as const,
    totalDurationSec: Math.max(30, Math.round(totalDurationSec)),
    stockSource,
    preferredLLM: null as string | null,
    ...(perSubtitle ? { perSubtitleMode: true, overrideClipCount: captions.length, subtitleTexts: captions.map((c) => c.text) } : {}),
    ...(visualDirection ? { visualDirection } : {}),
    ...(keywordAlternatives && keywordAlternatives.length ? { keywordAlternatives } : {}),
  };
}

export function buildConfigPayload(
  captions: OrchCaption[],
  stockVideos: unknown[],
  voiceFile: string,
  audioDurationMs: number,
  scenes: string[],
  keywordsPerScene: number,
  sceneClipCounts: number[],
  sceneDurations: number[],
) {
  return {
    sceneCaptions: captions,
    stockVideos,
    voiceFile,
    audioDurationMs,
    fontFamily: DEFAULT_STYLE.fontFamily,
    subtitlePosition: DEFAULT_STYLE.subtitlePosition,
    subtitleSize: DEFAULT_STYLE.subtitleSize,
    subtitleColor: DEFAULT_STYLE.subtitleColor,
    subtitleAccentColor: DEFAULT_STYLE.subtitleAccentColor,
    subtitleStylePreset: DEFAULT_STYLE.subtitleStylePreset,
    subtitleTextEffect: DEFAULT_STYLE.subtitleTextEffect,
    subtitleFontWeight: DEFAULT_STYLE.subtitleFontWeight,
    scenes,
    keywordsPerScene: keywordsPerScene || 5,
    sceneClipCounts,
    sceneDurations,
    preferredLLM: null as string | null,
  };
}

export function buildBurnConfig(baseVideoUrl: string, captions: OrchCaption[], audioDurationMs: number, fps = RENDER_FPS) {
  const lastEnd = captions.length ? captions[captions.length - 1].endMs : audioDurationMs;
  const durMs = Math.max(audioDurationMs, lastEnd);
  const keywordPopups = captions.map((c) => ({
    text: c.text,
    start: Math.round((c.startMs / 1000) * fps),
    end: Math.round((c.endMs / 1000) * fps),
    tag: c.tag,
    isHighlight: c.tag === "hook",
    color: c.tag === "hook" ? DEFAULT_STYLE.subtitleAccentColor : DEFAULT_STYLE.subtitleColor,
    accentColor: DEFAULT_STYLE.subtitleAccentColor,
    fontWeight: DEFAULT_STYLE.subtitleFontWeight,
    topPercent: DEFAULT_STYLE.subtitlePosition,
    size: DEFAULT_STYLE.subtitleSize,
    stylePreset: DEFAULT_STYLE.subtitleStylePreset,
  }));
  return {
    videoUrl: baseVideoUrl,
    keywordPopups,
    durationInFrames: Math.round((durMs / 1000) * fps),
    fontFamily: DEFAULT_STYLE.fontFamily,
    subtitleStylePreset: DEFAULT_STYLE.subtitleStylePreset,
    subtitleTextEffect: DEFAULT_STYLE.subtitleTextEffect,
    subtitleAccentColor: DEFAULT_STYLE.subtitleAccentColor,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/verify-mcp-orchestrator-steps.ts`
Expected: `✅ ALL <n> ORCHESTRATOR-STEP CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/orchestrator-steps.ts scripts/verify-mcp-orchestrator-steps.ts
git commit -m "feat(mcp): pure payload builders reproducing the editor non-avatar chain (tested)"
```

---

### Task 5: VideoJob lifecycle helpers (TDD)

**Files:**
- Create: `src/lib/mcp/video-job.ts`
- Test: `scripts/verify-mcp-videojob.ts`

- [ ] **Step 1: Write the failing test** — `scripts/verify-mcp-videojob.ts`

```typescript
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-videojob.ts
import { prisma } from "../src/lib/prisma";
import { createVideoJob, claimNextQueuedJob, setJobStep, finishJob, failJob } from "../src/lib/mcp/video-job";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

async function main() {
  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { name: "u", email: "u@t.test", plan: "PRO" } });

  const job = await createVideoJob(u.id, { script: "hi" });
  assert(job.status === "queued", "createVideoJob → queued");

  const claimed = await claimNextQueuedJob();
  assert(claimed?.id === job.id && claimed?.status === "processing", "claim flips queued→processing");
  assert((await claimNextQueuedJob()) === null, "no second claim of the same job");

  await setJobStep(job.id, "tts", 20);
  const mid = await prisma.videoJob.findUnique({ where: { id: job.id } });
  assert(mid?.currentStep === "tts" && mid?.progress === 20, "setJobStep updates step+progress");

  await finishJob(job.id, { videoUrl: "/v.mp4", videoId: "vid_1" });
  const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
  assert(done?.status === "done" && done?.videoId === "vid_1" && !!done?.outputJson, "finishJob → done + output");

  const job2 = await createVideoJob(u.id, { script: "x" });
  await claimNextQueuedJob();
  await failJob(job2.id, "boom");
  const failed = await prisma.videoJob.findUnique({ where: { id: job2.id } });
  assert(failed?.status === "failed" && failed?.errorMessage === "boom", "failJob → failed + message");

  // idempotency
  const a = await createVideoJob(u.id, { script: "k" }, "key1");
  let dup = false;
  try { await createVideoJob(u.id, { script: "k" }, "key1"); } catch { dup = true; }
  assert(dup, "duplicate idempotencyKey rejected");
  assert(!!a.id, "first idempotent job created");

  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} VIDEOJOB CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run (after the db push line above): `... npx tsx scripts/verify-mcp-videojob.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mcp/video-job.ts`**

```typescript
import { prisma } from "@/lib/prisma";

export async function createVideoJob(userId: string, input: unknown, idempotencyKey?: string) {
  return prisma.videoJob.create({
    data: { userId, inputJson: JSON.stringify(input), idempotencyKey: idempotencyKey ?? null, status: "queued" },
  });
}

/** Atomically claim the oldest queued job (processing). Returns it, or null if none. */
export async function claimNextQueuedJob() {
  const next = await prisma.videoJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
  if (!next) return null;
  const res = await prisma.videoJob.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "processing", startedAt: new Date() },
  });
  if (res.count !== 1) return null; // lost the race
  return prisma.videoJob.findUnique({ where: { id: next.id } });
}

export async function setJobStep(id: string, currentStep: string, progress: number) {
  await prisma.videoJob.update({ where: { id }, data: { currentStep, progress } });
}

export async function finishJob(id: string, output: { videoUrl: string; videoId?: string }) {
  await prisma.videoJob.update({
    where: { id },
    data: { status: "done", progress: 100, outputJson: JSON.stringify(output), videoId: output.videoId ?? null, finishedAt: new Date() },
  });
}

export async function failJob(id: string, message: string) {
  await prisma.videoJob.update({
    where: { id },
    data: { status: "failed", errorMessage: message.slice(0, 1000), finishedAt: new Date() },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `... npx tsx scripts/verify-mcp-videojob.ts`
Expected: `✅ ALL <n> VIDEOJOB CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/video-job.ts scripts/verify-mcp-videojob.ts
git commit -m "feat(mcp): VideoJob lifecycle helpers (tested)"
```

---

### Task 6: Pipeline client (service-authed fetch + render poll)

**Files:**
- Create: `src/lib/mcp/pipeline-client.ts`

No unit test (it's thin I/O glue; exercised by Task 7's mock test + the e2e). Keep it small.

- [ ] **Step 1: Implement `src/lib/mcp/pipeline-client.ts`**

```typescript
import { SERVICE_SECRET_HEADER, SERVICE_ACTAS_HEADER } from "@/lib/mcp/service-actor";

const BASE = process.env.MCP_INTERNAL_BASE_URL || "http://127.0.0.1:3000";

export interface PipelineCaller {
  post<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

/** A caller that authenticates every request as `userId` via the service seam. */
export function pipelineCaller(userId: string): PipelineCaller {
  const headers = {
    "Content-Type": "application/json",
    [SERVICE_SECRET_HEADER]: process.env.MCP_SERVICE_SECRET ?? "",
    [SERVICE_ACTAS_HEADER]: userId,
  };
  async function req<T>(method: "POST" | "GET", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  return {
    post: (path, body) => req("POST", path, body),
    get: (path) => req("GET", path),
  };
}

/** Poll /api/videos/render-progress until done/error or timeout. Returns the final videoUrl. */
export async function pollRender(
  caller: PipelineCaller,
  jobId: string,
  onProgress?: (pct: number, stage: string | null) => void,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await caller.get<{ progress: number; videoUrl: string | null; error: string | null; stage: string | null }>(
      `/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`,
    );
    onProgress?.(Number.isFinite(p.progress) ? p.progress : 0, p.stage);
    if (p.stage === "done" && p.videoUrl) return p.videoUrl;
    if (p.stage === "error" || (p.error && p.progress < 0)) throw new Error(`render failed: ${p.error ?? "unknown"}`);
    await sleep(interval);
  }
  throw new Error("render timed out");
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | grep pipeline-client || echo OK`
Expected: `OK`.
```bash
git add src/lib/mcp/pipeline-client.ts
git commit -m "feat(mcp): service-authed pipeline client + render poll"
```

---

### Task 7: Orchestrator runner (TDD with mock caller)

**Files:**
- Create: `src/lib/mcp/orchestrator.ts`
- Test: `scripts/verify-mcp-orchestrator.ts`

- [ ] **Step 1: Write the failing test** — `scripts/verify-mcp-orchestrator.ts`

```typescript
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-orchestrator.ts
import { prisma } from "../src/lib/prisma";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// A scripted mock caller: records calls, returns canned responses per path.
function mockCaller(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    caller: {
      async post<T>(path: string, body: unknown): Promise<T> { calls.push({ method: "POST", path, body }); return (responses[path] ?? {}) as T; },
      async get<T>(path: string): Promise<T> { calls.push({ method: "GET", path }); return (responses[path.split("?")[0]] ?? {}) as T; },
    },
  };
}

async function main() {
  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { name: "u", email: "u@t.test", plan: "PRO", geminiKey: "g", pexelsKey: "p", usageCount: 2 } });
  const job = await prisma.videoJob.create({ data: { userId: u.id, status: "processing", inputJson: JSON.stringify({ script: "สวัสดีโลก", voiceProvider: "gemini" }) } });

  const { calls, caller } = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/api/renders/v.wav", audioDurationMs: 2000, timing: { provider: "gemini", segments: [{ text: "สวัสดีโลก", startMs: 0, durationMs: 2000 }], chars: null } },
    "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
    "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
    "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/v.wav", bgVideos: [] } },
    "/api/videos/render": { jobId: "job-1" },
    "/api/videos/render-progress": { progress: 100, stage: "done", videoUrl: "/api/renders/out.mp4", error: null },
    "/api/videos": { id: "vid_1" },
    "/api/videos/vid_1": { ok: true },
  });

  let refunded = 0;
  await runOrchestrator(job.id, u.id, {
    caller: caller as never,
    refundOneClip: async () => { refunded++; },
    sleep: async () => {},
  });

  const paths = calls.map((c) => c.path.split("?")[0]);
  assert(paths.includes("/api/videos/tts-gemini"), "calls tts-gemini for gemini provider");
  assert(paths.indexOf("/api/videos/extract-keywords") < paths.indexOf("/api/videos/fetch-stock"), "keywords before stock");
  assert(paths.indexOf("/api/videos/generate-config") < paths.indexOf("/api/videos/render"), "config before render");
  assert(paths.filter((p) => p === "/api/videos/render").length === 2, "two render calls (base + burn)");
  assert(refunded === 1, "refunds exactly one clip (net 1/video)");

  const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
  assert(done?.status === "done" && done?.videoId === "vid_1", "job → done with videoId");

  // failure path: render returns error stage
  const job2 = await prisma.videoJob.create({ data: { userId: u.id, status: "processing", inputJson: JSON.stringify({ script: "x", voiceProvider: "gemini" }) } });
  const m2 = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/v", audioDurationMs: 1000, timing: { provider: "gemini", segments: [{ text: "x", startMs: 0, durationMs: 1000 }], chars: null } },
    "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [1] },
    "/api/videos/fetch-stock": { results: [] },
    "/api/videos/generate-config": { config: {} },
    "/api/videos/render": { jobId: "j2" },
    "/api/videos/render-progress": { progress: -1, stage: "error", videoUrl: null, error: "render boom" },
  });
  await runOrchestrator(job2.id, u.id, { caller: m2.caller as never, refundOneClip: async () => {}, sleep: async () => {} });
  const failed = await prisma.videoJob.findUnique({ where: { id: job2.id } });
  assert(failed?.status === "failed" && (failed?.errorMessage ?? "").includes("render"), "render error → job failed");

  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} ORCHESTRATOR CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `... npx tsx scripts/verify-mcp-orchestrator.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mcp/orchestrator.ts`**

```typescript
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { refundClipUsage } from "@/lib/usage-limits";
import { captionsFromTtsTiming } from "@/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { setJobStep, finishJob, failJob } from "@/lib/mcp/video-job";
import { pipelineCaller, pollRender, type PipelineCaller } from "@/lib/mcp/pipeline-client";
import {
  DEFAULT_STOCK_SOURCE, RENDER_FPS, RENDER_JPEG_QUALITY, maxCardCharsFor,
  buildKeywordsPayload, buildStockPayload, buildConfigPayload, buildBurnConfig, type OrchCaption,
} from "@/lib/mcp/orchestrator-steps";

export interface OrchestratorDeps {
  caller?: PipelineCaller;
  refundOneClip?: (userId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

interface CreateInput { script: string; title?: string; voiceProvider?: "gemini" | "elevenlabs"; voiceId?: string }

export async function runOrchestrator(jobId: string, userId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const caller = deps.caller ?? pipelineCaller(userId);
  const refund = deps.refundOneClip ?? refundClipUsage;
  const sleep = deps.sleep;
  try {
    const job = await prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    const input = JSON.parse(job.inputJson) as CreateInput;
    const user = (await prisma.user.findUnique({ where: { id: userId } })) as User;
    const provider = input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");

    // 1. TTS
    await setJobStep(jobId, "tts", 10);
    const tts = provider === "elevenlabs"
      ? await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts", { text: input.script, voiceId: input.voiceId ?? user.elevenlabsVoiceId ?? undefined, languageCode: "th" })
      : await caller.post<{ voiceUrl: string; audioDurationMs?: number; timing?: unknown }>("/api/videos/tts-gemini", { text: input.script, voiceName: user.geminiVoiceName ?? "Aoede" });
    const audioDurationMs = tts.audioDurationMs ?? 0;

    // 2. Captions (in-process, reuse pure lib)
    await setJobStep(jobId, "captions", 25);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capRes = captionsFromTtsTiming(tts.timing as any, audioDurationMs, maxCardCharsFor());
    if (!capRes || capRes.captions.length === 0) throw new Error("ไม่มี subtitle timing จาก TTS — ลองใหม่อีกครั้ง");
    const captions = capRes.captions as OrchCaption[];
    const durMs = capRes.audioDurationMs || audioDurationMs;

    // 3. Keywords
    await setJobStep(jobId, "keywords", 40);
    const kw = await caller.post<{ keywords: string[]; keywordsPerScene?: number; sceneClipCounts?: number[]; sceneDurations?: number[]; visualDirection?: string; keywordAlternatives?: string[][] }>(
      "/api/videos/extract-keywords", buildKeywordsPayload(captions.map((c) => c.text), input.script, durMs),
    );

    // 4. Stock
    await setJobStep(jobId, "stock", 55);
    const totalDur = (kw.sceneDurations ?? []).reduce((a, b) => a + b, 0) || Math.round(durMs / 1000);
    const stock = await caller.post<{ results: unknown[] }>(
      "/api/videos/fetch-stock", buildStockPayload(kw.keywords ?? [], totalDur, DEFAULT_STOCK_SOURCE, captions, kw.visualDirection, kw.keywordAlternatives),
    );

    // 5. Config
    await setJobStep(jobId, "config", 65);
    const sceneClipCounts = captions.length === (kw.keywords ?? []).length ? captions.map(() => 1) : (kw.sceneClipCounts ?? []);
    const cfgRes = await caller.post<{ config: Record<string, unknown> }>(
      "/api/videos/generate-config",
      buildConfigPayload(captions, stock.results ?? [], tts.voiceUrl, durMs, captions.map((c) => c.text), kw.keywordsPerScene ?? 5, sceneClipCounts, kw.sceneDurations ?? []),
    );

    // 6. Base render
    await setJobStep(jobId, "render", 75);
    const r1 = await caller.post<{ jobId: string }>("/api/videos/render", {
      shortVideoConfig: { ...cfgRes.config, keywordPopups: [] }, fps: RENDER_FPS, jpegQuality: RENDER_JPEG_QUALITY,
    });
    const baseUrl = await pollRender(caller, r1.jobId, (pct) => setJobStep(jobId, "render", 75 + Math.round(pct * 0.1)).catch(() => {}), { sleep });

    // 7. Create Video row (PROCESSING)
    const created = await caller.post<{ id: string }>("/api/videos", {
      videoUrl: baseUrl, audioUrl: tts.voiceUrl, thumbnail: null, script: input.script.trim() || null,
      avatarModel: "none", voiceModel: provider === "elevenlabs" ? (input.voiceId ?? "elevenlabs") : (user.geminiVoiceName ?? "gemini"),
      sceneCount: captions.length, renderConfig: cfgRes.config, status: "PROCESSING",
    });

    // 8. Burn subtitles (2nd render) → refund 1 clip so 1 video = 1 clip
    await setJobStep(jobId, "burn", 88);
    const r2 = await caller.post<{ jobId: string }>("/api/videos/render", { subtitleOverlayConfig: buildBurnConfig(baseUrl, captions, durMs, RENDER_FPS) });
    const burnedUrl = await pollRender(caller, r2.jobId, (pct) => setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}), { sleep });
    await refund(userId).catch(() => {});

    // 9. Update Video row → COMPLETED
    await caller.post(`/api/videos/${created.id}`, { videoUrl: burnedUrl, status: "COMPLETED" });

    await finishJob(jobId, { videoUrl: burnedUrl, videoId: created.id });
  } catch (e) {
    await failJob(jobId, e instanceof Error ? e.message : "internal error");
  }
}
```

> NOTE for the implementer: `POST` to `/api/videos/${id}` is used for the COMPLETED update. Verify in Task 1 whether the gallery update is `PATCH` (editor uses PATCH at `/api/videos/{id}`). If the route only accepts PATCH, add a `patch()` method to `PipelineCaller` (mirror `post`) and use it here. The mock test treats it as a generic call so both work in tests; the e2e (Task 11) is where the real method matters — fix it there if the PATCH/POST distinction bites.

- [ ] **Step 4: Run the test to verify it passes**

Run: `... npx tsx scripts/verify-mcp-orchestrator.ts`
Expected: `✅ ALL <n> ORCHESTRATOR CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/orchestrator.ts scripts/verify-mcp-orchestrator.ts
git commit -m "feat(mcp): headless create orchestrator (mock-tested step sequencing + refund)"
```

---

### Task 8: `create_video_job` tool + `get_video_status` upgrade

**Files:**
- Modify: `src/app/api/[transport]/route.ts`

- [ ] **Step 1: Add imports at the top of the route**

```typescript
import { z } from "zod"; // already imported in Phase A
import { prisma } from "@/lib/prisma";
import { createVideoJob } from "@/lib/mcp/video-job";
import { checkClipQuota } from "@/lib/usage-limits";
```
(If `prisma`/`z` are already imported from Phase A, don't duplicate.)

- [ ] **Step 2: Register `create_video_job` inside the `createMcpHandler` server callback** (next to the Phase A tools)

```typescript
    server.registerTool(
      "create_video_job",
      {
        title: "Create video job",
        description: "สร้างวิดีโอ auto (เสียง+b-roll+ซับไทย) จากสคริปต์ แบบ async — คืน jobId แล้ว poll ด้วย get_video_status",
        inputSchema: {
          script: z.string().min(1).max(20000),
          title: z.string().max(200).optional(),
          voiceProvider: z.enum(["gemini", "elevenlabs"]).optional(),
          voiceId: z.string().optional(),
          idempotencyKey: z.string().max(120).optional(),
        },
      },
      async (args, extra) =>
        runTool("create_video_job", extra, async (p) => {
          // BYOK precheck: standard auto video needs Gemini (keywords/config) + a stock key
          const u = p.user;
          const needGemini = (args.voiceProvider ?? (u.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini")) === "gemini";
          if (needGemini && !u.geminiKey) return { error: "missing_key", message: "ต้องตั้งค่า Gemini key ก่อน" };
          if ((args.voiceProvider === "elevenlabs" || u.ttsProvider === "elevenlabs") && !u.elevenlabsKey) return { error: "missing_key", message: "ต้องตั้งค่า ElevenLabs key ก่อน" };
          if (!u.geminiKey) return { error: "missing_key", message: "ต้องตั้งค่า Gemini key ก่อน (ใช้กับ keywords/config)" };
          if (!u.pexelsKey && !u.pixabayKey) return { error: "missing_key", message: "ต้องตั้งค่า Pexels หรือ Pixabay key ก่อน (สำหรับ b-roll)" };
          // quota precheck (render route does the real atomic reserve)
          const q = await checkClipQuota(p.userId);
          if (q && !q.allowed) return { error: "quota_exceeded", message: q.message };
          try {
            const job = await createVideoJob(p.userId, { script: args.script, title: args.title, voiceProvider: args.voiceProvider, voiceId: args.voiceId }, args.idempotencyKey);
            return { jobId: job.id, status: "queued", message: "งานเข้าคิวแล้ว — เช็คด้วย get_video_status" };
          } catch {
            return { error: "duplicate", message: "idempotencyKey นี้ถูกใช้แล้ว" };
          }
        }, args),
    );
```

- [ ] **Step 3: Upgrade `get_video_status` to also read VideoJob**

Replace the Phase A `get_video_status` registration body with one that checks VideoJob first, then falls back to Video:
```typescript
    server.registerTool(
      "get_video_status",
      { title: "Get video/job status", description: "สถานะของ video job หรือ video 1 รายการ", inputSchema: { id: z.string().min(1) } },
      async (args, extra) =>
        runTool("get_video_status", extra, async (p) => {
          const job = await prisma.videoJob.findFirst({ where: { id: args.id, userId: p.userId } });
          if (job) {
            const out = job.outputJson ? JSON.parse(job.outputJson) as { videoUrl?: string } : null;
            return { kind: "job" as const, jobId: job.id, status: job.status, currentStep: job.currentStep, progress: job.progress, videoUrl: out?.videoUrl ?? null, error: job.errorMessage ?? null };
          }
          const v = await getVideoStatusTool(p.userId, args.id); // Phase A fallback (param name was videoId)
          return { kind: "video" as const, ...v };
        }, args),
    );
```
> The Phase A `get_video_status` used input field `videoId`; this upgrade renames it to `id` and accepts either a job id or a video id. Ensure the Phase A registration is REPLACED (not duplicated).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "\[transport\]" || echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/[transport]/route.ts"
git commit -m "feat(mcp): create_video_job tool + get_video_status reads VideoJob"
```

---

### Task 9: Worker (PM2 app)

**Files:**
- Create: `scripts/mcp-video-worker.ts`
- Modify: `ecosystem.config.js`

- [ ] **Step 1: Implement `scripts/mcp-video-worker.ts`**

```typescript
// MCP headless video worker: claims queued VideoJobs and runs the orchestrator.
// Start (prod): export MCP_SERVICE_SECRET=...; pm2 start ecosystem.config.js --only mcp-video-worker --update-env && pm2 save
import { prisma } from "../src/lib/prisma";
import { claimNextQueuedJob } from "../src/lib/mcp/video-job";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";

const POLL_MS = Number(process.env.MCP_WORKER_POLL_MS ?? 4000);
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function tick() {
  const job = await claimNextQueuedJob();
  if (!job) return false;
  console.log(`[mcp-worker] running job ${job.id} for user ${job.userId}`);
  await runOrchestrator(job.id, job.userId); // orchestrator never throws (wraps in failJob)
  console.log(`[mcp-worker] finished job ${job.id}`);
  return true;
}

async function main() {
  if (!process.env.MCP_SERVICE_SECRET) { console.error("[mcp-worker] MCP_SERVICE_SECRET not set — refusing to start"); process.exit(1); }
  console.log("[mcp-worker] started");
  while (running) {
    try {
      const did = await tick();
      if (!did) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      console.error("[mcp-worker] tick error:", e);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  await prisma.$disconnect();
  console.log("[mcp-worker] stopped");
}
main();
```

- [ ] **Step 2: Add the PM2 app to `ecosystem.config.js`**

Add to the `apps` array (mirror the existing cron app shape; use `tsx` to run TS):
```javascript
    {
      name: "mcp-video-worker",
      script: "npx",
      args: "tsx scripts/mcp-video-worker.ts",
      cwd: __dirname,
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
```
> Match the actual field style of the existing entries in this file (interpreter/args may differ — open `ecosystem.config.js` and copy the cron pattern). The worker reads `MCP_SERVICE_SECRET` + `MCP_INTERNAL_BASE_URL` from the process env (start with `--update-env` after exporting them, like the other crons per CLAUDE.md).

- [ ] **Step 3: Commit**

```bash
git add scripts/mcp-video-worker.ts ecosystem.config.js
git commit -m "feat(mcp): VideoJob worker (PM2 app)"
```

---

### Task 10: Env wiring

**Files:**
- Modify: `.env` (local) — and document for prod `.env`

- [ ] **Step 1: Add env vars to local `.env`**

```bash
printf '\nMCP_SERVICE_SECRET=%s\nMCP_INTERNAL_BASE_URL=http://127.0.0.1:3000\n' "$(openssl rand -hex 32)" >> .env
```
> `MCP_SERVICE_SECRET` must be IDENTICAL in the web process and the worker process (the web process validates the header the worker sends). On prod, set the same value in `/var/www/ai-content/.env` and start the worker with `--update-env`. `.env` is gitignored — do NOT commit secrets.

- [ ] **Step 2: Sanity — secret is long + both processes will read the same file**

Run: `grep -c '^MCP_SERVICE_SECRET=' .env`
Expected: `1`.

- [ ] **Step 3: Commit (no secret — nothing tracked changes)**

Nothing to commit (`.env` is gitignored). Note the new vars in the PR description and in `CLAUDE.md`'s deploy section as a follow-up.

---

### Task 11: End-to-end on local dev (manual)

**Files:** none (verification)

- [ ] **Step 1: Start the web server + worker locally**

```bash
# terminal A
npm run dev
# terminal B (same MCP_SERVICE_SECRET from .env is loaded by both)
npx tsx scripts/mcp-video-worker.ts
```

- [ ] **Step 2: Ensure the dev PRO user has the needed BYOK keys**

The local user is `mewtest+clerk_test@example.com` (PRO). It needs `geminiKey` + (`pexelsKey` or `pixabayKey`) set (and `elevenlabsKey` if using ElevenLabs). Set them via the Settings → API Keys UI, or directly in dev.db.

- [ ] **Step 3: Drive it via a real PAT**

Mint a PAT (`npx tsx scripts/mint-dev-mcp-token.ts mewtest+clerk_test@example.com`), connect with `claude mcp add --transport http heroai-local http://localhost:3000/api/mcp --header "Authorization: Bearer <PAT>"`, then ask the agent to call `create_video_job` with a short Thai script. It should return a `jobId`. Then call `get_video_status` repeatedly — watch `currentStep` advance tts→captions→keywords→stock→config→render→burn and end `done` with a `videoUrl`.

- [ ] **Step 4: Verify the result + quota**

Open the returned `videoUrl` — a finished video with burned Thai subtitles. Check `usageCount` rose by exactly **1** (base+burn reserved 2, orchestrator refunded 1). Confirm a `Video` row exists with `status: "COMPLETED"`.

- [ ] **Step 5: Failure path**

Remove the user's `pexelsKey`/`pixabayKey` and call `create_video_job` → expect a `missing_key` message immediately (gate), not a stuck job. Then with a deliberately broken provider key, watch a job go `failed` with a clear `errorMessage` (not stuck `processing`).

- [ ] **Step 6: Cleanup**

```bash
claude mcp remove heroai-local
rm -f prisma/test-mcp.db
```

---

## Self-Review

**Spec coverage (vs `…phaseB-mvp-design…`):**
- §1 scope (standard auto video, non-avatar, defaults, burned subs) → Tasks 4/7/11. ✓
- §3 architecture (create_video_job → VideoJob → worker → orchestrator → reuse endpoints + service seam) → Tasks 2,3,7,8,9. ✓
- §4 auth seam (resolveServiceActor + getCurrentUser + middleware) → Task 2. ✓
- §5 VideoJob model → Task 3; lifecycle → Task 5. ✓
- §6 tools (create_video_job, get_video_status upgrade) → Task 8. ✓
- §7 worker → Task 9. ✓
- §8 quota double-reserve → orchestrator refunds 1 after burn (Task 7), verified in Task 11 step 4. ✓
- §9 open items: full runAll trace embedded in Task 4/7 payloads; double-reserve resolved (refund-1); provider select (Task 7); burn payload (Task 4 `buildBurnConfig`); middleware (Task 2 step 6); endpoint-uses-getCurrentUser (Task 1). ✓
- §10 testing → verify scripts in Tasks 2,4,5,7 + manual Task 11. ✓

**Placeholder scan:** The two NOTE blocks (Task 7 POST-vs-PATCH, Task 9 ecosystem shape) are explicit "verify the exact form in the existing file" instructions with the fallback spelled out — not vague TODOs. Task 1 is a verification gate with concrete grep + contingency. No "add error handling"-style placeholders.

**Type consistency:** `OrchCaption {text,startMs,endMs,tag}` is consistent across steps + orchestrator; `captionsFromTtsTiming` returns `{captions,words,audioDurationMs}` (captions are `{text,startMs,endMs,tag}` — compatible with OrchCaption). VideoJob helper names (`createVideoJob/claimNextQueuedJob/setJobStep/finishJob/failJob`) match between Task 5 and their callers in Tasks 7/8/9. `pipelineCaller`/`pollRender` signatures match Task 6 ↔ Task 7.

## Risks / verify-at-execution
- **Task 7 NOTE (PATCH vs POST for the COMPLETED update)** — confirm against `/api/videos/[id]/route.ts` (Task 1 already reads it).
- **`captionsFromTtsTiming` server import** — it imports a local `./types` (`Caption`); confirm that file has no `"use client"`/browser deps (inspection said it's a pure types module). If it drags client-only code, copy the 3 needed fns' call into a tiny server shim over `@/lib/tts-timing` instead.
- **Process env parity** — worker + web must share `MCP_SERVICE_SECRET` (Task 10).
- **Not in MVP:** avatar/composite, custom style, rerun/cancel, OAuth, worker concurrency >1, "no b-roll".
