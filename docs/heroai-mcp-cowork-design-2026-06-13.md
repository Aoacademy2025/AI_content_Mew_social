# HERO AI MCP — "Member Cowork" Design Spec

> Design spec สำหรับเปิดให้ **สมาชิก PRO/BUSINESS** ต่อ agent ของตัวเอง
> (Claude Code / Claude co-work / OpenClaw Hermes) เข้ากับ HERO AI ผ่าน **remote MCP**
> แล้วสั่งสร้าง/ดูงานวิดีโอด้วยภาษาคน โดยมี **auth กันสิทธิ์ตาม plan**
>
> ต่อยอดจาก `docs/heroai-mcp-server-plan.md` (โฟกัสที่ Phase 2 = Remote HTTP + entitlement)
>
> Created: 2026-06-13 · Owner: Mew (payment/entitlement vertical แตะ; render backend = wao)

---

## 1. เป้าหมาย (Goal)

ขายความสามารถ "สั่งงาน HERO AI ผ่าน AI agent" เป็นฟีเจอร์ของ plan PRO/BUSINESS

สมาชิกพิมพ์ในแชท agent ว่า _"สร้างคลิป 60 วิ เรื่อง X เสียง Gemini avatar bookend 5 วิ b-roll cinematic"_
แล้ว agent เรียก tool บน HERO AI MCP server แทนการเข้าหน้าเว็บเอง — โดยระบบ:

1. ยืนยันว่าเป็นสมาชิกตัวจริง (PAT auth)
2. ยืนยันว่ามีสิทธิ์ (plan ∈ {PRO, BUSINESS} และยัง active)
3. นับโควตาเข้ากรอบเดิม (`reserveClipUsage`)
4. ใช้ BYOK key **ของสมาชิกคนนั้น** ในการ render → cost ตกที่เขาเอง

## 2. Decisions ที่ล็อกแล้ว

| เรื่อง | สรุป |
|---|---|
| Transport | Remote HTTP (Streamable HTTP). **v1 ใช้ path ของแอปเดิม `studio.heroaiengine.com/mcp`** (reuse Next.js + Clerk + DB, ไม่ต้องตั้ง DNS/subdomain/cert ใหม่). Subdomain สวย `mcp.heroaiengine.com` = เติมทีหลัง (แค่ Nginx vhost + redirect, additive) |
| URL strategy | **ไม่ต้องเคาะ subdomain ตอนนี้** — เริ่มบน path แอปเดิม. URL เป็นแค่ "ที่อยู่" → design/tools/schema ไม่เปลี่ยนตาม URL. ย้าย path → subdomain ทีหลัง = แค่ redirect |
| Auth (v1) | **Personal Access Token (PAT)** — Settings → generate → paste ใน agent config. OAuth = ทีหลัง |
| Entitlement | MCP access เป็นสิทธิ์ของ **PRO/BUSINESS** เท่านั้น (FREE โดนบล็อกที่ประตู + เห็น upsell) |
| Scope v1 | **แยกเฟส**: Phase A = read-only tools + PAT + Settings UI (ส่งก่อน); Phase B = `create_video_job` + backend job pipeline (ตามมา) |
| Quota | **ใช้กรอบเดียวกับเว็บ** (`reserveClipUsage`, FREE 2 / PRO 100 / BUSINESS 300 ต่อ 30 วัน) — ไม่แยกโควตา MCP |
| Job model | **Async บังคับ** (Phase B): คืน `jobId` ทันที, agent poll status เอง |

## 3. Flow จริง

### 3.1 ตั้งค่าครั้งเดียว (member onboarding)

```
สมาชิก (PRO/BUSINESS)
   │ 1. login studio.heroaiengine.com (Clerk)
   │ 2. Settings → หัวข้อใหม่ "Agent / MCP Access"
   │ 3. เช็คว่าใส่ BYOK keys ครบ (Gemini / HeyGen / ElevenLabs / stock)
   │ 4. กด "Generate Token" → heroai_pat_xxxx
   │      (โชว์ครั้งเดียว, DB เก็บแค่ hash + ชื่อเครื่อง + lastUsed)
   │ 5. copy คำสั่ง connect ที่หน้าเว็บเตรียมให้
   ▼
agent ของสมาชิก (Claude Code / Claude co-work / OpenClaw Hermes)
   claude mcp add --transport http heroai \
     https://studio.heroaiengine.com/mcp \
     --header "Authorization: Bearer heroai_pat_xxxx"
   │
   ▼  ต่อติด → agent เห็น tools ที่ plan นั้นเข้าถึงได้
```

### 3.2 Loop สั่งงาน (หัวใจของ cowork — Phase B)

