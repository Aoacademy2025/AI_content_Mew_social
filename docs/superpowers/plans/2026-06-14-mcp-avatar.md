# MCP Avatar Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `create_video_job` (MCP) produce avatar videos (HeyGen) in `full` / `bookend` / `bookend-both` modes, reusing the existing web endpoints from the worker.

**Architecture:** Approach A (sequential). After the base render, a new `src/lib/mcp/avatar-steps.ts` calls the existing web endpoints through the service-auth seam (`pipeline-client`): trim-audio → generate-with-bg → poll-avatar → composite. Subtitles are then burned onto the composite. No Prisma/`renderConfig`/middleware/nginx changes.

**Tech Stack:** Next.js API routes, Prisma (SQLite), the MCP service-auth seam (`x-heroai-service-secret` + `x-heroai-act-as`), HeyGen + FFmpeg (chromakey), `tsx` verify scripts.

**Spec:** `docs/superpowers/specs/2026-06-14-mcp-avatar-design.md`

---

## Ground truth (verified, file:line)

Endpoint request/response shapes the worker will call (all auth via `getCurrentUser` → service seam works headlessly; middleware `src/middleware.ts:58-61` passes any path with a valid service header; the worker hits `127.0.0.1:3000` directly, bypassing nginx):

- **POST `/api/videos/trim-audio`** body `{ audioUrl, durationSecs?, tailSecs? }` → `{ audioUrl }`. intro = `durationSecs`; tail = `tailSecs`. (`route.ts:38-108`)
- **POST `/api/heygen/generate-with-bg`** body `{ audioUrl, avatarId, greenScreen:true, scale, offsetX, offsetY }` → `{ videoId, bgAssetId }` (videoId = HeyGen `video_id`). (`route.ts:100-261`)
- **POST `/api/videos/poll-avatar`** body `{ videoId }` → `{ status, videoUrl, thumbnailUrl, errorMsg }`. Terminal: `status==="completed"` (videoUrl set) or `status==="failed"`; everything else = keep polling. (`route.ts:21-83`, `src/lib/heygen-poll.ts:17-21`)
- **POST `/api/heygen/composite`** body `{ avatarVideoUrl, tailAvatarVideoUrl?, bgVideoUrl, mode:"chromakey", avatarTiming, avatarBookendSecs, avatarTailSecs, avatarLayout }` → `{ videoUrl, usedMode }`. `bookend-both` split triggers when `tailAvatarVideoUrl` present. FREE plan → 403 (we gate PRO/BUSINESS upstream). (`route.ts:466-571`)

Orchestrator today: `src/lib/mcp/orchestrator.ts:20-98` — base render → `baseUrl` (`:73`), refund (`:77`), POST `/api/videos` with `avatarModel:"none"` (`:82`), burn `buildBurnConfig(baseUrl,…)` (`:88`). `CreateInput` is at `:18`. `createVideoJob(userId, input, idempotencyKey)` stores `JSON.stringify(input)` (`src/lib/mcp/video-job.ts:3-7`).

Onboarding copy: `src/lib/mcp/onboarding.ts` — `PROVIDERS` map, `missingKeyError(which)`, `SETTINGS_URL`.

---

## File structure

- **Create** `src/lib/mcp/avatar-steps.ts` — `AvatarMode`, `AVATAR_LAYOUT`, `clampSecs`, `resolveAvatarRequest` (pure gating), `pollAvatar`, `runAvatarComposite`.
- **Modify** `src/lib/mcp/onboarding.ts` — add `heygen` to `PROVIDERS`, support `missingKeyError("heygen")`, add `missingAvatarError()`.
- **Modify** `src/app/api/[transport]/route.ts` — add 4 avatar params to `create_video_job` `inputSchema`; gate via `resolveAvatarRequest`; persist avatar fields into the job input.
- **Modify** `src/lib/mcp/orchestrator.ts` — extend `CreateInput`; when `avatarMode` set, run `runAvatarComposite` after base render; create Video + burn on the composite; set `avatarModel`/`avatarVideoUrl`.
- **Create** `scripts/verify-mcp-avatar-input.ts` — gating/clamp unit tests.
- **Create** `scripts/verify-avatar-steps.ts` — avatar-steps tests with a mock caller.
- **Modify** `scripts/verify-mcp-orchestrator.ts` — add an avatar-path case (extend existing mock).

