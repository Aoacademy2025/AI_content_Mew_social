# HeroAI MCP Server Plan

เอกสารนี้เป็นแผนสำหรับทำ MCP server ให้ HeroAI เพื่อให้มิว ทีมงาน หรือ user สั่งงานระบบผ่าน Claude Code / OpenClaw / agent tools ได้ โดยไม่ต้องเข้าหน้า Video Editor เอง

Last updated: 2026-06-09

## เป้าหมาย

ทำให้ HeroAI มี command layer สำหรับ AI agent เช่น Claude Code เพื่อสั่งสร้างวิดีโอ ตรวจสถานะงาน audit งาน และดึง insight ผ่าน MCP tools

ตัวอย่างคำสั่งที่อยากให้ทำได้:

```text
สร้างคลิป 60 วิ เรื่อง AI coding war ใช้เสียง Gemini เปิด Avatar intro/outro 5 วิ ใส่ B-roll แบบ cinematic แล้วแจ้งลิงก์ตอนเสร็จ
```

agent จะไม่ต้องกดหน้าเว็บเอง แต่จะเรียก tool จาก HeroAI MCP server เช่น `create_video_job`, `get_video_status`, `download_video`

## สรุปแนวทาง

ควรทำแบบ Hybrid:

1. Phase 1: Local/Internal MCP สำหรับมิวและทีมงาน ใช้เองก่อน
2. Phase 2: Remote HTTP MCP สำหรับเปิดให้ user หรือทีมอื่นเชื่อมต่อ
3. Phase 3: Backend job orchestration เต็มรูปแบบ เพื่อให้สร้างวิดีโอได้แม้ user ปิด browser/agent ไปแล้ว

ไม่ควรเริ่มจากให้ MCP ไปควบคุมหน้า `/video-editor` เหมือน browser automation เพราะ brittle และพังง่าย ควรย้าย core workflow สำคัญไปเป็น backend jobs แล้วให้ MCP เป็นตัวสั่งงานบน API เหล่านั้น

## MCP คืออะไรในบริบท HeroAI

MCP server ไม่ใช่ AI model ตัวใหม่ แต่เป็น server ที่ประกาศ tools/resources ให้ agent เรียกใช้ได้

ใน HeroAI MCP server จะเป็นประตูให้ agent ทำสิ่งเหล่านี้:

- สร้างวิดีโอ
- เช็คสถานะ render/avatar/B-roll
- อ่านรายการวิดีโอของ user
- audit production jobs
- ดึง insight
- rerun บางขั้นตอน
- ส่ง final video URL กลับไปให้ user

## Transport ที่ควรรองรับ

### Local stdio

เหมาะสำหรับ MVP ภายในทีม

ข้อดี:
- ทำเร็ว
- ไม่ต้องเปิด endpoint สาธารณะ
- security ง่ายกว่า

ข้อเสีย:
- setup ต่อเครื่อง
- ไม่เหมาะกับ user ทั่วไป

ตัวอย่างการต่อกับ Claude Code:

```bash
claude mcp add heroai -- node ./mcp/heroai-server.js
```

### Remote HTTP

เหมาะกับ product จริง

ตัวอย่าง endpoint:

```text
https://studio.heroaiengine.com/mcp
```

ข้อดี:
- update server ทีเดียว ทุก client ได้ tool ใหม่
- เหมาะกับ user/team จริง
- ทำ auth, quota, audit รวมศูนย์ได้

ข้อเสีย:
- ต้องทำ OAuth/token ให้ดี
- ต้องมี rate limit และ permission model
- ถ้าเปิดผิด อาจ expose tool อันตรายให้ agent ใช้

Claude Code รองรับ remote HTTP MCP server และ MCP spec ปัจจุบันใช้ stdio กับ Streamable HTTP เป็น transport หลัก

## Tools ที่ควรมี

### User tools

`create_video_job`

สร้าง job ใหม่จาก prompt/script/settings แล้วคืน `jobId` ทันที ไม่ควรรอ render จนจบใน request เดียว

input ที่ควรมี:

```json
{
  "title": "string",
  "script": "string",
  "durationSec": 60,
  "voiceProvider": "gemini",
  "voiceId": "string",
  "useBroll": true,
  "brollStyle": "cinematic",
  "useAvatar": true,
  "avatarTiming": "bookend-both",
  "avatarIntroSecs": 5,
  "avatarTailSecs": 5,
  "subtitlePreset": "string",
  "musicId": "string"
}
```

output:

