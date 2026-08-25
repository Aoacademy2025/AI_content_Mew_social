# E — Mobile (≤430px) audit

**วิธี:** code-level review ของทุก surface ใน customer journey (read-only, 2026-08-25) + nginx access log วันนี้. ยังไม่ได้เดินบนอุปกรณ์จริง (หน้าต่าง Chrome ที่ควบคุมย่อไม่ได้) — ดู §"ต้องยืนยันบนเครื่องจริง".

**สัดส่วนมือถือ (nginx access.log 2026-08-25, หน้าแอปหลัง login):** mobile 159 / desktop 1,018 = **13.5%**; เฉพาะ `/video-editor` 27/237 = 11%. Telemetry ไม่เก็บ device/viewport เลย → วัดย้อนหลังไม่ได้ (เพิ่มใน #316).

**Baseline:** viewport meta ถูก (`layout.tsx:37-40`, `viewportFit: cover`, ไม่ล็อก zoom). Landing, auth, dashboard shell (BottomTabs + MobileSidebar), Editor v2 (PostPhaseMobile ยังต่ออยู่ที่ `EditorV2Shell.tsx:80,701-705`, MobileSheet ทำถูกต้องมาก, CTA sticky ล่างใน Step1/Step2), Hero Script — ล้วนมี mobile pass จริง ปัญหากระจุกอยู่ที่ (a) surface ที่สร้างก่อน/หลัง pass เหล่านั้น: **Gallery, Brands, modals (upgrade / convert / receipt), Pricing toggles** และ (b) การใช้ `100vh` ทั้งระบบ

## Top 10 ที่น่าจะพังบนมือถือตอนนี้

| # | ปัญหา | หลักฐาน |
|---|---|---|
| 1 | **Gallery: ปุ่มบนการ์ดเป็น hover-only** (Play/Download/Delete/Edit/"ทำต่อ") → Android แตะไม่ได้เลย; draft ProjectCard ไม่มี `cursor-pointer`/handler → iOS ก็เปิด/ลบไม่ได้ | `videos/page.tsx:485, :637, :454`; pattern ที่ถูกมีแล้วที่ `ai-studio/page.tsx:130` (`opacity-100 md:opacity-0 md:group-hover:opacity-100`) |
| 2 | **Gallery preview modal กว้าง 427px บนจอ 390px** (`height:90vh` + `aspectRatio 9/16`) → ปุ่มปิดหลุดจอ; `<video>` ไม่มี `playsInline`/`muted` → iPhone บังคับ fullscreen | `videos/page.tsx:412, :418, :432` |
| 3 | **Brand look preview: `grid-cols-3` ไม่มี sm: fallback** → tile ~100px แต่มีปุ่ม "ลองภาพนี้ใหม่" ~125px ทับกันทั้ง 3 | `brands/_components/BrandLookPreviewPanel.tsx:99, :117-131` (0 breakpoints ทั้งไฟล์) |
| 4 | **Update banner ทับ topbar ของ editor ทั้งแถบ** บนมือถือ (banner stack สูง ~120px, `absolute z-[300]`) | `dashboard-layout.tsx:51-53`, `product-update-banner.tsx:89` (ซ้ำกับ #322) |
| 5 | **UpgradeModal + FirstClipConvertPrompt: ไม่มี max-height/scroll, ปุ่มปิด 16px, ตัวอักษร 12px, 0 breakpoints** — modal ขายของ 2 ตัวหลักของระบบ; convert prompt mount ทุก route | `upgrade-modal.tsx:39-50`, `first-clip-convert-prompt.tsx:93-103` |
| 6 | **RenderReceiptDialog ไม่มี max-height/scroll** → ปุ่ม "เริ่มเรนเดอร์" ตกใต้ toolbar iOS เลื่อนไม่ได้ = render ไม่ได้ | `RenderReceiptDialog.tsx:161-173, :219-241` |
| 7 | **`h-screen`/`100vh` ทั้งระบบ** (ยกเว้น MobileSheet + RecoveryDialog ที่ใช้ `dvh`) → ~90px ล่างของ shell + ทุก `sticky bottom-0` CTA อยู่ใต้ toolbar Safari | `dashboard-layout.tsx:48,61`, `EditorV2Shell.tsx:403`, `Step1Script.tsx:293`, `Step2Elements.tsx:978` |
| 8 | **Pricing: toggle PromptPay/บัตร สูง ~24px ตัวอักษร 12px ไม่ wrap** — ปุ่มที่ตัดสินว่าจ่ายครั้งเดียวหรือ auto-renew; toggle รายเดือน/รายปี ~36px | `pricing-client.tsx:305-310, :298-301` |
| 9 | **Trial banner บรรทัดเดียวไม่ wrap** → ล้นที่ 390px เมื่อมี copy นาที | `trial-banner.tsx:32-42` |
| 10 | **ไม่มี mobile regression ใน CI เลย** — `scripts/verify-marketing-mobile-preview.mjs` (320/342/390/430, เช็ค no-horizontal-scroll + font ≥12px) มีอยู่แต่ไม่รัน; `verify-mobile-sheet.ts` ไม่มี npm script | `.github/workflows/ci.yml` (24 verify, 0 mobile), `package.json:55` |

รองลงมา: ปุ่มปิด modal / eye toggle ของช่อง API key 14–20px (`KeyOnboardingWizard.tsx:83`, `ApiKeyField.tsx:58`); `<button>` ซ้อนใน `<a download>` 3 จุด (`PostPhaseMobile.tsx:285`, `PostPhase.tsx:158`, `EditorV2Shell.tsx:1032`); nested scroll ใน brand-profile dialog (`BrandProfilePanel.tsx:551,555`); hamburger 36px (`top-nav.tsx:30`); `api-key-settings.tsx` ตัวอักษร 10–11px; payment-result modal ใน settings ไม่มี scroll (`settings/page.tsx:345`).

## Feature delta มือถือ vs เดสก์ท็อป (Post phase)
- เดสก์ท็อปเท่านั้น: `TimelinePanel` (`PostPhase.tsx:26,820`) — มือถือไม่มี timeline
- มือถือเท่านั้น: `LayerVisibilityControls` (`PostPhaseMobile.tsx:33,976`) — เดสก์ท็อปไม่มีปุ่มซ่อน/โชว์เลเยอร์ (ticket เคยขอ)

## iOS video / download
- `playsInline` ครบใน editor/post phase; ขาดที่ gallery preview (`videos/page.tsx:418`) และ editor v1 เก่า
- ดาวน์โหลด: ไฟล์ same-origin (`/api/renders/*`) → `<a download>` ทำงานบน iOS 13+ แต่ **ไม่มี `Content-Disposition: attachment`** ที่ server (`media-serving.ts`) → ไฟล์ลง Files ไม่ใช่ Photos; `videos/page.tsx:647` ใส่ `download` + `target="_blank"` พร้อมกัน → เสี่ยง popup block
- playback telemetry ดี แต่ไม่มี device dimension → แยก iOS fail ไม่ได้

## Surface ที่ไม่มี responsive class เลย
`upgrade-modal.tsx` · `first-clip-convert-prompt.tsx` · `BrandLookPreviewPanel.tsx` (พังจริง) · `api-key-settings.tsx` · `mcp-access-settings.tsx` · `ScriptHistory.tsx` · (`DashboardOnboarding.tsx` = wrapper ไม่เป็นไร)

## ต้องยืนยันบนเครื่องจริง (ยังไม่ได้ทำ)
เดิน dashboard → editor → render → export → convert prompt → /pricing บน iPhone Safari + Android Chrome ด้วยบัญชี `duckyhero+uxaudit@gmail.com` เพื่อยืนยันข้อ 2, 5, 6, 7 (ขึ้นกับ toolbar/dvh จริง) และวัดความลื่นของ Post phase บนมือถือ

## แก้ถูกสุดเรียงลำดับ
1. copy pattern `md:opacity-0 md:group-hover:opacity-100` เข้า gallery 2 จุด (1 บรรทัด)
2. gallery modal → `max-h-[90dvh] max-w-[100vw]` + `playsInline muted`
3. `max-h-[90dvh] overflow-y-auto` ใน 3 modal ที่ไม่มีขอบ + ปุ่มปิด ≥44px
4. `h-screen` → `h-dvh` (Tailwind v4 มี) ใน shell/editor
5. wire `verify:marketing-mobile` เข้า CI และขยาย assertion `documentWidth === viewportWidth` ไปยัง route หลัง login (ใช้ Clerk dev key + mewtest)
