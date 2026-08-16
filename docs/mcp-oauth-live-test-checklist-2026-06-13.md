# HERO AI × Claude desktop (MCP/OAuth) — Test Checklist

> เป้าหมาย: ให้ นร ต่อ HERO AI ผ่าน **Claude desktop app** แล้วสั่งสร้างวิดีโอได้ใน **live สดวันพุธ 2026-06-17**
> prod build ที่เทส: `f14c3a9` · endpoint: `https://studio.heroaiengine.com/api/mcp` · auth: OAuth 2.1 (Clerk + DCR)
> วิธีใช้: ทำ Phase 0 → 4 ให้ผ่านก่อนวันจริง (มิวเทสเอง), Phase 5 = เช็กรายคนตอนสอน นร

---

## Phase 0 — Pre-flight ระบบ (ทำครั้งเดียว, ยืนยันแล้วบางส่วน ✅)

| # | เช็ก | คาดหวัง | สถานะ |
|---|------|---------|:---:|
| 0.1 | `curl .../.well-known/oauth-protected-resource/mcp` | `resource = https://studio.heroaiengine.com` | ✅ verified |
| 0.2 | spoof `X-Forwarded-Host: evil.com` | resource **ยังเป็น** studio.heroaiengine.com | ✅ verified |
| 0.3 | `curl .../api/mcp` ไม่มี token | `401` + `www-authenticate: ... resource_metadata=...` | ✅ verified |
| 0.4 | AS metadata + DCR | `registration_endpoint` ชี้ Clerk (DCR เปิด) | ✅ verified |
| 0.5 | PM2 | `ai-content` + `mcp-video-worker` = online | ✅ verified |
| 0.6 | homepage / pricing | 200 (pipeline เดิมไม่สะดุด) | ✅ verified |
| 0.7 | **Clerk: allowed redirect / OAuth app settings** | desktop app callback ไม่ถูก block | ⬜ เช็กตอนต่อจริง (Phase 1) |

---

## Phase 1 — เชื่อมต่อ connector (OAuth flow) 🔑 สำคัญสุด

ทำใน **Claude desktop app** (เวอร์ชันล่าสุด — ถ้าเก่าจะไม่มีเมนู custom connector)

| # | ขั้นตอน | คาดหวัง | ✅/❌ |
|---|---------|---------|:---:|
| 1.1 | Settings → Connectors → **Add custom connector** | มีช่องใส่ URL | ⬜ |
| 1.2 | ใส่ `https://studio.heroaiengine.com/api/mcp` → Add | เด้ง **หน้า login Clerk** (clerk.studio.heroaiengine.com) | ⬜ |
| 1.3 | login ด้วยบัญชี HERO AI → กด **Authorize / Allow** | redirect กลับ desktop app สำเร็จ ไม่ค้าง | ⬜ |
| 1.4 | connector ขึ้นสถานะ **Connected** | เห็น tools 6 ตัว | ⬜ |
| 1.5 | (ถ้าพัง) เช็ก error | บันทึกข้อความ error ไว้ debug | ⬜ |

> **tools ที่ควรเห็น (6):** `get_current_user`, `list_my_videos`, `get_video_status`, `get_video`, `download_video`, `create_video_job`

---

## Phase 2 — Read-only tools (ยืนยัน auth + plan)

| # | สั่ง | คาดหวัง | ✅/❌ |
|---|-----|---------|:---:|
| 2.1 | "ขอข้อมูลบัญชีฉันหน่อย" → `get_current_user` | คืน email + **plan = PRO/BUSINESS** + คีย์ที่ตั้งไว้ (Gemini/Pexels/…) | ⬜ |
| 2.2 | "ดูวิดีโอของฉัน" → `list_my_videos` | คืน list (ว่างได้ถ้ายังไม่เคยทำ) ไม่ error | ⬜ |
| 2.3 | ยืนยัน plan ใน 2.1 | ถ้าขึ้น `plan_required`/upsell = บัญชีนี้ไม่ใช่ PRO/BUSINESS → ต้องอัปเกรดก่อน | ⬜ |

> ถ้า 2.1 ผ่าน = **OAuth + entitlement gate ทำงานครบ** (ด่านที่ยากสุดผ่านแล้ว)

---

## Phase 3 — สร้างวิดีโอจริง e2e (`create_video_job`)

**เงื่อนไขก่อนสั่ง (จากโค้ดจริง — ถ้าขาดจะ error ทันที):**
- ✅ Gemini key (ใช้ TTS/keywords/config)
- ✅ Pexels **หรือ** Pixabay key (b-roll)
- ✅ ถ้าเลือก voiceProvider=`elevenlabs` → ต้องมี ElevenLabs key
- ✅ plan PRO/BUSINESS + ยังไม่เกินโควตา clip + งานค้าง < 3 ชิ้น