```
สมาชิกพิมพ์ในแชท agent (ภาษาคน):
  "สร้างคลิป 60 วิ เรื่อง AI war เสียง Gemini, avatar bookend 5 วิ, b-roll cinematic"
        │
        ▼  agent แปลงเป็น tool call + แนบ Bearer token
   create_video_job({ title, script, durationSec:60, voiceProvider:"gemini", ... })
        │
        ▼
┌──────────────── HERO AI MCP Server  (/mcp) ────────────────┐
│  ① Auth   : sha256(token) → McpToken → userId               │
│             ถูก revoke/หมดอายุ → 401                          │
│  ② Plan   : plan ∈ {PRO,BUSINESS} & ยัง active?              │
│             FREE/หมดอายุ → ตอบสุภาพ "ต้องอัปเกรด" (ไม่ throw)  │
│  ③ Quota  : reserveClipUsage(userId) — กรอบ 30 วัน           │
│             เกิน cap → "โควตาหมด"                             │
│  ④ BYOK   : งานนี้ต้องใช้ key อะไร (avatar→HeyGen) ครบไหม     │
│             ขาด → "ไปตั้งค่า HeyGen key ก่อน"                  │
│  ⑤ สร้าง VideoJob (status=queued) → คืน {jobId} ทันที        │
│  ⑥ เขียน ToolCallAudit (ใคร / tool / เวลา / cost / ip)       │
└────────────────────────────┬───────────────────────────────┘
                             ▼
                  Worker / Queue (หลังบ้าน — async, concurrency cap)
         TTS → subtitle timing → keywords → B-roll →
         render → avatar → composite → burn subtitles
         ★ ใช้ BYOK key ของสมาชิกคนนั้น
                             │
        ┌────────────────────┴─────────────────────┐
        ▼                                           ▼
 agent poll: get_video_status(jobId)        เสร็จ → download_video(jobId)
   → currentStep / progress%                  → final signed URL
```

### 3.3 หลักการที่ flow บังคับ

1. **Async บังคับ** — render บน VPS ช้า (ซอฟต์แวร์ ไม่มี GPU) → ห้ามรอจบใน request เดียว (timeout แน่)
2. **BYOK = cost อยู่ที่สมาชิก** — หลังบ้านใช้คีย์ที่สมาชิกเก็บในบัญชีตัวเอง → onboarding ต้องบังคับใส่คีย์ก่อน ไม่งั้น job fail
3. **Gate ซ้อนชั้น + fail-open สุภาพ** — auth → plan → quota → BYOK ทุกชั้นตอบเป็นข้อความให้ agent เล่าต่อ ไม่ throw 500

## 4. ความจริงที่กำหนดสถาปัตยกรรม (ทำไมต้องแยกเฟส)

ปัจจุบัน flow สร้าง/ตัดต่อวิดีโอ **ผูกกับหน้า `/video-editor` + browser state** (gotcha ใน CLAUDE.md)
→ `create_video_job` แบบ "สั่งแล้วได้คลิปโดยไม่เปิด browser" **ต้องมี backend job layer ก่อน**

นอกจากนี้ CLAUDE.md ระบุ **"render ไม่มี global queue"** → ถ้าเปิดให้สมาชิกหลายคนยิง job พร้อมกัน
ผ่าน MCP, VPS จะโดนถล่ม → "create ผ่าน MCP" ต้องมาคู่กับ **queue + concurrency cap จริง**
(เกี่ยวข้องกับ `docs/scale-upgrade-plan.md`)

**ดังนั้น:** Phase A (read-only) ไม่แตะ render เลย → ส่งได้เร็ว เสี่ยงต่ำ.
Phase B (create) คือก้อนใหญ่ที่ต้องสร้าง job pipeline + queue ก่อน.

---

## 5. Phase A — Read-only MCP + PAT (ส่งก่อน)

เป้าหมาย: สมาชิก PRO/BUSINESS ต่อ agent แล้ว **ดู/โหลดงานที่สร้างจากเว็บได้** — ยังสร้างใหม่ผ่าน MCP ไม่ได้
แต่ได้พิสูจน์ทั้ง pipeline ของ auth/entitlement/audit จริง

### 5.1 Tools

| Tool | Input | Output (scoped to authed user) |
|---|---|---|
| `get_current_user` | — | `{ email, plan, planActive, quotaUsed, quotaLimit, keysConfigured: {gemini,heygen,elevenlabs,stock} }` |
| `list_my_videos` | `{ limit?, cursor?, status? }` | `[{ id, title, status, durationSec, createdAt }]` |
| `get_video_status` | `{ videoId }` | `{ videoId, status, currentStep?, progress?, error? }` |
| `get_video` | `{ videoId }` | full detail + settings (no secrets) |
| `download_video` | `{ videoId }` | `{ url }` signed URL หรือ error ถ้ายังไม่มี final |

