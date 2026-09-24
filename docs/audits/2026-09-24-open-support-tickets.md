# Audit support ที่เปิดค้าง — 24 กันยายน 2026

> **อัปเดต release 23:50 Bangkok:** งานขยายแผงซ้าย–ขวาใน PR #550 merge/deploy แล้วที่ `8e0f69d4` / build `AF38ZwrdRJ5WMWsqfwNTv` CI, native deploy และ browser harness บน production host ผ่าน ตรวจ public chunk ตรงกับ build จริง ดู [release record](2026-09-24-editor-panel-release.md) สำหรับหลักฐานและข้อจำกัด browser session Ticket ทั้งสองใบยังปิดตามคำสั่งก่อนหน้า ไม่มีการส่งข้อความซ้ำในรอบ deploy

## อัปเดตล่าสุด 24 ก.ย. 23:19 Bangkok — ปิดเคสตามคำสั่งเจ้าของ

Mew สั่งปิด ticket `cmuffh4n6013plc6ak9qvy7ns` หลังตอบคำแนะนำ Upload แล้ว โดยไม่เพิ่ม Direct URL ในรอบนี้ และให้ติดตามงานขยายแผงแยกใน [PR #550](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/550) จึงปิดโดยไม่อ้างว่าฟีเจอร์ resize deploy แล้ว

Dry-run และ apply ผ่าน ยืนยันสถานะ **CLOSED** เวลา `2026-09-24T16:19:30.652Z` คง `adminReply` / `repliedAt` และ triage/link เดิมครบ เพิ่มเหตุผลปิดลง audit note การแจ้งเตือนเดิมยังหนึ่งรายการ ไม่สร้างแจ้งเตือนหรือส่งอีเมลซ้ำ; receipt เดิมยืนยัน provider รับอีเมลแล้ว (ไม่ยืนยัน inbox delivery) ไม่มีการแก้ Linear/Sentry หรือ deploy ในรอบนี้ งาน resize คงติดตามต่อแยกจากสถานะ support case

หลักฐานส่วนตัว: `~/.codex/artifacts/hero-support-open-audit-20260924/close-upload-status-dry.jsonl` และ `close-upload-status-apply.jsonl`

## อัปเดตล่าสุด 24 ก.ย. 23:16 Bangkok — ส่งคำแนะนำ Upload แล้ว

- Mew อนุมัติใช้ Upload file ที่มีอยู่แทนการเพิ่ม Direct URL ในรอบนี้ และให้แนะนำวิธีอัปโหลดแก่ลูกค้า
- ตรวจ production ก่อนส่ง: ticket `cmuffh4n6013plc6ak9qvy7ns` ยัง OPEN ไม่มีคำตอบเดิม; บัญชีเป็น Pro มีสิทธิ์ยังไม่หมดอายุและไม่ใช่ unconverted trial; browser bundle ที่ deploy จริงมีการ์ด “ใช้คลิปที่ถ่ายเอง” พร้อม `disabled:false` ความมั่นใจสูงว่าเมนูและ entitlement พร้อมจากข้อมูลที่ตรวจ แต่ไม่ได้เข้าหน้าจอลูกค้าหรือสร้างงานเสียเงิน
- Dry-run ผ่าน แล้วส่งคำตอบเรื่องเริ่มโปรเจกต์ใหม่ → ใช้คลิปที่ถ่ายเอง → อัปโหลดคลิปแนวตั้งที่มีเสียงพูด (mp4/mov/webm) โดยระบุว่าใช้เป็นคลิปหลักพร้อมเสียงเดิม และแจ้งว่ากำลังปรับปรุงการขยายแผง
- ยืนยัน `repliedAt=2026-09-24T16:16:14.030Z`, reply ตรง, notification 1 รายการ, provider รับอีเมลแล้ว; ไม่ได้ยืนยัน inbox delivery Ticket **คง OPEN** เพื่อติดตาม resize และบันทึก FEATURE_REQUEST / LOW / ADD_FEATURE พร้อม audit fields ครบ
- [PR #550](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/550) ยัง OPEN/ไม่ deploy CI ครั้งแรกล้มในขั้น Hero Script workspace browser journey ด้วย `TargetCloseError: Page closed!` ซึ่งไม่ใช่ regression test ของ resize; ยังไม่ยืนยันสาเหตุ ได้สั่ง rerun failed job แล้วและ attempt 2 กำลังทำงาน ไม่มีการแก้โค้ดเพิ่มในรอบตอบลูกค้านี้
- ไม่มี Linear หรือ Sentry state เปลี่ยน; ยังไม่สร้าง issue Direct URL และยังไม่ปิด ticket ใบใหม่ รอ CI/merge/อนุมัติ deploy และ symptom smoke สำหรับ resize ก่อน close-out
- หลักฐานส่วนตัว: `~/.codex/artifacts/hero-support-open-audit-20260924/upload-guidance-read.jsonl`, `reply-upload-dry.jsonl`, `reply-upload-apply.jsonl` กระบวนการใช้ `.agents/skills/hero-studio-ops/SKILL.md`

## ประวัติก่อนหน้า

> **อัปเดตหลังอนุมัติ 24 ก.ย. 22:55 Bangkok:** ปิด `cmuckt3h401s3lcysj6t7z69j` แล้ว (`CLOSED`, `repliedAt=2026-09-24T15:55:41.428Z`) หลังตรวจหลักฐาน Avatar สำเร็จซ้ำและ dry-run ผ่าน ส่งข้อความตามที่อนุมัติ สร้างการแจ้งเตือนหนึ่งรายการ และผู้ให้บริการอีเมลรับข้อความแล้ว (ยังไม่ยืนยันการเข้ากล่องจดหมาย) บันทึก audit fields และ link HERO-45 ครบ; HERO-45 คง Done ไม่มีการแก้ Linear/Sentry ส่วน ticket `cmuffh4n6013plc6ak9qvy7ns` ยังเปิดอยู่ ผู้ใช้อนุมัติพัฒนาตัวลากแผงซ้าย–ขวาและจำขนาดแล้ว งานอยู่ branch `codex/editor-panel-resize-20260924`; Direct URL ยังเป็นคำถามอธิบาย ยังไม่อนุมัติเพิ่มฟีเจอร์ ข้อความด้านล่างเป็น snapshot ก่อนการอนุมัตินี้

ข้อความที่ส่งใบ Avatar: “ตรวจสอบแล้วพบว่าสามารถสร้างวิดีโอด้วย Avatar ตัวเดิมได้สำเร็จแล้วครับ ทีมขอปิดคำร้องนี้ หากพบปัญหาอีก แจ้งเวลาและโปรเจกต์ที่เกิดปัญหาเข้ามาได้เลยครับ”

**ผลพัฒนาแผงซ้าย–ขวา:** [PR #550](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/550), head `873151091ddc3a49221fbec5578a0d6f0d790066` เพิ่มตัวลาก/คีย์บอร์ด, จำความกว้างในเบราว์เซอร์, จำกัดขนาดให้พรีวิวยังมีพื้นที่ และเลื่อนแนวนอนได้เมื่อเปิด B-roll บนจอแคบ Browser behavior test, existing preview/B-roll/media-key checks, TypeScript และ production build ผ่านในเครื่อง ไฟล์ใหม่ผ่าน lint; PostPhase มี lint errors เดิม 136 จุดเท่ากับ baseline (rule/message counts ตรงกัน) CI ของ PR กำลังทำงาน ณ 23:07 Bangkok ยังไม่ merge/deploy ยังไม่เปลี่ยนสถานะหรือตอบ ticket ใบใหม่นี้ และไม่ได้แก้ Linear/Sentry เพิ่ม ขั้นต่อไปคือ CI ผ่าน → review/merge → อนุมัติ deploy และ smoke ด้วยเนื้อหา editor จริง ก่อนขออนุมัติข้อความตอบ/ปิดใบใหม่

ตรวจ production แบบอ่านอย่างเดียวช่วง 22:38–22:41 น. Bangkok และเทียบ Linear 54 issues กับโค้ด `9c0fd51cf8403a5d075168ec2c9f1d52ea6c14c7` ผล: เปิดค้างสองใบ ไม่มีเหตุให้สร้าง incident ซ้ำทันที ใบใหม่เป็นคำขอด้าน editor/คำถามการใช้งาน ใบเดิมมีหลักฐานการใช้งาน Avatar ฟื้นแล้วและควรติดตามผลลูกค้า

รายงานนี้เป็นข้อเสนอ disposition และร่างตอบ ไม่ได้บันทึก triage, ส่งข้อความ, ปิด ticket, สร้าง/แก้ Linear หรือแก้ production

| Ticket | เปิดเมื่อ Bangkok / อายุขณะตรวจ | ข้อเสนอ category / severity / action | Canonical issue | ผล audit |
| --- | --- | --- | --- | --- |
| `cmuffh4n6013plc6ak9qvy7ns` | 24 ก.ย. 18:07 / ประมาณ 4.5 ชม. | `FEATURE_REQUEST` / `LOW` / `ADD_FEATURE` | ยังไม่มี issue ตรงเรื่องนี้ | เสนอขยายแผงซ้าย/ขวา; ตอบคำถาม Pipeline/Direct URL แยกเป็น guidance |
| `cmuckt3h401s3lcysj6t7z69j` | 22 ก.ย. 18:13 / ประมาณ 52.5 ชม. | `BUG_CONFIRMED` / `MEDIUM` / `MONITOR` | [HERO-45](https://linear.app/mew-social/issue/HERO-45), Done | ปัญหาเดิมยืนยันแล้ว แต่มี Avatar ตัวเดิมสำเร็จ 4 งานใหม่; ติดตามผลก่อนขออนุมัติตอบ/ปิด |

ทั้งสองแถวยังเป็น `OPEN`, `auditedAt=null`, `repliedAt=null`, category/severity/action ยังว่าง และยังไม่มี Linear/Sentry link ในแถว SupportTicket ณ snapshot การไม่มี link ในแถวไม่ได้แปลว่าไม่มี issue: HERO-45 ระบุ ticket เก่าไว้ตรงกัน

## 1. ขอขยายแผง editor และหา Pipeline/Direct URL

**Claim:** ต้องการลากขยายแผงซับ/โลโก้/พาดหัวด้านขวาและ transcript ด้านซ้าย และถามว่าเปิดหน้าต่าง Pipeline เพื่อเลือก Direct URL จากที่ใด ไม่ได้แจ้งว่างานสร้างหรือส่งออกล้มเหลว

**หลักฐานที่ตรวจได้:**

- Editor V2 เป็นเส้นทางผลิตภัณฑ์ปัจจุบันใน `useEditorV2Flag.ts`; ปิดได้ด้วย build-time emergency flag เท่านั้น และไม่ได้รับ query/localStorage override รุ่นเก่า ดังนั้นไม่ควรแนะนำ `?ui=v1` เป็นทางแก้
- `PostPhase.tsx` กำหนดแผงซ้าย `w-[266px]` และขวา `w-[330px]` ไม่มีตัวลากปรับความกว้างแผงใน desktop post phase ที่ตรวจ
- โค้ดเก่ายังมีตัวลากขยายแผง, `OrderPanel` ที่ใช้ชื่อ Pipeline และตัวเลือก Direct URL ใน `RightSettingsPanel` แต่ไม่ใช่เมนูในเส้นทาง Editor V2 ปัจจุบัน
- ทางเลือกใน V2 คือขั้นแรก → **ใช้คลิปที่ถ่ายเอง** → **อัปโหลดคลิปแนวตั้งของคุณ** ผ่าน `DirectAvatarUpload` เมื่อเปิด `NEXT_PUBLIC_CLIP_CUTAWAY` และมีสิทธิ์ Pro ขึ้นไป นี่เป็นการอัปโหลดไฟล์ ไม่ใช่การวาง URL และไม่ควรอ้างว่าเทียบเท่าการ composite แบบ Direct URL ทุกกรณี
- หลังเปิด ticket บัญชีนี้มี VideoJob ใหม่สำเร็จหนึ่งงาน และ RenderJob สำเร็จหนึ่งงาน เป็นหลักฐานว่ายังใช้เส้นทางสร้างวิดีโอได้ ไม่ได้พิสูจน์ว่าความต้องการ UI ถูกตอบแล้ว
- ตรวจรายการ Linear 54 issues ที่ CLI คืนมา ไม่พบ canonical issue เรื่อง resize side panels หรือการเข้าถึง Direct URL ตรงกัน HERO-53 ดูแลเวลาเปิด editor, HERO-17 ดูแล logo loading, HERO-46 ดูแล React update loop; ไม่ควรรวมเพียงเพราะอยู่หน้า editor เดียวกัน

**Disposition:** feature request สำหรับแผงปรับขนาด + guidance สำหรับ workflow รุ่นใหม่ ความมั่นใจสูงในพฤติกรรมโค้ดที่ตรวจ และปานกลางในการอธิบายภาพที่ลูกค้าเห็น เพราะไม่ได้เปิดภาพแนบ/ตรวจ browser session ของลูกค้า ไม่มีหลักฐานพอเรียกเป็น runtime bug หรือ regression ของ drag handler

**ข้อเสนอ Linear หากสั่ง sync ภายหลัง:** เปิด `Feature`, `Area / Editor`, `Execution / Mew-decision`, priority Low, state Backlog สำหรับการปรับขนาดแผง ไม่ควรเข้า Ready ก่อนกำหนด min/max widths, การจดจำขนาด, keyboard/touch behavior และพื้นที่ preview บนจอเล็ก ส่วนการเพิ่มช่องรับ URL ใน V2 ต้องยืนยัน use case ก่อนแยกเป็น feature ไม่ควรสัญญาว่าจะนำหน้ารุ่นเก่ากลับมา

**ร่างตอบ — ยังไม่ส่ง:**

> หน้า Video Editor รุ่นปัจจุบันยังลากขยายแผงซ้ายและขวาไม่ได้ครับ ส่วน Pipeline และ Direct URL เป็นเมนูจากหน้ารุ่นเก่า จึงไม่ปรากฏในหน้าปัจจุบัน หากมีไฟล์คลิปแนวตั้งที่มีเสียงพูดอยู่แล้ว สามารถเริ่มจาก “ใช้คลิปที่ถ่ายเอง” แล้วอัปโหลดไฟล์ได้สำหรับแผน Pro ขึ้นไปครับ หากต้องการวางลิงก์วิดีโอโดยตรง รบกวนบอกเพิ่มว่าต้องการใช้คลิปนั้นทั้งคลิป หรือวางเป็น Avatar ทับวิดีโอ เพื่อให้ทีมแนะนำขั้นตอนให้ตรงกับงานครับ

การปรับแผงเป็นข้อเสนอผลิตภัณฑ์ ยังไม่ได้รับอนุมัติพัฒนา ไม่ระบุวันส่งมอบ ร่างคำแนะนำ upload ต้องตรวจว่า control เปิดให้บัญชีนั้นจริงก่อนส่ง

## 2. “สร้าง API ใหม่ยังไม่ได้” — HeyGen workspace

**ประวัติเดิม:** ticket นี้ตรงกับ [HERO-45](https://linear.app/mew-social/issue/HERO-45) ซึ่งแก้ข้อความผิดจาก workspace error ไปเป็นคำแนะนำเรื่อง Avatar/API key ผ่าน [PR #533](https://github.com/Aoacademy2025/AI_content_Mew_social/pull/533) และ deploy แล้ว การแก้ข้อความไม่ใช่การซ่อม HeyGen workspace

อ่านฐานข้อมูลสดยืนยันงานก่อน ticket สองงานล้มด้วย `SPACE_ENCRYPTION_DISABLED` ที่ Avatar การแนะนำให้สร้าง API key ใหม่จึงไม่ตรงสาเหตุที่มีหลักฐานรองรับ Sentry group สำหรับ ticket นี้ยังไม่ได้ยืนยัน; ไม่มีเหตุให้สร้าง Sentry/Linear issue ใหม่

**หลักฐานใหม่ที่เปลี่ยนคำแนะนำเดิม:**

- หลัง ticket มี **17 VideoJobs สำเร็จทั้งหมด**: 11 create และ 6 export; มี 17 RenderJobs ที่สร้างหลัง ticket และสำเร็จทั้งหมดด้วย
- ใน create jobs มีห้างานเป็น upload-cutaway และหกงานมี provider Avatar output จึงไม่เหมารวม 17 งานว่าเป็น HeyGen generation ใหม่ทั้งหมด
- **สี่ create jobs ระบุ Avatar input โดยตรง** เป็น `bookend-both`, engine `avatar_iii`; ทุกงานใช้ Avatar ID ตรงกับสองงานที่เคยล้ม และ output preview ระบุ Avatar model ตรงกับ input พร้อม Avatar video reference
- สี่งานนั้นเสร็จวันนี้เวลา **13:59:29, 14:57:00, 17:49:11 และ 19:06:17 Bangkok**
- สองงานที่มี provider-model output แต่ไม่มี explicit Avatar input ถูกแยกออกจากจำนวนสี่ เพราะอาจเป็นงานใช้ข้อมูลเดิม ไม่ใช้เป็นหลักฐาน generation ใหม่

**ข้อสรุป:** มีหลักฐาน durable outcome ว่าบัญชีนี้กลับมาสร้างวิดีโอด้วย Avatar ตัวเดิมได้แล้ว ความมั่นใจสูงสำหรับงานสำเร็จ/ตัว Avatar ตรงกัน แต่ไม่ทราบว่าการตั้งค่า workspace หรือ API key ใดเปลี่ยนไป และไม่ได้เปิดดูคลิปจริงหรือเรียก HeyGen ซ้ำ ผลสำเร็จนี้ไม่ใช่หลักฐานว่า PR #533 ซ่อมระบบ upstream และไม่รับรองว่าจะไม่เกิดซ้ำ

รายงาน/ร่างตอบวันที่ 23 ก.ย. ที่กล่าวว่าไม่มีงานใหม่หลัง ticket ถูกแทนที่ด้วยหลักฐานล่าสุด ไม่ควรส่งร่างเก่าที่บอกให้ติดต่อ HeyGen เพื่อกู้ระบบโดยไม่กล่าวถึงงานที่สำเร็จแล้ว

**Disposition:** คง canonical HERO-45 เป็น Done, ไม่ reopen หรือสร้าง duplicate จากข้อมูลชุดนี้ เก็บ ticket ไว้รอข้อความติดตามผลและการอนุมัติส่ง/ปิด เสนอ severity MEDIUM ตามผลกระทบเดิมและ action MONITOR ตามสถานะปัจจุบัน หากเกิด `SPACE_ENCRYPTION_DISABLED` ใหม่หลังงานล่าสุด ให้ตรวจเวลา/งานเดียวกันก่อนตัดสินว่าเป็น provider recurrence หรือข้อความ guidance regression; ไม่ reopen งานแก้ข้อความที่ยังถูกต้องเพียงเพราะ upstream มีปัญหาอีกครั้ง

**ร่างตอบใหม่ — ยังไม่ส่ง:**

> ทีมตรวจสอบล่าสุดพบว่าวันนี้มีงานสร้างวิดีโอด้วย Avatar ตัวเดิมสำเร็จแล้ว 4 งาน โดยงานล่าสุดเสร็จประมาณ 19:06 น. ครับ ข้อผิดพลาดเดิมเกี่ยวข้องกับพื้นที่ทำงาน HeyGen ตอนนี้ยังพบอาการเดิมอยู่ไหมครับ หากยังพบ รบกวนแจ้งเวลาและโปรเจกต์ที่เกิดปัญหา เพื่อให้ทีมตรวจให้ตรงงาน โดยไม่ต้องส่ง API key มาครับ

ร่างนี้ไม่ขอให้ลูกค้าสร้างงานแบบเสียเงินใหม่เพื่อทดสอบ ไม่สัญญาคืนเงินหรืออ้างว่า provider ไม่คิดเงิน การส่งข้อความและปิด ticket ยังไม่ได้รับคำสั่งใน audit นี้

## ขอบเขตการตรวจและข้อจำกัด

ตรวจ schema, admin support API, ticket text ที่ลบข้อมูลติดต่อ, metadata ของ durable jobs/checkpoint/output โดยประมวลผลบน host และส่งกลับเฉพาะ enum/count/boolean/timestamp, source UI ปัจจุบัน, รายการ Linear และรายละเอียด HERO-45 ไม่ได้ดาวน์โหลด DB, media URL, script, credential หรือวิดีโอลูกค้า

ทั้งสอง ticket มีภาพแนบ (JPEG/PNG) แต่ **ไม่ได้เปิดภาพในรอบนี้**: รักษาขอบเขตไม่คัดลอกสื่อลูกค้าออกจาก host และ host ไม่มี OCR ที่มีอยู่ให้ใช้ ไม่ได้ติดตั้งเครื่องมือเพิ่ม ภาพใบเก่ามีผลอ่านจาก audit เดิมใน HERO-45; ไม่อ้างว่าตรวจภาพนั้นซ้ำ ภาพใบใหม่และ browser ของลูกค้ายังไม่ถูกยืนยันโดยตรง จึงแยกข้อเท็จจริงจากโค้ดออกจากการอนุมานหน้าจอลูกค้า

ไม่มีการ reproduce ด้วยบัญชีลูกค้า, paid generation, replay, provider call, restart หรือ deploy และไม่ได้ตรวจ Sentry ใหม่ทั้งระบบ เพราะ ticket ใหม่ไม่มี error claim และ ticket เก่ามี canonical พร้อม durable outcome ตรงอาการแล้ว ไม่รัน build/test suite เพื่อสร้างภาพว่าพิสูจน์ UI session หรือคุณภาพวิดีโอแล้ว

หลักฐานส่วนตัวอยู่ที่ `~/.codex/artifacts/hero-support-open-audit-20260924/` เฉพาะผล audit นี้: `tickets.jsonl`, `outcomes.jsonl`, `avatar-recovery.jsonl`, `correlation.jsonl`, `linear-inventory.json` รายงานที่แชร์ไม่ใส่ข้อความลูกค้าเต็ม ภาพ media identifiers, account identity, keys หรือ payload

## การดำเนินการที่เสนอ

1. ตอบใบใหม่ด้วยคำแนะนำหน้าปัจจุบัน และพิจารณาแยก feature request ขยายแผงเข้า Backlog
2. ใช้ร่างติดตามผลใหม่กับใบ HeyGen; มีหลักฐานฟื้นแล้ว ไม่ควรส่งคำแนะนำกู้ระบบแบบเดิมโดยอัตโนมัติ
3. หากสั่ง sync จึงค่อยบันทึก disposition/link ลง ticket และ Linear ตามขอบเขต หากสั่งส่ง/ปิด ให้ยึด ticket ID และข้อความที่อนุมัติ ไม่เปลี่ยนสถานะจาก audit นี้

**สิ่งที่เปลี่ยน:** สร้างรายงาน local เท่านั้น ไม่มี production record, Linear state, Sentry state หรือ customer notification เปลี่ยน ไม่มี permission question ค้างสำหรับการอ่านรายงาน