| # | ขั้นตอน | คาดหวัง | ✅/❌ |
|---|---------|---------|:---:|
| 3.1 | "สร้างวิดีโอจากสคริปต์นี้: …(ข้อความสั้นๆ ภาษาไทย)…" | `create_video_job` คืน `jobId` + `status: queued` | ⬜ |
| 3.2 | "เช็กสถานะงาน \<jobId\>" → `get_video_status` | เห็น status เปลี่ยน queued → processing (มี currentStep/progress) | ⬜ |
| 3.3 | รอ ~1.5–2 นาที แล้วเช็กซ้ำ | status = **COMPLETED** + มี `videoUrl` | ⬜ |
| 3.4 | "ขอลิงก์ดาวน์โหลด" → `download_video` | ได้ลิงก์ `.../api/renders/render-*.mp4` เปิดเล่นได้ | ⬜ |
| 3.5 | เปิดวิดีโอตรวจคุณภาพ | มีเสียง TTS + b-roll เปลี่ยนทุก 3–5s + **ซับไทยตรงเสียง** | ⬜ |

> e2e prod ครั้งก่อนทำเสร็จใน **~105s** (video 11.9MB COMPLETED) — ใช้เป็น baseline เวลา

---

## Phase 4 — Edge cases / error handling (ซ้อมรับมือวันจริง)

ทดสอบว่าระบบ "พังอย่างสุภาพ" — ตอบ error อ่านรู้เรื่อง ไม่ใช่ crash

| # | สถานการณ์ | คาดหวัง (in-band error message) | ✅/❌ |
|---|-----------|-------------------------------|:---:|
| 4.1 | บัญชี FREE ลอง `create_video_job` | `plan_required` + ข้อความชวนอัปเกรด (ไม่ใช่ 500) | ⬜ |
| 4.2 | ไม่ได้ตั้ง Gemini key | `missing_key` "ต้องตั้งค่า Gemini key ก่อน" | ⬜ |
| 4.3 | ไม่ได้ตั้ง Pexels/Pixabay | `missing_key` "ต้องตั้งค่า Pexels หรือ Pixabay key ก่อน" | ⬜ |
| 4.4 | สั่งงานพร้อมกัน > 3 ชิ้น | `too_many_jobs` "มีงานค้างอยู่หลายชิ้นแล้ว…" | ⬜ |
| 4.5 | เกินโควตา clip | `quota_exceeded` + ข้อความโควตา | ⬜ |
| 4.6 | revoke PAT/disconnect แล้วสั่งซ้ำ | `401` / ต้อง auth ใหม่ (ไม่หลุดข้อมูลคนอื่น) | ⬜ |
| 4.7 | ขอ `get_video_status` ของ id มั่ว | `kind: "none"` / not found (ไม่ crash) | ⬜ |

---

## Phase 5 — เช็กความพร้อม นร รายคน (ก่อน/ระหว่าง live)

แจก นร ทำตามนี้ก่อนถึงขั้นสร้างวิดีโอ:

| # | นร ต้องมี | วิธีเช็ก | ✅/❌ |
|---|-----------|---------|:---:|
| 5.1 | บัญชี HERO AI แผน **PRO/BUSINESS** | login studio.heroaiengine.com → ดู plan | ⬜ |
| 5.2 | ตั้ง **BYOK keys** ครบ (Gemini + Pexels/Pixabay) | Settings → API keys | ⬜ |
| 5.3 | Claude **desktop app** เวอร์ชันล่าสุด | มีเมนู custom connector | ⬜ |
| 5.4 | ต่อ connector `https://studio.heroaiengine.com/api/mcp` | login Clerk สำเร็จ เห็น 6 tools | ⬜ |
| 5.5 | สั่ง `get_current_user` ผ่าน | ยืนยัน plan + keys พร้อม | ⬜ |
| 5.6 | สั่ง `create_video_job` ตัวอย่าง 1 ชิ้น | ได้ jobId → COMPLETED | ⬜ |

---

## หมายเหตุ / ทางหนีทีไล่วัน live

- **URL เดียวกันหมดทุกคน:** `https://studio.heroaiengine.com/api/mcp` (auth แยกรายคนผ่าน Clerk login ของแต่ละคน)
- **render ไม่มี global queue** — งานพร้อมกันหลายคนใช้ worker เดียว (concurrency 1) → ถ้า นร เยอะ คิวอาจยาว; cap งานค้าง 3/คน ช่วยกันไม่ให้คนเดียว flood. ถ้า live มีคนเยอะ แนะนำสั่งทีละกลุ่ม
- **บัญชี dev/test ห้ามใช้คีย์ของลูกค้า** — เทส e2e ใช้บัญชี duckyhero (มิว) เท่านั้น
- **ถ้า OAuth connector พังวันจริง** — สำรอง: ผู้ใช้ที่ใช้ Claude **Code (CLI)** ต่อด้วย **PAT** ได้ (header `Authorization: Bearer heroai_pat_…`) — แต่ นร ส่วนใหญ่ใช้ desktop app จึงต้องพึ่ง OAuth เป็นหลัก
- **rollback ฉุกเฉิน:** `git revert -m 1 fd8e888` + redeploy (ดู memory `heroai-mcp-phasea`)
