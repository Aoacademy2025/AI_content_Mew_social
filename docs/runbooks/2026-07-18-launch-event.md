# Runbook วันงานเปิดตัว — เสาร์ 2026-07-18

> เปิดจากมือถือได้ ทำตามทีละบรรทัด. SSH: `ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230` แล้ว `cd /var/www/ai-content`.

## A. ก่อนงาน (ศุกร์ — deploy สุดท้ายก่อนเที่ยง แล้ว FREEZE)

1. Merge 6 branches (ลำดับใดก็ได้ ไฟล์ไม่ชนกัน ยกเว้น: ถ้า conflict ที่ `ecosystem.config.js` ให้เอาทั้งสองฝั่ง):
   `mew/stab-1-render-loopback-media` · `mew/stab-task2-mcp-tts-timing-fallback` · `mew/stab-3b-webhook-noop-log` · `mew/stab-6-concurrency-formalize` · `mew/stab-task7-byok-preflight` · `mew/stab-8-stale-bundle`
2. Deploy แบบมี gate + drain:
   ```
   REQUIRE_EMPTY_RENDER_QUEUES=1 bash deploy/deploy.sh   # รอคิวว่างเองถ้ามีงานค้าง
   ```
3. คำสั่งครั้งเดียวหลัง deploy (สำคัญ — ไม่ทำ = ค่า concurrency ในไฟล์ไม่มีผล):
   ```
   pm2 restart ecosystem.config.js --only mcp-video-worker --update-env && pm2 save
   ```
4. แก้ crontab (`crontab -e`) — เปลี่ยนบรรทัด tmp-cleanup ตี 3 เป็นแบบเช็คอายุ 12 ชม.:
   ```
   0 3 * * * find /tmp -maxdepth 1 \( -name 'remotion-*' -o -name 'react-motion-render*' -o -name 'puppeteer_dev_chrome_profile-*' \) -mmin +720 -exec rm -rf {} +
   ```
5. เติม `.env` (ท้ายไฟล์):
   ```
   ADMIN_EMAILS=duckyhero@gmail.com
   ALERT_WEBHOOK_URL=<คัดลอก URL discord จากบรรทัด ops-watchdog ใน crontab -l>
   RENDER_INTERNAL_BASE_URL=http://127.0.0.1:3000   # เปิด fix 503→render (ใช้ได้เพราะ render-worker อยู่เครื่องเดียวกัน)
   ```
   แล้ว `pm2 restart ai-content render-worker --update-env && pm2 save`
6. **Smoke test บังคับ** (หลังข้อ 5): เรนเดอร์คลิปสั้น 1 คลิปบน prod ให้จบ + เปิดดูไฟล์เล่นได้ (พิสูจน์ loopback media). ถ้าพัง: ลบบรรทัด `RENDER_INTERNAL_BASE_URL` ออก, restart ซ้ำ = กลับพฤติกรรมเดิมทันที
7. เช็ค log 30 นาทีหลัง deploy: `pm2 logs ai-content --lines 100 | grep -aiE "error|fail"` — pattern เดิม (503 media, ไม่มี subtitle timing, ElevenLabs 401) ต้องไม่โผล่ใหม่
8. Stripe: เข้า Dashboard หา event `checkout.session.completed` เวลา **2026-07-13 20:08 น.** — ถ้าเป็นลูกค้าจริงที่จ่ายแล้วไม่ได้แผน ให้บันทึกผ่าน admin manual-payment แล้วตั้งแผนให้
9. ทดสอบ stale-bundle toast 1 ครั้ง (สคริปต์ console 3 บรรทัดใน `scratchpad/sdd/stab-task-8-report.md`)

## B. เช้าวันงาน (เช็ค 10 นาที)

