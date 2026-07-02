# Editor v2 — Launch Runbook (P7)

> สถานะ ณ 2026-07-03 กลางคืน: P0–P6.5 SHIPPED ทั้งหมด (dormant). เหลือ 3 อย่างที่เป็นของ Mew:
> **(A) QA รอบสุดท้าย → (B) อัปเกรดเซิร์ฟเวอร์ → (C) flip flags.** เอกสารนี้คือลำดับกดจริงทีละขั้น.

## A. QA รอบสุดท้าย (บน prod ผ่าน override — ผู้ใช้ยังไม่เห็น)

เปิด `studio.heroaiengine.com/video-editor?ui=v2` แล้วไล่ตามนี้:

**Flow 1 — สคริปต์ + สต็อกฟรี (หลัก):**
- [ ] สเต็ป 1: พิมพ์สคริปต์ 4-6 บรรทัด → ตัวนับคำ/เซ็กเมนต์/คลิปยาว สมเหตุผล → ลากสลับเซ็กเมนต์ได้
- [ ] สเต็ป 2: เลือกเสียง Gemini (ฟังตัวอย่าง) → เพลง (ปุ่ม ▶ ฟังได้) → Faceless → เรนเดอร์
- [ ] จอเรนเดอร์: เช็กลิสต์เดินตามจริง → **ปิดแท็บ → เปิดใหม่ → resume** → เสร็จเข้าเฟสแต่งซับ
- [ ] แต่งซับ: แก้ข้อความ 1 การ์ด · เปลี่ยนสไตล์จาก "สไตล์ทั้งหมด" (17) · เอฟเฟกต์ · ขนาดฟอนต์ · สีรายการ์ด (ใช้สีกับ: การ์ดที่เลือก) · รวม/แยกการ์ด · ความยาวการ์ด 2 ประโยค · ลากขอบซับบน timeline + Ctrl+Z
- [ ] **ส่งออกวิดีโอ** → ซับตรงตามที่แต่งทุกอย่าง → เข้า Gallery → ดาวน์โหลดได้ → **นาทีถูกหักครั้งเดียว** (เช็คใน quota chip — burn ต้องฟรี)
- [ ] ออกจากหน้าหลังเสร็จ → กลับมา → งานยังอยู่ → "เริ่มโปรเจกต์ใหม่" เคลียร์ถูกต้อง

**Flow 2 — Avatar (bookend):** สเต็ป 2 เปิดอวตาร (ขั้นสูง: เปิด+ปิด/วินาที) → เรนเดอร์ (~15-25 นาที) → เช็คตำแหน่ง/สเกลตาม preset ที่บันทึกไว้ → ⚠️ **เช็คว่า burn ตอนส่งออกไม่หักนาทีซ้ำ** (เคส composite — จุดเดียวที่ยังไม่ได้พิสูจน์ใน verify)

**Flow 3 — Cutaway (ต้องเปิด `NEXT_PUBLIC_CLIP_CUTAWAY=1` ก่อน — ดูข้อ C ลำดับ):** อัปคลิปแนวตั้ง → (คลิปแนวนอนต้องโดนเตะ) → เรนเดอร์ → เช็กลิสต์ upload → เสร็จ: คลิปตัวเอง+บีโรลสลับ เสียงต่อเนื่อง → แต่งซับ → ส่งออก

**Flow 4 — กันพัง:** ยกเลิกงานกลางคัน (ทั้งตอนคิวและตอนกำลังทำ) · UI เก่า (`?ui=v1`) ยังปกติทุกจุด · MCP เจน 1 คลิปปกติ (path เดิมต้องไม่เปลี่ยน)

## B. อัปเกรดเซิร์ฟเวอร์ 8c/32GB (Hostinger — ก่อน flip เสมอ, decision #9)