ทุก tool query เฉพาะ `userId` ของ token → ห้ามเห็นงานคนอื่นเด็ดขาด

### 5.2 PAT design

- **Format**: `heroai_pat_` + 32 bytes random (base62). โชว์เต็ม **ครั้งเดียว** ตอน generate
- **Storage**: เก็บ **SHA-256 hash** ใน `McpToken.tokenHash` (unique index) — ไม่เก็บ plaintext
- **Lookup**: ทุก request → `sha256(bearer)` → หาใน `McpToken` → ได้ `userId` (O(1) indexed)
- **Valid เมื่อ**: `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now)`
- **Revoke**: set `revokedAt` จาก Settings → token ใช้ไม่ได้ทันที

### 5.3 Settings UI (`/settings` → "Agent / MCP Access")

- เห็นเฉพาะ PRO/BUSINESS (FREE เห็น upsell card)
- ปุ่ม **"Generate Token"** → modal โชว์ token ครั้งเดียว + copy connect command (3 client: Claude Code / co-work / Hermes)
- ตารางรายการ token: `name (device) · created · lastUsed · [Revoke]`
- การ์ดเตือนถ้า BYOK keys ยังไม่ครบ + ลิงก์ไปหน้าใส่คีย์
- ลิงก์ docs + ตัวอย่าง prompts

### 5.4 MCP server transport

- Next.js App Router route handler ที่ `app/(...)/mcp/route.ts` (หรือ `app/api/mcp/route.ts`) ใช้ `@modelcontextprotocol/sdk` Streamable HTTP transport
- อ่าน `Authorization: Bearer` ใน handler → validate PAT → ผูก `userId` เข้า context ก่อน dispatch tool
- **Stateless ต่อ request** (ไม่พึ่ง session ฝั่ง server) → เข้ากับ serverless/PM2 ได้
- **v1 endpoint = `studio.heroaiengine.com/mcp`** (path ในแอปเดิม) → ไม่ต้องตั้ง subdomain/DNS/cert ใหม่

### 5.6 Client support (สำคัญ: PAT เหมาะกับ client ไหน)

- **Claude Code (CLI) / config-file clients** → ใส่ `--header "Authorization: Bearer ..."` ได้ → **PAT ทำงานเต็มที่** = กลุ่มเป้าหมาย v1
- **Claude.ai / Claude desktop "co-work" connector** → UI ส่วนใหญ่ให้พิมพ์**แค่ URL** แล้ววิ่ง OAuth ให้เอง บาง client ไม่มีช่องวาง header → **กลุ่มนี้ต้องรอ OAuth ใน Phase ถัดไป**

> สรุป: v1 (PAT) เล็ง power user บน CLI ก่อน. ประสบการณ์ "พิมพ์ URL เดียวจบใน app ของ Claude" = OAuth phase ถัดไป

### 5.5 Gates (ทุก request ใน Phase A)

1. **Auth** — valid PAT → userId (มิฉะนั้น 401)
2. **Entitlement** — plan ∈ {PRO,BUSINESS} & active (มิฉะนั้นตอบ upsell สุภาพ)
3. **Rate limit** — ต่อ token เช่น N req/min (กัน abuse)
4. **Audit** — เขียน `ToolCallAudit` ทุก call

> Phase A เป็น read-only → **ยังไม่แตะ quota/BYOK gate** (gate พวกนี้มีผลตอน create)

---

## 6. Phase B — `create_video_job` + Backend Job Pipeline (ตามมา)

เป้าหมาย: สั่งสร้างวิดีโอ end-to-end ผ่าน MCP โดยไม่เปิด browser

### 6.1 Tools เพิ่ม

| Tool | หน้าที่ |
|---|---|
| `create_video_job` | validate input → gate (quota+BYOK) → insert `VideoJob(queued)` → คืน `{jobId}` ทันที |
| `get_video_status` | (อัปเกรดให้รองรับ jobId) → `{ status, currentStep, progress, error }` |
| `rerun_video_step` | rerun เฉพาะขั้น: `broll \| subtitles \| avatar_intro \| avatar_tail \| composite \| burn_subtitles` |
| `cancel_video_job` | ยกเลิก job ที่ queued/processing |

`create_video_job` input (ตามแผนเดิม):
```json
{ "title","script","durationSec","voiceProvider","voiceId",
  "useBroll","brollStyle","useAvatar","avatarTiming",
  "avatarIntroSecs","avatarTailSecs","subtitlePreset","musicId",
  "idempotencyKey" }
```

### 6.2 Backend job layer

```
POST /api/jobs/video           → create (reuse โดย MCP)
GET  /api/jobs/video/:id        → status
POST /api/jobs/video/:id/cancel
POST /api/jobs/video/:id/rerun
GET  /api/jobs/video/:id/events → progress stream
```