```
pm2 status                                   # ทุกตัว online, cron apps "stopped" = ปกติ
df -h / && free -m && uptime                 # disk <60%, RAM ว่าง >10G, load <2
ls -la .cron-heartbeat/                      # heartbeat วันนี้ครบ
curl -s -o /dev/null -w "%{http_code}" https://studio.heroaiengine.com   # 200
sqlite3 -readonly prisma/dev.db "SELECT status,COUNT(*) FROM VideoJob WHERE status IN ('queued','processing') GROUP BY 1;"   # ไม่มีซากค้างจากเมื่อคืน
```
เรนเดอร์คลิปทดสอบ 1 คลิปให้จบก่อนคนเข้า

## C. ระหว่างงาน — จอเฝ้า (รันซ้ำทุก ~15 นาที หรือเมื่อมีคนบ่น)

```
sqlite3 -readonly prisma/dev.db "SELECT status,COUNT(*) FROM VideoJob WHERE createdAt > (strftime('%s','now')-3600)*1000 GROUP BY 1;"
uptime && free -m | head -2
pm2 logs mcp-video-worker --lines 30 --nostream | grep -a running
```
- **คิวปกติ:** queued ≤ 4 ไม่ต้องทำอะไร (ผู้ใช้เห็น "รอคิว #N" อยู่แล้ว, ความเร็วระบบ ~20 คลิป/ชม.)
- **คิวค้าง >10 งาน และ load 1-min < 5** → เปิด lever:
  ```
  MCP_WORKER_CONCURRENCY=3 pm2 restart ecosystem.config.js --only mcp-video-worker --update-env
  ```
  (อย่า `pm2 save` — ให้ค่าถาวรอยู่ที่ 2) · เฝ้า load ต้อง < 8 · ปิด lever: สั่งซ้ำด้วย `=2`
- **ห้ามเด็ดขาด:** deploy กลางงาน, `pm2 restart ai-content` ขณะมี render วิ่ง (ถ้าจำเป็นจริง ๆ: รอ `RenderJob`+`VideoJob` processing = 0 ก่อน), ดัน concurrency เกิน 3

## D. ถ้าเกิดเหตุ

**เว็บเข้าไม่ได้ / 503 ทั้งเว็บ:** `pm2 status` → ตัวไหน stopped/errored: `pm2 logs <app> --lines 50` → `pm2 restart <app>` (เฉพาะตัวที่ตาย). ai-content boot ~วินาทีเดียว ผู้ใช้แค่รีเฟรช
**Render ล้มหลายงานติดกัน:** `pm2 logs render-worker --lines 80 | grep -a 503` — ถ้าเป็น 503 media: เช็คว่า ai-content เพิ่ง restart ไหม; ถ้า loopback มีปัญหา → ลบ `RENDER_INTERNAL_BASE_URL` จาก .env + `pm2 restart render-worker --update-env`
**งานค้าง processing นาน >30 นาที:** cron `reconcile-processing` กวาดทุก 15 นาทีอยู่แล้ว — ถ้าไม่หาย: `pm2 logs mcp-video-worker --lines 50` ดูว่า worker ยังหมุนไหม แล้ว `pm2 restart mcp-video-worker` (ปลอดภัย: job requeue เอง)
**ดิสก์/RAM วิกฤต:** disk-watch + watchdog จะเด้ง Discord เอง; `df -h` ถ้า >80%: `ls -t /var/www/ai-content/public/renders | tail` ลบไฟล์เก่าสุดก่อน
**Rollback ทั้ง deploy:** `git log --oneline -10` → `git revert <merge-sha>..` หรือ `git reset --hard <sha ก่อน merge>` (main บนเครื่องเท่านั้น) → `bash deploy/deploy.sh` — DB ไม่ต้องแตะ (ไม่มี schema change ในรอบนี้)

## E. หลังงาน (จันทร์)

- ดู `tts_timing_degraded` ใน telemetry (ควรเป็น 0–หลักหน่วย; spike = timing จริงมีปัญหา)
- เช็ค 503 count ใน nginx log เทียบสัปดาห์ก่อน (ควรเหลือ ~0 นอกช่วง deploy)
- Backlog ที่เลื่อนไว้: pm2 cluster reload · resolveStockUrl predicate · stale HeyGen look message · off-box backup · tsc error checkout/route.ts
