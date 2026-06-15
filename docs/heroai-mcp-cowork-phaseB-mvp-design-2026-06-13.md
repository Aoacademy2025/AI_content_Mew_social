# HERO AI MCP — Phase B MVP (Headless `create_video_job`) Design Spec

> ต่อจาก Phase A (`docs/heroai-mcp-cowork-design-2026-06-13.md` §6). MVP ของ Phase B:
> ให้สมาชิก PRO/BUSINESS สั่ง **สร้างวิดีโอ end-to-end ผ่าน MCP โดยไม่เปิด browser**.
>
> Created: 2026-06-13 · grounded ใน **โค้ดจริง** (ไม่ใช่เอกสาร — เอกสารไม่อัปเดต)
>
> **กฎเหล็กของงานนี้ (ผู้ใช้ย้ำ):** pipeline TTS/transcribe/render เพิ่งรื้อจนเสถียร+เร็ว (PRs #35–#43) —
> **ห้ามทำให้ของเดิมพัง**. ทุกอย่างต้อง **additive**: reuse endpoint เสถียร, ไม่ fork, แตะ auth จุดเดียวแบบไม่เปลี่ยน path เดิม.

---

## 1. Scope (เคาะแล้ว)

**ส่งมอบ:** MCP `create_video_job` → งาน background → **วิดีโอ auto มาตรฐานของระบบ** (เสียง TTS + b-roll + ซับไทย burn), **non-avatar**, ใช้ default settings, headless เต็มตัว. `get_video_status` อ่านความคืบหน้าได้จริง.

**ทำไมไม่ใช่ "no b-roll":** pipeline จริงสร้าง b-roll เสมอ (`generate-config` populate `bgVideos` ตลอด แม้ fallback). "ไม่มี b-roll" = ต้อง fork `generate-config` = ผิดกฎ. เลยใช้ output มาตรฐาน (reuse 100%). **MVP-ness = ตัด avatar/composite + ตัด custom style knobs + ใช้ default + worker concurrency 1.**

**Decisions ที่ล็อก:**

| เรื่อง | สรุป |
|---|---|
| Auth seam | **Additive service seam** ใน `getCurrentUser()`: ถ้ามี internal header+secret → ทำงานแทน userId; ไม่มี → Clerk เดิมเป๊ะ |
| Orchestration | **Worker (PM2 app)** poll `VideoJob(queued)` แล้วรัน orchestrator (แบบเดียวกับ cron ใน `ecosystem.config.js`) |
| Pipeline | **reuse endpoint เสถียรทั้งชุด** ผ่าน localhost HTTP + service header — ไม่ fork |
| Captions | reuse `captionsFromTtsTiming()` (pure) + `src/lib/tts-timing.ts` ตรง ๆ |
| Async | `create_video_job` คืน `jobId` ทันที, agent poll `get_video_status` |

## 2. โค้ดจริงที่ออกแบบยึดไว้ (จาก inspection 2026-06-13)

**`getCurrentUser()`** (`src/lib/clerk-auth.ts`) — ต้นฟังก์ชันคือ `const { userId } = await auth(); if (!userId) return null; …` → เติม branch บนสุดได้สะอาด.

**`captionsFromTtsTiming()`** (`src/app/(dashboard)/video-editor/_components/tts-timing-captions.ts`) — **pure**, import แค่ `@/lib/tts-timing` + type `Caption`. ไม่มี React/"use client" → orchestrator import ใช้ server-side ได้เลย. Signature:
```ts
captionsFromTtsTiming(timing, audioDurationMsHint, maxCardChars, cardsOverride?)
  → { captions: {text,startMs,endMs,tag}[]; words; audioDurationMs } | null
```

**Endpoint contracts (ปัจจุบัน):**
- `POST /api/videos/tts` `{ text, voiceId?, languageCode? }` → `{ voiceUrl: "/api/renders/x.mp3", audioDurationMs?, timing? }`
- `POST /api/videos/tts-gemini` `{ text, voiceName? }` → `{ voiceUrl: "x.wav", audioDurationMs, timing? }` (timing.silences สำหรับ snap)
- `POST /api/videos/extract-keywords` → keywords ต่อ scene
- `POST /api/videos/fetch-stock` → stock videos (download ลง `/public/renders`)
- `POST /api/videos/generate-config` `{ sceneCaptions, stockVideos, voiceFile, audioDurationMs, font/subtitle settings, scenes, keywordsPerScene, sceneClipCounts, sceneDurations }` → `{ config: ShortVideoConfig }`
- `POST /api/videos/render` `{ shortVideoConfig, fps, jpegQuality }` → `{ jobId }` (composition `ShortVideoComposition`); burn = `{ subtitleOverlayConfig }` → `SubtitleOverlayComposition`
- `GET /api/videos/render-progress?jobId=` → `{ progress, videoUrl, stage, queued, error, … }` (stage: preparing|queued|rendering|done|error|cancelled)
- `GET /api/videos/render-status?jobId=` → `{ status: running|done|error, videoUrl?, error? }`
- `POST /api/videos` (create row) `{ videoUrl, audioUrl, thumbnail, script, avatarModel, voiceModel, sceneCount, renderConfig, status }`; `PATCH /api/videos/{id}`

**Reference order ของ `runAll()`** (non-avatar path): tts → (`applyTtsTiming()` ?? transcribe) → extract-keywords → fetch-stock → generate-config → render (base, `keywordPopups:[]`, status PROCESSING) → **render รอบสอง `subtitleOverlayConfig` (burn) → COMPLETED**. Video row สร้างหลัง render รอบแรกผ่าน `POST /api/videos`.
> หมายเหตุ: scenes/sceneDurations/keywordsPerScene มาจากขั้น `analyze-script`/`align-scenes` ก่อนหน้า — orchestrator ต้อง reproduce การ build input เหล่านี้ด้วย (ดู §9 open items).

**Quota:** `/api/videos/render` เรียก `reserveClipUsage(userId)` (line ~306) **ทุกครั้ง** + `refundClipUsage` on error. base + burn = 2 render calls → **เสี่ยงนับ 2 clip ต่อ 1 วิดีโอ** (ดู §8).

## 3. สถาปัตยกรรม

```
MCP create_video_job (PAT, Phase A auth)              [ใหม่: tool]
  ├─ gate: plan PRO/BUSINESS + BYOK keys ครบ + quota precheck
  ├─ insert VideoJob(status=queued, inputJson)         [ใหม่: VideoJob table]
  └─ คืน { jobId } ทันที

VideoJob Worker (PM2 app, poll queued)                [ใหม่: scripts/mcp-video-worker]
  └─ runOrchestrator(job):                             [ใหม่: src/lib/mcp/orchestrator.ts]
       เรียก endpoint เดิมผ่าน http://localhost:PORT + header service seam:
         1. tts/tts-gemini  →  voiceUrl, timing
         2. captionsFromTtsTiming(timing)  (in-process, reuse)
         3. extract-keywords → 4. fetch-stock → 5. generate-config
         6. render(shortVideoConfig) → poll render-progress → base url
         7. render(subtitleOverlayConfig) → poll → final url (burn)
         8. POST /api/videos (create row, COMPLETED)
       update VideoJob{currentStep,progress,outputJson,status} ทุกก้าว

getCurrentUser(): + branch additive                   [แก้ 1 จุด, src/lib/clerk-auth.ts]
  const svc = await resolveServiceActor();             [ใหม่: src/lib/mcp/service-actor.ts]
  if (svc) return svc;
  // ...โค้ด Clerk เดิม ไม่แตะ...

get_video_status (MCP): อ่าน VideoJob + Video         [แก้ Phase A tool]
```

**reuse (ไม่แตะ):** ทุก `/api/videos/*` endpoint, `src/lib/tts-timing.ts`, `captionsFromTtsTiming`, render queue (`cancel-registry.ts`), `reserveClipUsage`.

## 4. Auth seam (จุดละเอียดอ่อนสุด — ต้องชัวร์)

ไฟล์ใหม่ `src/lib/mcp/service-actor.ts`:
```ts
// คืน User ถ้า request พก internal service credential ที่ถูกต้อง; ไม่งั้น null.
// secret เป็น env server-only — browser ไม่มีทางมี → path Clerk เดิมปลอดภัย 100%.
export async function resolveServiceActor(): Promise<User | null> {
  const secret = process.env.MCP_SERVICE_SECRET;
  if (!secret) return null;                       // feature off ถ้าไม่ตั้ง env
  const h = await headers();
  if (h.get("x-heroai-service-secret") !== secret) return null;
  const userId = h.get("x-heroai-act-as");
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  await syncUserEntitlement(user.id).catch(() => {});
  return prisma.user.findUnique({ where: { id: user.id } });
}
```
แก้ `getCurrentUser()` **เติม 2 บรรทัดบนสุด**:
```ts
const svc = await resolveServiceActor();
if (svc) return svc;
// ... โค้ดเดิมทั้งหมดไม่เปลี่ยน ...
```
**ความปลอดภัย:** เปรียบเทียบ secret แบบ exact; ไม่มี env → seam ปิดสนิท (return null). orchestrator (ใน worker บน VPS เดียวกัน) เท่านั้นที่รู้ secret และยิง localhost. **Test บังคับ:** ไม่มี header → `resolveServiceActor()` คืน null และ `getCurrentUser()` พฤติกรรมเดิมเป๊ะ.

## 5. Data model — `VideoJob`

```prisma
model VideoJob {
  id             String    @id @default(cuid())
  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  videoId        String?                          // ตั้งเมื่อสร้าง Video row แล้ว
  type           String    @default("create")     // create (อนาคต: rerun)
  status         String    @default("queued")     // queued|processing|done|failed|canceled
  currentStep    String?                           // tts|captions|keywords|stock|config|render|burn|save
  progress       Int       @default(0)
  inputJson      String                            // create params
  outputJson     String?                           // { videoUrl, videoId }
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
เพิ่ม `videoJobs VideoJob[]` ใน `User`. Deploy ใช้ `prisma db push` (additive) ตาม deploy.sh.

## 6. MCP tools

**`create_video_job`** input (เริ่มจาก subset ที่ MVP รองรับ):
```json
{ "title": "string?", "script": "string (required)",
  "voiceProvider": "gemini|elevenlabs?", "voiceId": "string?",
  "idempotencyKey": "string?" }
```
flow: gate (plan PRO/BUSINESS → reuse Phase A guard; BYOK เช็ค key ที่ provider ต้องใช้ + stock key; quota precheck `checkClipQuota`) → insert `VideoJob(queued)` → `{ jobId, status:"queued" }`. **ห้าม reserve quota ที่นี่** (render route reserve เอง — §8).

**`get_video_status`** (อัปเกรด Phase A): ถ้า id เป็น VideoJob → `{ status, currentStep, progress, videoUrl?, error? }`; ถ้าเป็น Video → คงพฤติกรรม Phase A.

> ไม่อยู่ใน MVP: `rerun_video_step`, `cancel_video_job`, avatar params, custom style.

## 7. Worker

`scripts/mcp-video-worker.ts` (PM2 app ใหม่ใน `ecosystem.config.js`, แพทเทิร์นเดียวกับ cron):
- loop: หา `VideoJob(status=queued)` เก่าสุด 1 ตัว → mark `processing` (atomic `updateMany` กัน double-pick) → `runOrchestrator` → mark done/failed
- concurrency = 1 (MVP) — ปลอดภัยกับ VPS, render queue ของเดิมก็คุมตัวมันเองอยู่แล้ว
- ยิง endpoint ผ่าน `process.env.MCP_INTERNAL_BASE_URL` (เช่น `http://127.0.0.1:3000`) + header `x-heroai-service-secret` + `x-heroai-act-as: <userId>`
- env: `MCP_SERVICE_SECRET` (ต้องตรงกับที่ web process เห็น), start แบบ cron (`pm2 start ecosystem.config.js --only mcp-video-worker --update-env && pm2 save`)

`src/lib/mcp/orchestrator.ts` — `runOrchestrator(job, deps)`: ฟังก์ชันเดียว, แต่ละ step เป็น helper เล็ก, update VideoJob ระหว่างทาง, throw → worker จับเป็น failed. deps (fetch base url + secret + provider เลือกจาก user) inject เข้าได้เพื่อ test.

## 8. Error handling / quota (สำคัญ)

- ทุก step fail → throw → worker set `VideoJob.status=failed` + `errorMessage` (สุภาพ, ไม่หลุด secret/path). ไม่ค้าง `processing` (worker มี timeout guard ต่อ job).
- **Quota double-reserve (ต้องแก้ก่อน build):** base render + burn render เรียก `reserveClipUsage` คนละครั้ง. **Open item §9** — ต้องอ่าน render route จริงว่า `subtitleOverlayConfig` path reserve ไหม. ถ้า reserve → MVP ต้องกันให้ 1 วิดีโอ = 1 clip (เช่น orchestrator refund 1 ครั้งหลัง burn, หรือ burn ส่ง flag — **โดยไม่แก้ render route**; ถ้าเลี่ยงไม่ได้จริง ค่อยยกเป็น coordinate กับ wao). ห้ามเดา — verify จากโค้ด.
- fail-open ของ pipeline เดิม (timing→transcribe ฯลฯ) คงไว้ตามเดิม orchestrator แค่เรียก endpoint ไม่ override.

## 9. Open items — verify จากโค้ดจริงตอน planning (ไม่เดา)

1. **เทรซ `runAll()` ครบ** สำหรับ non-avatar: ลิสต์ทุก endpoint + ทุก field ของ input ที่ editor build (รวม `analyze-script`/`align-scenes` ที่ป้อน scenes/sceneDurations/keywordsPerScene/sceneClipCounts ให้ generate-config). orchestrator ต้อง reproduce ให้ครบด้วย default.
2. **reserveClipUsage บน burn render** — reserve หรือไม่ (ตัดสินวิธีกัน double-count).
3. **เลือก provider**: map `user.ttsProvider` → tts vs tts-gemini + voiceId/voiceName ที่ถูก.
4. **burn payload**: `subtitleOverlayConfig` ต้องมี field อะไรบ้าง (durationInFrames, videoUrl, captions มาจากไหน — keywordPopups vs caption overlay).
5. **service seam + Clerk middleware**: localhost call ไป `/api/videos/*` ผ่าน middleware (ไม่ใช่ public route) — service header ต้องผ่าน middleware ได้ (middleware เรียก Clerk `auth()`; ต้องเช็คว่ามันไม่ block ก่อนถึง route → อาจต้องให้ middleware ปล่อยเมื่อ service header ถูกต้อง — **additive**).

## 10. Testing

- `scripts/verify-mcp-videojob.ts` — VideoJob lifecycle (queued→processing→done/failed, idempotencyKey unique, atomic pick)
- `scripts/verify-service-actor.ts` — resolveServiceActor: ไม่มี header→null, secret ผิด→null, ถูก→user; + ยืนยัน getCurrentUser path เดิมไม่เปลี่ยน (mock headers ว่าง)
- `scripts/verify-mcp-orchestrator.ts` — runOrchestrator กับ **mock fetch** (ไม่ยิงจริง): ลำดับ step ถูก, update VideoJob ถูก, step fail → failed + errorMessage
- **manual บน local dev เท่านั้น** (ห้าม prod data): create_video_job จริง → ดูวิดีโอออก
- รัน Phase A verify scripts ซ้ำ — ยืนยันไม่มี regression

## 11. Out of scope (MVP)

avatar/composite/avatar-tail · custom style knobs · `rerun_video_step`/`cancel_video_job` · OAuth · real queue scaling (>1) · MCP usage dashboard · การ "ไม่มี b-roll" (ต้อง fork — ไม่ทำ)

## 12. References
- `docs/heroai-mcp-cowork-design-2026-06-13.md` (§6 Phase B) · `docs/heroai-mcp-cowork-phaseA-plan-2026-06-13.md`
- โค้ดจริง: `src/lib/tts-timing.ts`, `_components/tts-timing-captions.ts`, `src/app/api/videos/{tts,tts-gemini,render,generate-config,fetch-stock,extract-keywords}/route.ts`, `src/lib/clerk-auth.ts`, `cancel-registry.ts`