---

## Task 1: Onboarding copy — HeyGen provider + `missing_avatar`

**Files:**
- Modify: `src/lib/mcp/onboarding.ts`
- Test: `scripts/verify-mcp-onboarding.ts` (extend existing)

- [ ] **Step 1: Add failing assertions** to the end of `scripts/verify-mcp-onboarding.ts`, just before the final `console.log`:

```ts
// --- HeyGen key + missing avatar (avatar feature) ---
import { missingAvatarError } from "../src/lib/mcp/onboarding";
const hg = missingKeyError("heygen");
assert(hg.error === "missing_key" && hg.message.includes("heygen.com") && hg.message.includes(SETTINGS_URL),
  "heygen missing-key links the HeyGen API page and Settings");
const noav = missingAvatarError();
assert(noav.error === "missing_avatar" && noav.message.includes("avatarId"),
  "missing_avatar explains how to set/pass an avatarId");
```

(Move the `import` to the top with the other imports — shown inline here for locality.)

- [ ] **Step 2: Run — verify it fails**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/verify-mcp-onboarding.ts`
Expected: FAIL — `missingKeyError` has no `"heygen"` branch / `missingAvatarError` not exported.

- [ ] **Step 3: Implement** in `src/lib/mcp/onboarding.ts`. Add a `heygen` entry to `PROVIDERS`:

```ts
  heygen: {
    label: "HeyGen",
    whatFor: "avatar พิธีกร AI (ต้องมีตอนสั่งวิดีโอแบบมี avatar)",
    getKeyUrl: "https://app.heygen.com/settings?nav=API",
  },