- **Worker** = PM2 app แยก (แพทเทิร์นเดียวกับ cron ใน `ecosystem.config.js`) วน poll `VideoJob(queued)`
- **Queue = DB-backed**: ตาราง `VideoJob` + worker ที่ทำทีละ **N งาน (concurrency cap)** → serialize render กัน VPS ตาย = "global queue" ที่ CLAUDE.md บอกว่ายังไม่มี
- decouple logic เดิม (TTS / subtitle-timing / broll / render / avatar / composite / burn) ออกจาก browser state ให้เรียกจาก worker ได้

### 6.3 Gates เพิ่ม (create เท่านั้น)

4. **Quota** — `reserveClipUsage(userId)` (กรอบเดียวกับเว็บ) เกิน → "โควตาหมด"
5. **BYOK** — เช็ค key ที่ job ต้องใช้ (avatar→HeyGen, gemini-voice→Gemini ฯลฯ) ขาด → บอกให้ไปตั้งค่า
6. **Idempotency** — `idempotencyKey` unique ต่อ user → กันยิงซ้ำเสีย credit ซ้ำ

## 7. Data model เพิ่ม

```prisma
model McpToken {
  id         String    @id @default(cuid())
  userId     String
  tokenHash  String    @unique          // sha256 ของ PAT
  name       String?                    // ชื่อเครื่อง/agent
  scopes     String?                    // json เผื่ออนาคต
  lastUsedAt DateTime?
  expiresAt  DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())
  @@index([userId])
}

model ToolCallAudit {
  id           String   @id @default(cuid())
  userId       String
  toolName     String
  status       String                   // ok | denied | error
  requestJson  String?
  responseJson String?
  costJson     String?
  durationMs   Int?
  ipAddress    String?
  userAgent    String?
  createdAt    DateTime @default(now())
  @@index([userId])
  @@index([toolName])
}

// Phase B
model VideoJob {
  id             String    @id @default(cuid())
  userId         String
  videoId        String?
  type           String                  // create | rerun
  status         String    @default("queued") // queued|processing|done|failed|canceled
  currentStep    String?
  progress       Int       @default(0)
  inputJson      String
  outputJson     String?
  errorMessage   String?
  costJson       String?
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

> deploy ใช้ `prisma db push` (additive) ก่อน restart ตามแพทเทิร์น deploy.sh → ปลอดภัยกับ prod

## 8. Security model

- **Plan allowlist**: FREE = ไม่มี MCP access เลย; PRO/BUSINESS = member tools; **admin tools ไม่อยู่ใน spec นี้** (แยก, internal เท่านั้น)
- **Output filtering**: ห้ามคืน provider API key, path ภายใน, หรือข้อมูล user อื่น
- **Rate limit** ต่อ token; **idempotency** กัน double-charge (Phase B)
- **Audit ทุก call** ลง `ToolCallAudit`
- **ไม่มี destructive tools** ใน v1: `delete_video`, `edit_user_plan`, `edit_api_keys`, `deploy_*`, `run_shell`
- **Prompt-injection**: read-only คืนข้อมูลเฉย ๆ; create รับเฉพาะ structured input (LLM ที่ตัดสินใจคือ agent ของ user เอง ไม่ใช่ฝั่งเรา)

## 9. Out of scope (v1)

- OAuth 2.1 (ต่อยอดจาก PAT ทีหลัง)
- Granular editing tools (สลับคลิป b-roll ตัวใดตัวหนึ่ง, แก้ข้อความซับรายบรรทัด, เปลี่ยนเสียงเฉพาะส่วน)
- Admin/insights/reconcile tools (internal แยกต่างหาก)
- Team/shared job pool, sub-account, agency model
- Synchronous short jobs (async อย่างเดียว)

## 10. Open questions (เคาะตอนทำ plan)

1. Rate limit ต่อ plan เท่าไร (req/min)?
2. PAT มี default expiry ไหม (never vs 90 วัน)?
3. Worker concurrency = กี่งานพร้อมกันบน VPS ปัจจุบัน (เริ่มที่ 1)?
4. ใส่ MCP usage ใน usage dashboard ของ Settings เลยหรือเฟสหลัง?
5. SDK: ใช้ `@modelcontextprotocol/sdk` (TS) ตรง ๆ หรือ wrapper อื่น?

## 11. References

- `docs/heroai-mcp-server-plan.md` — แผนตั้งต้น (tools, transport, phases)
- `docs/scale-upgrade-plan.md` — เกี่ยวกับ render queue/concurrency
- CLAUDE.md gotchas — render ไม่มี global queue, video-editor browser-coupled, BYOK, `reserveClipUsage`
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- MCP transports spec: https://modelcontextprotocol.io/docs/concepts/transports