```json
{
  "jobId": "string",
  "status": "queued",
  "message": "Video job queued"
}
```

`get_video_status`

เช็คสถานะ job/video

output ควรบอกขั้นตอน:

```json
{
  "jobId": "string",
  "status": "processing",
  "currentStep": "broll",
  "progress": 42,
  "startedAt": "datetime",
  "updatedAt": "datetime",
  "error": null
}
```

`list_my_videos`

ดูรายการวิดีโอของ user ที่ auth อยู่

`get_video`

ดูรายละเอียดวิดีโอ 1 รายการ รวม settings, status, final URL, error ถ้ามี

`download_video`

คืน final download URL หรือ signed URL

`rerun_video_step`

rerun เฉพาะบางขั้น เช่น B-roll, subtitles, avatar tail

ควรจำกัด enum step:

```text
broll | subtitles | avatar_intro | avatar_tail | composite | burn_subtitles
```

### Admin tools

ควรแยก namespace หรือ role ให้ชัดเจน

`admin_get_insights`

ดึง stats จาก `/admin/insights`

`admin_audit_user_jobs`

ดูงานของ user ด้วย email เช่น `duckyhero@gmail.com`

`admin_reconcile_processing_jobs`

ตรวจ jobs ที่ค้าง `PROCESSING`

`admin_get_recent_errors`

ดึง error summary จาก logs หรือ TelemetryEvent

หมายเหตุ: destructive tools เช่น delete video, edit user plan, deploy production ไม่ควรเปิดใน MCP รุ่นแรก

## Resources ที่ควร expose

MCP resources ใช้ให้ agent อ่านข้อมูลเป็น context ได้

ตัวอย่าง:

```text
heroai://docs/video-workflow
heroai://schema/video-job
heroai://user/settings
heroai://admin/insights-summary
heroai://video/{videoId}
heroai://job/{jobId}
```

Resources ควรเป็น read-only และ enforce permission ตาม user

## Backend ที่ควรเพิ่ม

ปัจจุบันหลาย flow ยังผูกกับหน้า `/video-editor` และ browser state จึงควรเพิ่ม backend job layer

โครงสร้างที่แนะนำ:

```text
MCP Client
  -> HeroAI MCP Server
    -> HeroAI API
      -> VideoJob table
      -> Worker/Queue
        -> TTS
        -> Transcribe
        -> Keywords
        -> B-roll
        -> Render
        -> Avatar
        -> Composite
        -> Burn subtitles
```

API ที่ควรมี:

```text
POST /api/jobs/video
GET  /api/jobs/video/:id
POST /api/jobs/video/:id/cancel
POST /api/jobs/video/:id/rerun
GET  /api/jobs/video/:id/events
```

ถ้ายังไม่ทำ queue จริงใน Phase 1 อาจ reuse existing API ได้ก่อน แต่ควรออกแบบ interface ให้เปลี่ยนเป็น queue ได้ภายหลัง

## Database ที่ควรเพิ่ม

ควรมี `VideoJob` หรือ `GenerationJob` แยกจาก `Video`

field ที่ควรมี:

```text
id
userId
videoId
type
status
currentStep
progress
inputJson
outputJson
errorMessage
costJson
idempotencyKey
createdAt
updatedAt
startedAt
finishedAt
```

ควรมี `ToolCallAudit`

```text
id
userId
toolName
requestJson
responseJson
status
durationMs
costJson
ipAddress
userAgent
createdAt
```

## Auth และ Security

เรื่องนี้สำคัญที่สุดถ้าจะเปิดให้คนอื่นใช้

ต้องมี:

- auth token ต่อ user
- role-based access control
- quota ต่อ user/plan
- rate limit ต่อ user/tool
- idempotency key กันเรียกซ้ำแล้วเสีย credit ซ้ำ
- audit log ทุก tool call
- permission แยก admin/user
- output filtering ไม่คืน secret/API key
- tool allowlist สำหรับ user ทั่วไป
- confirmation สำหรับ action ที่มี cost สูง

ตัวอย่าง policy:

```text
FREE: read-only tools + create demo job limited
PRO: create_video_job, list_my_videos, get_video_status
BUSINESS: team jobs, batch creation
ADMIN: audit, insights, reconcile
```

ควรระวัง prompt injection โดยเฉพาะ tools ที่อ่านเว็บ/ไฟล์/stock content แล้วเอากลับมาให้ agent ตัดสินใจ

## Cost

MCP protocol ไม่มีค่าใช้จ่ายโดยตรง