```

Extend the `which` union and add the branch in `missingKeyError`:

```ts
export function missingKeyError(which: "gemini" | "broll" | "elevenlabs" | "heygen") {
  // ...existing branches...
  if (which === "heygen") return { error: "missing_key", message: `ยังไม่ได้ตั้งค่า HeyGen key — ${howTo(PROVIDERS.heygen)}` };
  // ...broll fallthrough stays last...
}
```

Add a new export:

```ts
/** Using avatar but no avatarId resolvable — guide the user to set one. */
export function missingAvatarError() {
  return {
    error: "missing_avatar",
    message: `ยังไม่ได้ตั้ง Avatar — ตั้งค่า Avatar (heygenAvatarId) ที่ ${SETTINGS_URL} หรือส่ง avatarId มากับคำสั่ง create_video_job`,
  };
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/verify-mcp-onboarding.ts`
Expected: PASS (all prior + 2 new assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/onboarding.ts scripts/verify-mcp-onboarding.ts
git commit -m "feat(mcp): onboarding copy for HeyGen key + missing_avatar"
```

---

## Task 2: `avatar-steps.ts` — pure gating (`resolveAvatarRequest` + `clampSecs`)

**Files:**
- Create: `src/lib/mcp/avatar-steps.ts`
- Test: `scripts/verify-mcp-avatar-input.ts`

- [ ] **Step 1: Write the failing test** `scripts/verify-mcp-avatar-input.ts`:

```ts
// Pure gating for avatar in create_video_job: mode validation, key/avatar requirements,
// avatarId resolution (arg → user default), and intro/tail clamps.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-avatar-input.ts
import { resolveAvatarRequest, clampSecs } from "../src/lib/mcp/avatar-steps";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const withKey = { heygenKey: "k", heygenAvatarId: "saved-av" };
const noKey = { heygenKey: null, heygenAvatarId: "saved-av" };

assert(resolveAvatarRequest({}, withKey).kind === "none", "no avatarMode → none");
assert(resolveAvatarRequest({ avatarMode: "none" }, withKey).kind === "none", "avatarMode none → none");

const bad = resolveAvatarRequest({ avatarMode: "weird" }, withKey);
assert(bad.kind === "error" && bad.payload.error === "bad_request", "invalid avatarMode → bad_request");

const nok = resolveAvatarRequest({ avatarMode: "full" }, noKey);
assert(nok.kind === "error" && nok.payload.error === "missing_key", "full without heygenKey → missing_key");

const noav = resolveAvatarRequest({ avatarMode: "full" }, { heygenKey: "k", heygenAvatarId: null });
assert(noav.kind === "error" && noav.payload.error === "missing_avatar", "no avatarId anywhere → missing_avatar");

const useSaved = resolveAvatarRequest({ avatarMode: "bookend" }, withKey);
assert(useSaved.kind === "ok" && useSaved.avatarId === "saved-av" && useSaved.avatarMode === "bookend", "falls back to user.heygenAvatarId");

const override = resolveAvatarRequest({ avatarMode: "full", avatarId: "arg-av" }, withKey);
assert(override.kind === "ok" && override.avatarId === "arg-av", "arg avatarId overrides saved");

const secs = resolveAvatarRequest({ avatarMode: "bookend-both", avatarIntroSecs: 0, avatarTailSecs: 999 }, withKey);
assert(secs.kind === "ok" && secs.introSecs === 1 && secs.tailSecs === 30, "intro/tail secs clamped to 1..30");

const def = resolveAvatarRequest({ avatarMode: "bookend-both" }, withKey);
assert(def.kind === "ok" && def.introSecs === 5 && def.tailSecs === 5, "intro/tail default to 5");

assert(clampSecs(undefined, 5) === 5 && clampSecs(0, 5) === 1 && clampSecs(100, 5) === 30 && clampSecs(7, 5) === 7, "clampSecs behaves");

console.log(`\n${passed} assertions passed ✅`);
```

- [ ] **Step 2: Run — verify it fails**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/verify-mcp-avatar-input.ts`
Expected: FAIL — `Cannot find module ../src/lib/mcp/avatar-steps`.

- [ ] **Step 3: Create `src/lib/mcp/avatar-steps.ts`** with the pure parts:

```ts
import type { PipelineCaller } from "@/lib/mcp/pipeline-client";
import { missingKeyError, missingAvatarError } from "@/lib/mcp/onboarding";

export type AvatarMode = "none" | "full" | "bookend" | "bookend-both";
export const AVATAR_LAYOUT = { scale: 2.02, offsetX: 0, offsetY: 0.13 } as const;

export function clampSecs(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

type AvatarArgs = { avatarMode?: string; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number };
type AvatarUser = { heygenKey: string | null; heygenAvatarId: string | null };
type ErrPayload = { error: string; message: string };

export type AvatarResolution =
  | { kind: "none" }
  | { kind: "error"; payload: ErrPayload }
  | { kind: "ok"; avatarMode: "full" | "bookend" | "bookend-both"; avatarId: string; introSecs: number; tailSecs: number };

export function resolveAvatarRequest(args: AvatarArgs, user: AvatarUser): AvatarResolution {
  const mode = args.avatarMode ?? "none";
  if (mode === "none") return { kind: "none" };
  if (mode !== "full" && mode !== "bookend" && mode !== "bookend-both")
    return { kind: "error", payload: { error: "bad_request", message: `avatarMode ไม่ถูกต้อง: ${mode}` } };
  if (!user.heygenKey) return { kind: "error", payload: missingKeyError("heygen") };
  const avatarId = args.avatarId ?? user.heygenAvatarId ?? "";
  if (!avatarId) return { kind: "error", payload: missingAvatarError() };
  return { kind: "ok", avatarMode: mode, avatarId, introSecs: clampSecs(args.avatarIntroSecs, 5), tailSecs: clampSecs(args.avatarTailSecs, 5) };
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/verify-mcp-avatar-input.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/avatar-steps.ts scripts/verify-mcp-avatar-input.ts
git commit -m "feat(mcp): avatar request gating (resolveAvatarRequest)"
```

---

## Task 3: `avatar-steps.ts` — `pollAvatar` + `runAvatarComposite`

**Files:**
- Modify: `src/lib/mcp/avatar-steps.ts`
- Test: `scripts/verify-avatar-steps.ts`

- [ ] **Step 1: Write the failing test** `scripts/verify-avatar-steps.ts`:

```ts
// avatar-steps orchestration against a mock PipelineCaller: correct endpoint calls per mode
// and burn target = compositeUrl.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-avatar-steps.ts
import { runAvatarComposite, pollAvatar } from "../src/lib/mcp/avatar-steps";
import type { PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }
const noSleep = (_ms: number) => Promise.resolve();

// Mock caller: records POSTs, returns canned responses by path.
function mock(pollSeq: Record<string, string[]>) {
  const calls: { path: string; body: any }[] = [];
  const pollIdx: Record<string, number> = {};
  const caller: PipelineCaller = {
    async post<T>(path: string, body: any): Promise<T> {
      calls.push({ path, body });
      if (path === "/api/videos/trim-audio") return { audioUrl: `trimmed:${body.durationSecs ?? "T" + body.tailSecs}` } as T;
      if (path === "/api/heygen/generate-with-bg") return { videoId: `hg-${body.audioUrl}` } as T;
      if (path === "/api/videos/poll-avatar") {
        const seq = pollSeq[body.videoId] ?? ["completed"];
        const i = Math.min(pollIdx[body.videoId] ?? 0, seq.length - 1);
        pollIdx[body.videoId] = (pollIdx[body.videoId] ?? 0) + 1;
        const status = seq[i];
        return { status, videoUrl: status === "completed" ? `avatar:${body.videoId}` : null, thumbnailUrl: null, errorMsg: status === "failed" ? "boom" : null } as T;
      }
      if (path === "/api/heygen/composite") return { videoUrl: "COMPOSITE", usedMode: "chromakey" } as T;
      throw new Error("unexpected path " + path);
    },
    patch: async () => ({} as any),
    get: async () => ({} as any),
  };
  return { caller, calls };
}

// full: no trim, 1 gen, composite without tailAvatarVideoUrl
{
  const { caller, calls } = mock({});
  const r = await runAvatarComposite(caller, { baseUrl: "BASE", ttsAudioUrl: "TTS", avatarMode: "full", avatarId: "av", introSecs: 5, tailSecs: 5, sleep: noSleep });
  assert(r.compositeUrl === "COMPOSITE", "full → compositeUrl returned");
  assert(!calls.some((c) => c.path === "/api/videos/trim-audio"), "full → no trim-audio");
  const gens = calls.filter((c) => c.path === "/api/heygen/generate-with-bg");
  assert(gens.length === 1 && gens[0].body.audioUrl === "TTS" && gens[0].body.greenScreen === true, "full → 1 gen from full TTS audio, greenScreen");
  const comp = calls.find((c) => c.path === "/api/heygen/composite")!;
  assert(comp.body.bgVideoUrl === "BASE" && comp.body.avatarTiming === "full" && !comp.body.tailAvatarVideoUrl, "full → composite bg=BASE, timing=full, no tail");
}

// bookend: trim intro, 1 gen from trimmed
{
  const { caller, calls } = mock({});
  await runAvatarComposite(caller, { baseUrl: "BASE", ttsAudioUrl: "TTS", avatarMode: "bookend", avatarId: "av", introSecs: 4, tailSecs: 5, sleep: noSleep });
  const trims = calls.filter((c) => c.path === "/api/videos/trim-audio");
  assert(trims.length === 1 && trims[0].body.durationSecs === 4, "bookend → 1 trim intro (durationSecs)");
  const gen = calls.find((c) => c.path === "/api/heygen/generate-with-bg")!;
  assert(gen.body.audioUrl === "trimmed:4", "bookend → gen uses trimmed intro audio");
}

// bookend-both: trim intro + tail, 2 gens, composite with tailAvatarVideoUrl
{
  const { caller, calls } = mock({});
  const r = await runAvatarComposite(caller, { baseUrl: "BASE", ttsAudioUrl: "TTS", avatarMode: "bookend-both", avatarId: "av", introSecs: 3, tailSecs: 6, sleep: noSleep });
  const trims = calls.filter((c) => c.path === "/api/videos/trim-audio");
  assert(trims.length === 2 && trims[0].body.durationSecs === 3 && trims[1].body.tailSecs === 6, "bookend-both → trim intro(durationSecs) + tail(tailSecs)");
  assert(calls.filter((c) => c.path === "/api/heygen/generate-with-bg").length === 2, "bookend-both → 2 gens");
  const comp = calls.find((c) => c.path === "/api/heygen/composite")!;
  assert(!!comp.body.tailAvatarVideoUrl && comp.body.avatarTiming === "bookend-both", "bookend-both → composite carries tailAvatarVideoUrl");
  assert(r.tailAvatarUrl !== undefined, "bookend-both → returns tailAvatarUrl");
}

// pollAvatar: completed → url; failed → throw
{
  const { caller } = mock({ "hg-x": ["processing", "processing", "completed"] });
  const url = await pollAvatar(caller, "hg-x", { intervalMs: 1, sleep: noSleep });
  assert(url === "avatar:hg-x", "pollAvatar returns url on completed");
  const { caller: c2 } = mock({ "hg-y": ["failed"] });
  let threw = false;
  try { await pollAvatar(c2, "hg-y", { intervalMs: 1, sleep: noSleep }); } catch { threw = true; }
  assert(threw, "pollAvatar throws on failed");
}

console.log(`\n${passed} assertions passed ✅`);
```

- [ ] **Step 2: Run — verify it fails**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/verify-avatar-steps.ts`
Expected: FAIL — `runAvatarComposite`/`pollAvatar` not exported.

- [ ] **Step 3: Append to `src/lib/mcp/avatar-steps.ts`:**

```ts
type PollAvatarResp = { status: string; videoUrl: string | null; errorMsg: string | null };

export async function pollAvatar(
  caller: PipelineCaller,
  heygenVideoId: string,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const interval = opts.intervalMs ?? 5000;
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await caller.post<PollAvatarResp>("/api/videos/poll-avatar", { videoId: heygenVideoId });
    if (p.status === "completed" && p.videoUrl) return p.videoUrl;
    if (p.status === "failed") throw new Error(`avatar generation failed: ${p.errorMsg ?? "unknown"}`);
    await sleep(interval);
  }
  throw new Error("avatar generation timed out");
}

async function generateAvatar(caller: PipelineCaller, avatarId: string, audioUrl: string): Promise<string> {
  const g = await caller.post<{ videoId: string }>("/api/heygen/generate-with-bg", {
    audioUrl, avatarId, greenScreen: true,
    scale: AVATAR_LAYOUT.scale, offsetX: AVATAR_LAYOUT.offsetX, offsetY: AVATAR_LAYOUT.offsetY,
  });
  return g.videoId;
}

export interface AvatarComposeOpts {
  baseUrl: string;       // base render (has full TTS audio) = composite bg
  ttsAudioUrl: string;   // full TTS audio (source for trimming / full mode)
  avatarMode: "full" | "bookend" | "bookend-both";
  avatarId: string;
  introSecs: number;
  tailSecs: number;
  sleep?: (ms: number) => Promise<void>;
  onStep?: (label: string) => void;
}

export async function runAvatarComposite(
  caller: PipelineCaller,
  o: AvatarComposeOpts,
): Promise<{ compositeUrl: string; avatarUrl: string; tailAvatarUrl?: string }> {
  // 1. prepare audio for the avatar segment(s)
  let introAudio = o.ttsAudioUrl;
  let tailAudio: string | undefined;
  if (o.avatarMode === "bookend" || o.avatarMode === "bookend-both") {
    introAudio = (await caller.post<{ audioUrl: string }>("/api/videos/trim-audio", { audioUrl: o.ttsAudioUrl, durationSecs: o.introSecs })).audioUrl;
  }
  if (o.avatarMode === "bookend-both") {
    tailAudio = (await caller.post<{ audioUrl: string }>("/api/videos/trim-audio", { audioUrl: o.ttsAudioUrl, tailSecs: o.tailSecs })).audioUrl;
  }

  // 2+3. generate + poll (intro, then tail for bookend-both)
  o.onStep?.("avatar");
  const introUrl = await pollAvatar(caller, await generateAvatar(caller, o.avatarId, introAudio), { sleep: o.sleep });
  let tailAvatarUrl: string | undefined;
  if (o.avatarMode === "bookend-both" && tailAudio) {
    tailAvatarUrl = await pollAvatar(caller, await generateAvatar(caller, o.avatarId, tailAudio), { sleep: o.sleep });
  }

  // 4. composite onto the base render (bg carries the full TTS audio)
  o.onStep?.("composite");
  const c = await caller.post<{ videoUrl: string }>("/api/heygen/composite", {
    avatarVideoUrl: introUrl,
    tailAvatarVideoUrl: tailAvatarUrl,
    bgVideoUrl: o.baseUrl,
    mode: "chromakey",
    avatarTiming: o.avatarMode,
    avatarBookendSecs: o.introSecs,
    avatarTailSecs: o.tailSecs,
    avatarLayout: AVATAR_LAYOUT,
  });
  return { compositeUrl: c.videoUrl, avatarUrl: introUrl, tailAvatarUrl };
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/verify-avatar-steps.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/avatar-steps.ts scripts/verify-avatar-steps.ts
git commit -m "feat(mcp): avatar-steps runAvatarComposite + pollAvatar"
```

---

## Task 4: Wire avatar into the `create_video_job` tool (schema + gating)

**Files:**
- Modify: `src/app/api/[transport]/route.ts:109-136`

- [ ] **Step 1: Add the import** near the other MCP imports:

```ts
import { resolveAvatarRequest } from "@/lib/mcp/avatar-steps";
```

- [ ] **Step 2: Extend `inputSchema`** of `create_video_job` (after `voiceId`):

```ts
          voiceId: z.string().optional(),
          avatarMode: z.enum(["none", "full", "bookend", "bookend-both"]).optional(),
          avatarId: z.string().optional(),
          avatarIntroSecs: z.number().int().min(1).max(30).optional(),
          avatarTailSecs: z.number().int().min(1).max(30).optional(),
          idempotencyKey: z.string().max(120).optional(),
```

- [ ] **Step 3: Gate + persist** inside the handler. After the existing b-roll key check (`if (!u.pexelsKey && !u.pixabayKey) ...`) and before the quota check, add:

```ts
          const avatar = resolveAvatarRequest(
            { avatarMode: args.avatarMode, avatarId: args.avatarId, avatarIntroSecs: args.avatarIntroSecs, avatarTailSecs: args.avatarTailSecs },
            u,
          );
          if (avatar.kind === "error") return avatar.payload;
```

Then change the `createVideoJob` input to include avatar fields when present:

```ts
            const job = await createVideoJob(
              p.userId,
              {
                script: args.script, title: args.title, voiceProvider: args.voiceProvider, voiceId: args.voiceId,
                ...(avatar.kind === "ok"
                  ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs }
                  : {}),
              },
              args.idempotencyKey,
            );
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "\[transport\]|avatar-steps" || echo "clean"`
Expected: `clean`

- [ ] **Step 5: Update the tool description** (one line, so the model knows avatar exists) — change the `create_video_job` `description` to:

```ts
        description: "สร้างวิดีโอ auto (เสียง + b-roll + ซับไทย) จากสคริปต์ แบบ async — คืน jobId แล้ว poll ด้วย get_video_status. ใส่ avatarMode (full/bookend/bookend-both) เพื่อเพิ่มพิธีกร AI (ต้องมี HeyGen key + avatarId)",
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/[transport]/route.ts"
git commit -m "feat(mcp): create_video_job accepts avatar params + gating"
```

---

## Task 5: Wire avatar into the orchestrator

**Files:**
- Modify: `src/lib/mcp/orchestrator.ts:18`, `:79-92`
- Test: `scripts/verify-mcp-orchestrator.ts` (extend existing)

- [ ] **Step 1: Read the existing orchestrator test** to reuse its mock-caller pattern and TTS-timing fixture:

Run: `sed -n '1,80p' scripts/verify-mcp-orchestrator.ts`

- [ ] **Step 2: Add a failing avatar case** to `scripts/verify-mcp-orchestrator.ts`. Reuse the file's existing mock caller; extend its `post` to also answer the avatar endpoints, and add a job whose `inputJson` sets `avatarMode:"full"`, `avatarId:"av1"`. Assertions to add:

```ts
// Avatar path: composite becomes the burn source, and the Video row records the avatar.
assert(postedVideos[0].avatarModel === "av1", "avatar job → Video.avatarModel = avatarId");
assert(burnConfigs[0].includes("COMPOSITE") || burnSourceUrls[0] === "COMPOSITE", "avatar job → subtitles burned onto compositeUrl");
```

Mock responses to add to the caller's `post` (alongside the existing render/tts/etc. cases):

```ts
if (path === "/api/videos/trim-audio") return { audioUrl: "trim" };
if (path === "/api/heygen/generate-with-bg") return { videoId: "hg1" };
if (path === "/api/videos/poll-avatar") return { status: "completed", videoUrl: "AVATAR", thumbnailUrl: null, errorMsg: null };
if (path === "/api/heygen/composite") return { videoUrl: "COMPOSITE", usedMode: "chromakey" };
```

(Capture `postedVideos` from POST `/api/videos` bodies and the burn source from the POST `/api/videos/render` `subtitleOverlayConfig` — follow how the existing test already inspects those calls.)

- [ ] **Step 3: Run — verify it fails**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/test-orch.db" npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1; DATABASE_URL="file:$ROOT/prisma/test-orch.db?connection_limit=1" npx tsx scripts/verify-mcp-orchestrator.ts`
Expected: FAIL — orchestrator ignores `avatarMode`; `avatarModel` is `"none"` and burn uses the base URL.

- [ ] **Step 4: Implement in `src/lib/mcp/orchestrator.ts`.** Extend `CreateInput` (`:18`):

```ts
interface CreateInput {
  script: string; title?: string; voiceProvider?: "gemini" | "elevenlabs"; voiceId?: string;
  avatarMode?: "full" | "bookend" | "bookend-both"; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number;
}
```

Add the import at the top:

```ts
import { runAvatarComposite } from "@/lib/mcp/avatar-steps";
```

Replace the block from after the base-render refund (`:77`) through the burn (`:88-89`) so the composite becomes the burn/create source:

```ts
    await refund(userId).catch(() => {});

    // 6b. Avatar (optional) — generate + composite onto the base render.
    let finalBase = baseUrl;
    let avatarModel = "none";
    let avatarVideoUrl: string | null = null;
    if (input.avatarMode) {
      await setJobStep(jobId, "avatar", 80);
      const av = await runAvatarComposite(caller, {
        baseUrl, ttsAudioUrl: tts.voiceUrl, avatarMode: input.avatarMode, avatarId: input.avatarId!,
        introSecs: input.avatarIntroSecs ?? 5, tailSecs: input.avatarTailSecs ?? 5, sleep,
        onStep: (label) => { void setJobStep(jobId, label, 84).catch(() => {}); },
      });
      finalBase = av.compositeUrl;
      avatarModel = input.avatarId!;
      avatarVideoUrl = av.avatarUrl;
    }

    // 7. Create Video row (PROCESSING)
    const created = await caller.post<{ id: string }>("/api/videos", {
      videoUrl: finalBase, audioUrl: tts.voiceUrl, thumbnail: null, script: input.script.trim() || null,
      avatarModel, avatarVideoUrl, voiceModel: provider === "elevenlabs" ? (input.voiceId ?? "elevenlabs") : (user.geminiVoiceName ?? "gemini"),
      sceneCount: captions.length, renderConfig: cfgRes.config, status: "PROCESSING",
    });

    // 8. Burn subtitles onto the (possibly avatar-composited) base.
    await setJobStep(jobId, "burn", 88);
    const r2 = await caller.post<{ jobId: string }>("/api/videos/render", { subtitleOverlayConfig: buildBurnConfig(finalBase, captions, durMs, RENDER_FPS) });
    const burnedUrl = await pollRender(caller, r2.jobId, (pct) => { void setJobStep(jobId, "burn", 88 + Math.round(pct * 0.1)).catch(() => {}); }, { sleep });
```

(The `avatarVideoUrl` body field is best-effort — `/api/videos` ignores unknown fields; `avatarModel` is already an accepted field.)

- [ ] **Step 5: Run — verify it passes**

Run: `ROOT="$(pwd)"; DATABASE_URL="file:$ROOT/prisma/test-orch.db?connection_limit=1" npx tsx scripts/verify-mcp-orchestrator.ts; rm -f "$ROOT"/prisma/test-orch.db`
Expected: PASS (existing non-avatar cases + new avatar assertions).

- [ ] **Step 6: Full regression + typecheck**

```bash
ROOT="$(pwd)"
for s in verify-mcp-onboarding verify-mcp-avatar-input verify-avatar-steps verify-mcp-audit-status; do
  DATABASE_URL="file:$ROOT/prisma/dev.db" npx tsx scripts/$s.ts | tail -1
done
npx tsc --noEmit 2>&1 | grep -E "mcp|avatar|\[transport\]" || echo "tsc clean"
```
Expected: each `… passed ✅`, `tsc clean`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mcp/orchestrator.ts scripts/verify-mcp-orchestrator.ts
git commit -m "feat(mcp): orchestrator runs avatar composite + burns onto it"
```

---

## Task 6: Manual e2e (all 3 modes) — final verification

**No code.** Run on an account with a valid HeyGen key + avatar (mirror the 2026-06-13 prod e2e; likely on the VPS for RAM). For each `avatarMode` in `full`, `bookend`, `bookend-both`:

- [ ] In Claude desktop (or via a PAT), call `create_video_job` with a short Thai script + `avatarMode` (+ `avatarIntroSecs`/`avatarTailSecs` for bookend modes). Expect `{ jobId, status: "queued" }`.
- [ ] Poll `get_video_status({ id: jobId })` — expect steps to progress through `avatar` → `composite` → `burn` → `done`.
- [ ] Confirm the final video: avatar visible per mode (full = throughout; bookend = intro only; bookend-both = intro + outro), audio lip-synced, b-roll in the middle, Thai subtitles burned on.
- [ ] Negative checks: account **without** a HeyGen key → `missing_key`; account with key but no avatar set and no `avatarId` arg → `missing_avatar`.
- [ ] Record timings (avatar jobs are slower than the ~105s b-roll baseline) and note any HeyGen credit errors.

---

## Self-review notes

- **Spec coverage:** contract params (Task 4), gating incl. HeyGen key + avatarId (Tasks 1,2,4), 3-mode flow with trim/generate/poll/composite (Task 3), burn-onto-composite + avatarModel (Task 5), error/timeout via `pollAvatar` throw (Task 3), quota unchanged (no reserve calls added), middleware/nginx no-op (verified — noted in Ground truth), tests (Tasks 2,3,5) + manual e2e (Task 6). HeyGen onboarding copy (Task 1).
- **No parallel, no direct-upload, no layout params, no rembg** — matches "out of scope".
- **Types:** `resolveAvatarRequest`/`clampSecs`/`runAvatarComposite`/`pollAvatar`/`AVATAR_LAYOUT` names are consistent across Tasks 2–5.
