# Friction log — prod walkthrough 2026-08-25 (desktop 1456px, Chrome)

## Landing /
- Hero: headline ชัด, CTA "สร้างคลิปแรกฟรี" + micro-proof "PRO ฟรี 7 วัน · 15 นาที / ไม่ใช้บัตร / AI หลักระบบดูแลให้" — ดี
- Founding bar บนสุด "เหลือ 86/100" — social proof/urgency ดี แต่ตัวเลขค้างที่ 86 มานาน (จาก memory: 96 ตั้งแต่ 07-05 → 86 วันนี้) เชื่อถือได้
- ⚠️ Scroll ด้วย wheel เร็วๆ → ผืนว่างขนาดใหญ่ (reveal-on-scroll ยังไม่ trigger) ~1–2 วิ ก่อน content โผล่ — ดูเหมือนหน้าเสีย
- Pricing: default = รายปี (฿250/เดือน ชำระ ฿2,995/ปี) — ดีสำหรับ North Star annual; Free card ระบุ "5 นาที + 2 คลิป/30 วัน, คลิปละ ≤2 นาที, เก็บ 3 วัน"
- Pricing copy: "ทดลอง Pro ฟรี 7 วัน · สร้างคลิปได้รวม 15 นาทีช่วงทดลอง" (hero บอก 15 นาที ด้วย) — สอดคล้อง

## /register
- ⚠️ Clerk form render ช้า ~3–4 วิ; ครึ่งขวาของหน้าว่างเปล่าระหว่างรอ (ไม่มี skeleton)
- ⚠️ ฟอร์ม Clerk เป็นภาษาอังกฤษล้วน ("Create your account / Welcome! Please fill in the details") บนหน้าไทยทั้งหน้า — inconsistency
- Email+password ก่อน Google ไม่ได้ — Google อยู่บนสุด ดี
- Copy ซ้าย: "AI Avatar พิธีกร", "17 สไตล์", "อัปโหลดคลิป" — โปรโมทฟีเจอร์ขั้นสูงที่ต้องมี key (HeyGen) ให้คนใหม่ → ตั้งความคาดหวังผิดตั้งแต่ก่อนสมัคร

## /dashboard (first login, trial PRO)
- 🔴 สิ่งแรกที่เห็นหลังสมัคร = modal "เริ่มต้นใช้ HERO AI" ขอ Pexels/Pixabay API key (ต้องออกไปสมัครเว็บภายนอก) — ยังไม่เคยเห็นคุณค่าใดๆ ก่อนถูกขอให้ทำการบ้าน; ปุ่ม "ข้ามก่อน" มีแต่เล็ก
- 🔴 ซ้อน 3 ชั้น: trial banner (บน) + update banner v1.6.0 (ใต้ header, ใหญ่) + onboarding modal → hierarchy พัง, คนใหม่ไม่รู้ควรทำอะไรก่อน
- ⚠️ ตัวเลขขัดกัน: กล่อง "วิธีใช้งาน" บอก "คุณมี 80 นาที/เดือน" แต่ badge "โควต้านาที 15/15" และ trial banner บอก "15 นาที ใน 7 วัน" → 3 ตัวเลขใน 1 หน้าจอ
- ⚠️ Sidebar CTA หลักสีม่วง = "Upgrade to Business" สำหรับคน trial PRO วันแรก (ควรเป็น "สร้างคลิปแรก" หรือ upgrade PRO) — BUSINESS 150 นาที ไม่ relevant กับคนที่ยังไม่เคยใช้ 1 นาที
- ⚠️ "Hero credits 0" โชว์ทันที → คำถาม "เครดิตคืออะไร ทำไมเป็น 0" ก่อนจะรู้จักระบบ
- ⚠️ การ์ด STYLES 0 / VIDEOS 0 / Gallery "ดู renders เก่า" — empty states ไม่พาไปไหน; Dashboard ไม่มี "ขั้นถัดไปของคุณคือ…" ชัดๆ (มี checklist 0/1 แต่เป็นเรื่อง key)
- 👍 "ระบบจัดการ AI (Gemini) ให้" ลด friction จริง (zero-setup voice ทำงาน)

## /video-editor step 1
- ⚠️ หน้าว่าง 100% ไม่มี sample script / template / ปุ่ม "ให้ AI เขียนให้" (Hero Script อยู่คนละเมนู "เขียนสคริปต์ AI" ในไซด์บาร์ ไม่ถูกเชื่อมจากตรงนี้)
- ⚠️ Editor เป็น full-screen ไม่มี sidebar; ปุ่มออก = X ของ update banner (สับสน) — update banner ยังตามมาโชว์ในหน้า editor
- 👍 auto-segment HOOK/เนื้อหา/CTA + เวลาโดยประมาณ ดีมาก, "31 คำ · 3 เซ็กเมนต์ · ~0:11" ดี