1. แจ้งช่วง maintenance สั้น ๆ (ถ้า Hostinger ต้อง reboot) — เลือกช่วงเงียบ (ตี 3-5)
2. เช็คคิวว่าง: `sqlite3 /var/www/ai-content/prisma/dev.db "SELECT COUNT(*) FROM VideoJob WHERE status IN ('queued','processing');"` (+ RenderJob)
3. อัปเกรดแผนใน hPanel → รอ resize → SSH เช็ค `nproc` = 8, `free -h` ≈ 32GB
4. เช็คทุกแอป online: `pm2 list` — ถ้าเครื่อง reboot: `pm2 resurrect` ควรคืนทุกตัว (มี pm2 save ทุก deploy) + เช็ค crons ต้องมี CRON_SECRET (ดู CLAUDE.md)
5. Smoke: homepage 200, เจน 1 คลิปผ่าน MCP
6. (แนะนำ, หลังนิ่ง) เพิ่ม concurrency worker เป็น 2-3 งานขนาน — งานแยกต่างหาก อย่าทำวัน launch

## C. Flip flags (launch จริง)

1. เช็คคิวว่าง (คำสั่งเดียวกับ B.2) — **คำสั่งแยก ก่อน deploy เสมอ**
2. แก้ `/var/www/ai-content/.env` เพิ่ม 2 บรรทัด:
   ```
   NEXT_PUBLIC_EDITOR_V2=1
   NEXT_PUBLIC_CLIP_CUTAWAY=1
   ```
   (`NEXT_PUBLIC_BROLL_WINDOW_MODE=1` มีอยู่แล้ว — cutaway ต้องการมัน)
3. Rebuild + restart: `cd /var/www/ai-content && BUILD_HEAP_MB=4096 BUILD_WORKER_HEAP_MB=512 BUILD_HEAP_MB_LOW=3072 BUILD_WORKER_HEAP_MB_LOW=512 BUILD_NO_LINT=1 bash deploy/deploy.sh`
4. **Verify แบบเต็ม (บทเรียน 07-03: bundle บนดิสก์ ≠ ที่เสิร์ฟ):**
   - `Deploy finished successfully` ใน log
   - `pm2 list` → uptime ทั้ง 3 แอป **รีเซ็ตเป็น 0**
   - เปิด `/video-editor` แบบไม่มี `?ui` → ต้องเห็น **v2**
   - `?ui=v1` → ยังกลับ UI เก่าได้ (ทางหนีของผู้ใช้)
5. โพสต์ /updates (isPinned=true, prisma script ใน /var/www/ai-content — ดู memory product-updates-posting)

## Rollback (ถ้าพัง)

- ลบ/คอมเมนต์ 2 บรรทัด flag ใน `.env` → rebuild ด้วยคำสั่งเดิม → verify uptime reset → ทุกคนกลับ UI เก่า **ไม่ต้อง revert โค้ดใด ๆ**
- ปิดเฉพาะ vision re-rank (ถ้า b-roll เพี้ยน): `BROLL_VISION_RERANK=0` ใน .env + restart ai-content (`--update-env`)

## เฝ้าระวังหลัง launch (วันแรก)

- `pm2 logs mcp-video-worker` — jobs เดินปกติ, ไม่มี fail ถี่
- `sqlite3 ... "SELECT status, COUNT(*) FROM VideoJob WHERE createdAt > strftime('%s','now','-1 day')*1000 GROUP BY status;"`
- Telemetry insights: pipeline_step_error ต่อวัน · disk (`df -h` — cron disk-watch ช่วยอยู่)
- Ticket inbox: คำถาม UI ใหม่ → เตรียม FAQ สั้นใน /docs

## หลัง launch (ไม่รีบ)

- Worker ขนาน 2-3 งาน (หลังเครื่องใหม่นิ่ง) · ถอด UI เก่า + ลิงก์ /content, /videos → ตัดสินอนาคต /video-creator · per-card override ระดับ preset/effect · BGM ในโหมด cutaway · in-step cancel ของ kie loop · AI chips "ช่วยเขียน hook" (fast-follow ที่ตกลงไว้)