ค่าใช้จ่ายจริงมาจาก:

- hosting MCP server
- render CPU/RAM
- storage และ bandwidth
- Gemini / ElevenLabs / HeyGen / stock provider
- Claude Code / OpenAI / OpenClaw ที่ผู้ใช้เลือกใช้
- development time

ประมาณการ:

```text
Local/internal MCP MVP: 1-3 วัน
Remote MCP + auth/quota/audit: 1-2 สัปดาห์
Full backend job orchestration: 2-4 สัปดาห์
```

Hosting:

```text
ใช้ VPS เดิม: อาจแทบไม่มีเพิ่มในช่วงแรก
แยก service เล็ก: $5-20/เดือนขึ้นไป
production scale: ขึ้นกับจำนวน render/jobs
```

## Phase Plan

### Phase 0: Research + design

- เลือก SDK สำหรับ MCP server
- สรุป tools v1
- สรุป auth model
- สรุปว่าใช้ local stdio หรือ remote HTTP ก่อน

### Phase 1: Internal MCP MVP

เป้าหมาย: มิวและทีมงานใช้ใน Claude Code ได้ก่อน

ทำ:

- สร้าง `mcp/heroai-server`
- tools read-only:
  - `list_my_videos`
  - `get_video_status`
  - `get_video`
  - `admin_get_insights`
- tool create เบื้องต้น:
  - `create_video_job` ที่เรียก existing API หรือ mock job ก่อน
- ใช้ API token แบบ manual/env
- audit log เบื้องต้น

### Phase 2: Remote HTTP MCP

เป้าหมาย: ให้ทีมงาน/user เพิ่ม MCP URL ได้

ทำ:

- endpoint `/mcp`
- auth ด้วย OAuth หรือ personal access token
- role/permission
- quota/rate limit
- production logging
- docs วิธี connect Claude Code

### Phase 3: Backend video job pipeline

เป้าหมาย: สั่งสร้างวิดีโอ end-to-end ได้โดยไม่เปิดหน้า editor

ทำ:

- `VideoJob` table
- worker queue
- step state machine
- progress event
- retry/cancel
- idempotency
- cost tracking

### Phase 4: Public/Team rollout

เป้าหมาย: เปิดให้ user ใช้จริง

ทำ:

- onboarding UI ใน Settings
- MCP token management
- revoke token
- usage dashboard
- announcement/changelog
- docs ตัวอย่าง prompts

## Minimum Viable Tool Set

ถ้าต้องทำเร็วที่สุด ให้เริ่มจาก 5 tools:

```text
get_current_user
list_my_videos
get_video_status
create_video_job
admin_get_insights
```

อย่าเพิ่งทำ:

```text
delete_video
deploy_production
edit_user_plan
edit_api_keys
run_shell
```

## Example Claude Code Setup

Local stdio:

```bash
claude mcp add heroai -- node ./mcp/heroai-server.js
```

Remote HTTP:

```bash
claude mcp add --transport http heroai https://studio.heroaiengine.com/mcp \
  --header "Authorization: Bearer HEROAI_TOKEN"
```

หรือใช้ OAuth ภายหลัง เพื่อไม่ให้ user ต้อง copy token เอง

## Open Questions

- จะเริ่มจาก internal MCP หรือ remote HTTP เลย
- จะให้ user login ผ่าน OAuth หรือ token จาก Settings
- จะทำ queue จริงทันทีหรือ wrap existing API ก่อน
- จะคิด quota MCP แยกจาก quota หน้าเว็บหรือรวมกัน
- จะเปิด admin MCP ให้ใครบ้าง
- จะให้ agent สร้างวิดีโอแบบ async เท่านั้นหรือมี synchronous short job ด้วย

## Checklist วันเริ่มงาน

1. สร้าง branch ใหม่ เช่น `feature/heroai-mcp-server`
2. อ่าน current API ของ `/video-editor` และ list endpoint ที่ reuse ได้
3. ออกแบบ `VideoJob` schema
4. เลือก MCP SDK
5. ทำ local stdio MCP ก่อน
6. ทำ tools read-only ก่อน
7. เพิ่ม `create_video_job` แบบ async
8. เพิ่ม audit log
9. ทดสอบกับ Claude Code
10. ค่อยตัดสินใจ remote HTTP rollout

## References

- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- MCP transports spec: https://modelcontextprotocol.io/docs/concepts/transports
- OpenAI Agents SDK MCP docs: https://openai.github.io/openai-agents-python/mcp/