## step 2 องค์ประกอบ
- 👍 ทุกอย่างมี default (AutoMix แนะนำ, Gemini Aoede, Faceless) กด render ได้ทันที; สรุปการตั้งค่าขวา ชัด; "ใช้ ~1 จาก 15 นาที" ชัด
- ⚠️ ไม่มี preflight เตือนว่ายังไม่มี Pexels/Pixabay key ทั้งที่การ์ด "สต็อกฟรี · Pexels/Pixabay" และ AutoMix ต้องใช้ → กด render ได้ (ดูผลด้านล่าง)
- ⚠️ "Hero AI Voice — เร็วๆ นี้" tab ที่กดไม่ได้ อยู่ตำแหน่งแรก; "Hero AI Image Beta" + "8 ภาพจากสิทธิ์ทดลอง เหลือ 8/8" = ศัพท์ 3 ระบบ (นาที/เครดิต/สิทธิ์ทดลองภาพ) ในหน้าเดียว
- Render Receipt: ชัด ("1 นาที รวมในแพ็กเกจ เหลือ 15 จาก 15", "ภาพ AI ใช้สิทธิ์ทดลอง 1 ภาพ")
- Progress modal: 4 ขั้น + "~3–6 นาที" + "ปิดหน้านี้ได้" 👍

## Render result (ไม่มี key ใดๆ)
- ✅ เรนเดอร์สำเร็จใน ~2.5 นาที มี b-roll + ภาพ AI 1 ภาพ + ซับ + พาดหัว → **zero-setup ใช้ได้จริง** แต่ onboarding บอกตรงข้าม ("Pexels/Pixabay จำเป็น")
- Post phase: การ์ดซับ 8 ใบ + 3 แท็บ (พาดหัว/ซับ/โลโก้) + timeline 4 track โผล่พร้อมกัน — เยอะสำหรับคลิปแรก แต่ปุ่ม "ส่งออกวิดีโอ" อยู่มุมขวาบนชัด
- ⚠️ พาดหัวอัตโนมัติตัดกลางประโยค ("...3 วินาทีแรก วันี้จะบอก 3") — ค่า default ควรตัดที่จบประโยค/segment แรก
- Export (burn) ~50 วิ → **FirstClipConvertPrompt** ขึ้นทันที: "สมัครรายเดือน ฿599/เดือน" / "ซื้อรายปี Founding ฿2,995" / "ไว้ทีหลัง"
  - ⚠️ ราคา ฿599 ขัดกับ landing ที่จำ ฿250/เดือน → shock; ไม่บอกว่า trial ยังเหลือ 7 วัน / 14 นาที (ทำไมต้องจ่ายวันนี้?)
  - ⚠️ ขึ้นซ้ำอีกครั้งทันทีที่เข้า /pricing (dismiss เก็บใน sessionStorage แต่ mount 2 จุด) → รู้สึกถูกเร่ง
  - ⚠️ ขึ้นก่อนที่ user ได้ดู/ดาวน์โหลดคลิปด้วยซ้ำ (ยังไม่เห็นผลงานตัวเองเต็มๆ)

## Stripe checkout (รายเดือน)
- ⚠️ ภาษาอังกฤษล้วน ("Subscribe / Total due today"), โลโก้เล็กเบลอ, ไม่มี PromptPay สำหรับรายเดือน (มีเฉพาะรายปี/จ่ายครั้งเดียว)
- ⚠️ ไม่มี trust element (ยกเลิกได้ทุกเมื่อ / ใบเสร็จ / ราคารวม VAT?) ที่ฝั่งซ้าย

## /pricing (in-app, trial day 1)
- 👍 band บน: "ทดลอง PRO เหลือ 7 วัน · ใช้ไป 1/15 นาที" + founding 86/100 + toggle รายเดือน/รายปี + PromptPay/บัตร
- ⚠️ PRO card = 12 bullets, Free = 5, Business = 5 → ไม่ใช่ "lean convert page" ตามกติกา; ศัพท์ปนกัน (นาที, คลิป, เครดิต, ภาพ AI 2 เครดิต, เก็บวิดีโอ x วัน)
- ⚠️ "หลังหมดทดลองจะกลับเป็น Free — เหลือ 5 นาที/เดือน · ~5 คลิป" vs Free card "สูงสุด 2 คลิป/30 วัน" (ขัดกันในหน้าเดียว)
- ⚠️ "ปิด ... ตัดต่อในเว็บ" หลังหมด trial — จริงๆ Editor v2 เปิดให้ FREE (copy เท็จ ทำลายความเชื่อถือ)
- ⚠️ Credit packs (3 การ์ด) อยู่หน้าเดียวกับ plan → คนใหม่ไม่รู้ต่างกันยังไง; footnote "เครดิตไม่ปลดล็อก Hero AI Image" ขัด PRO bullet "ภาพ AI 2 เครดิต/ภาพ"
