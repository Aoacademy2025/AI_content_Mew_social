# Audit: 9 Support-Ticket Branches — 2026-07-26

> Read-only audit (no code changed, no merges, no deploys). Auditors: 12 parallel agents
> (9 branch auditors, integration analyst, prod/ticket checker via read-only SSH, build/test runner).
> Base: `main` = `b968afc91` (local = origin). Prod = `8fcdce9` (1 docs-only commit behind — no code drift).
> Scope exclusion: all Hero AI Voice work. Brand "HERO AI Creator Studio" checks in scope.

## A. Executive Summary

**Final recommendation: READY WITH MUST-FIXES** — ห้าม merge ทั้งชุดตามสภาพปัจจุบัน แต่ไม่มีอะไรพังเชิงสถาปัตยกรรม
ทุก branch: tsc 0 error ใหม่, production build ผ่าน (broll+fade = คู่ที่แตะ render backend), verify scripts ที่รันได้ผ่านหมด,
security/authz/billing invariants ผ่านทุกจุดที่ตรวจ (ไม่มี IDOR, ไม่มี double-charge, ไม่มี quota bypass)

**Findings: Critical 0 · High 8 · Medium ~18 · Low ~22**

ความเสี่ยงหลัก 5 ข้อ:
1. **Upload-cutaway (คนแจ้งตั๋วตัวจริง) โดนหนักสุด** — broll F1 (สั่งเปิด b-roll ครบ → ได้คลิปคนพูดเต็มจอ ตรงข้ามคำสั่ง), F2/F3 (โปรเจ็กต์เก่าถูกเดา personRanges ใหม่ → ช่วงคนพูด/b-roll สลับผิดทั้งคลิป แม้แค่เปลี่ยนคลิป 1 จุด)
2. **ปุ่ม Undo บน Timeline ตายสนิท** (history F-1 regression) + การ์ดว่าง burn ลงไฟล์ที่ลูกค้าจ่ายเงิน (F-2)
3. **Stale-client fix เป็นกับดักใหม่** (support-fixes F1: legacy replay คืน job failed ตลอด) และข้อความ "กรุณารีเฟรช" เป็น dead payload (F2)
4. **WYSIWYG แตก 2 จุด** — avatar fade มีเฉพาะ export ไม่มีใน preview (fade High) และ layer-toggle × AvatarAdjustOverlay หลัง merge (integration B-1)
5. **Scope gap** — layer toggles ไม่มี B-roll/Background เลยทั้ง data model (2 ตั๋วยังปิดไม่ได้) และ preset logo เก็บ `enabled` ติดมาทับ layer toggle (B-3)

## B. Branch/Ticket Matrix

| # | Branch (tip) | Tickets | สถานะ | ประเด็นหลัก | North Star |
|---|---|---|---|---|---|
| 1 | support-fixes (f15d320) | o2ex0kjl ✅ · dk1omoz6 ⚠️ | **PARTIAL** | merge-space fix ถูกหลักภาษาไทย (verify 16 เคส); แต่ F1 legacy replay คืน job terminal → stale client ติดตาย, F2 warning เป็น dead payload, harness แดงบน main อยู่แล้วและไม่ผูก CI | ปิดตั๋ว merge จริง; ถ้าไม่แก้ F1 จะเกิดตั๋วตระกูล "กดแล้วไม่เกิดอะไร" แทน |
| 2 | ux-subtitle-waveform-adjacency (6a18e5a) | bx0y9tgp ✅ | **PASS** | pure JSX reorder, waveform ติดแถวซับจริง, ไม่มี perf regression (peaks cache คงที่ 1400 buckets); Low: tooltip Snap แคบกว่าพฤติกรรม, test เป็น regex-on-source; desktop-only (mobile ไม่มี timeline by design) | ลดเวลาจัดเวลาซับตรง ๆ ต้นทุนต่ำ |
| 3 | ux-timeline-wheel-scroll (3f5cf15) | 3v1uuynx ✅ | **PARTIAL** | logic แน่น (clamp/deltaMode/ctrl-guard, non-passive listener จำเป็นจริงบน React 19); Medium: wheel ระหว่างลากขอบซับไม่มี guard → ขอบเพี้ยน; verify ไม่ผูก package.json | QoL เล็กแต่ใช้ทุกวัน |
| 4 | subtitle-logo-presets (104047e) | tjn6iq90 ✅* | **PARTIAL** | security สะอาดมาก (no IDOR, allowlist ปิดสนิท, schema additive ปลอดภัยกับ `prisma db push`); M1 apply ไม่ล้าง per-card overrides → พรีเซ็ต "ไม่ติด" เงียบ ๆ, M2 apply logo no-op แต่ toast สำเร็จ | switching-cost/retention ตรง ๆ สำหรับ creator ปล่อยรายวัน |
| 5 | editor-layer-visibility-toggles (ecc56d4) | 55l146ri ✅ · 8s417oeb ⚠️ · 21xo844t ⚠️ · 0hwfuq6b ⚠️(2/3) · bghxue2g ❌ | **PARTIAL** | avatar/subtitle/logo ทำดี: non-destructive จริง, preview=export จริง (export สลับไป compositeBaseUrl), backward-compat ครบ; **B-roll + Background ไม่มีเลยทั้ง type/UI** | ถ้าครบ 5 เลเยอร์ = ตัวลด render เสียเปล่าอันดับต้น |
| 6 | subtitle-card-history (82dc796) | 0duj423u ⚠️ · t82hs8s4 ⚠️ | **PARTIAL** | lib undo/redo ถูกต้อง 100% (พิสูจน์ด้วย probe); F-1 High ปุ่ม Undo ที่ Timeline ตาย (`onUndo={ed.undoCaptions}` รับ React event เป็น expectedEntryId), F-2 การ์ดว่าง burn เป็นกล่องเปล่า, F-3 mobile auto-follow ตายหลังเพิ่มกล่อง, F-4 เพิ่มการ์ดใช้ไม่ได้ในโหมด 1 คำ (การ์ด <600ms ถูกปฏิเสธหมด) | "พลาดแล้วย้อนได้" = ความมั่นใจ export ตรง ๆ |
| 7 | broll-window-management-all-avatars (d675942) | 7xn0txwq ✅* · eat1j22i ✅* · jre4p9an ⚠️ · bghxue2g ⚠️ | **PARTIAL** | ปลด gate 3 ชั้นถูกจุด + cutaway re-composite จริง; F1 personRanges ว่าง → fail-open overlay คนทั้งคลิป, F2/F3 legacy reconstruct จาก sourceIndex ที่ซ้ำได้ → layout เพี้ยน, F4 AI credit spend บน window ที่ปิด; billing ตรวจละเอียดแล้วไม่ double-charge; "ลบ"=ซ่อน, "ย้าย"=สลับ ±1 เท่านั้น, ปิดทั้งคลิปไม่มี (cap 40 edits) | แก้ pain ตัวจริงของกลุ่ม uploaded-avatar — ถ้า F1-F3 หลุดไป จะทำลายความเชื่อใจกลุ่มเดียวกันนั้น |
| 8 | logo-first-upload-auto-enable (ab84b43) | inq6lhhd ✅ | **PASS** | auto-enable มีใน base อยู่แล้ว (`useLogoOverlayEditor.ts:519`); งานจริงของ branch = แก้หน้า "ปรับอวตาร" ไม่วาดโลโก้ (ครบ desktop/mobile, contract check 36/36); ชื่อ branch/PR ควรแก้ให้ตรง | ปิด perception "โลโก้หาย" |
| 9 | avatar-fade-in-out (9fc6a1f) | nfthchwp ⚠️ | **PARTIAL** | filter ออกแบบถูก (fade หลัง key — เลี่ยง key ไม่ติด; verify เช็ค pixel จริง); High: fade เฉพาะ export — preview ไม่ fade + timeline วาด gradient "สัญญา" ที่ preview ไม่แสดง; Medium: blend เต็มความยาวแม้ช่วงถูกทิ้ง (legacy bookend), rembg ต้อง encode ซ้ำเต็มรอบ; cutaway ไม่ fade แต่ได้ tooltip (B-9); mobile ไม่มี hint | ตั๋วขอ "ทรานสิชั่น" — ได้ แต่ WYSIWYG ต้องเคาะก่อนปิดตั๋ว; complexity/value ก้ำกึ่ง ควรวัด ffmpeg cost จริงก่อนเรียกว่าฟรี |

*✅\* = covered เมื่อแก้ must-fix ของ branch นั้นแล้ว*

Tickets นอกชุด: End Scene (`xe8s7dih`) = งานถัดไปตามที่ระบุ · ปุ่มฮีโร่ editor เก่า (`040hzk0o`) + Hero Voice quality ×2 = อยู่ในข้อยกเว้น Hero AI Voice

## C. Findings (เรียงความรุนแรง)

### High — Must-fix ทั้งหมด

| ID | Branch | อาการ | หลักฐาน | แนวทางแก้ |
|---|---|---|---|---|
| H1 | broll | upload-cutaway เปิด b-roll ครบทุก window → `personRanges=[]` → composite fail-open overlay คนทั้งคลิป (ตรงข้ามคำสั่ง) | `orchestrator.ts:788-812` · `composite/route.ts:163-166` | `[]` → ข้าม composite (`rrFinalUrl=rrNewBase`); ทำ cutaway ใน composite route ให้ fail-closed 400 เมื่อ ranges ว่าง |
| H2 | broll | legacy cutaway (ทุกโปรเจ็กต์ก่อน branch นี้) reconstruct personRanges จาก `sourceIndex` ที่ nearest-fallback ทำให้ซ้ำได้ → person/b-roll สลับผิดทั้งคลิป | `cutaway-plan.ts:100-131` · `broll-coverage.ts:664-676` | reconstruct deterministic: `buildBrollWindows + planCutaway` สูตรเดียวกับตอนสร้าง แล้ว apply `brollEnabled` ทับ |
| H3 | broll | ต่อยอด H2: แค่ "เปลี่ยนคลิป" โดยไม่แตะ toggle ก็เข้าสูตรเดา → layout เปลี่ยน (คือ scenario ตั๋ว eat1j22i ตรง ๆ) | `orchestrator.ts:783-812` | แก้พร้อม H2 |
| H4 | history | ปุ่ม "เลิกทำ" บน Timeline ตาย + toast หลอก — `onUndo={ed.undoCaptions}` ส่ง React event เข้า `expectedEntryId` | `PostPhase.tsx:698` · `TimelinePanel.tsx:192` | ห่อ `() => ed.undoCaptions()` + guard `typeof !== "number"` ในฟังก์ชันเอง |
| H5 | support-fixes | legacy replay คืน job `failed/canceled/done` → stale client กดซ้ำ config เดิมได้ job พังตัวเดิมตลอด | `jobs/route.ts:98-107` · `video-job-idempotency.ts:51-55` · `usePostPhaseEditor.ts:147-170` | legacy mode replay เฉพาะ in-flight statuses (หรือ createdAt ≤ ~10 นาที) + รับมือ P2002 |
| H6 | support-fixes | `warning`/`reloadRecommended` เป็น dead payload — bundle ก่อน 07-16 ไม่มีโค้ดอ่าน (`git show ba94913^` ยืนยัน grep=0) | `EditorV2Shell.tsx:141` (ตัวอ่านอยู่ bundle ใหม่) | ยอมรับว่าเงียบแล้วพึ่ง H5 (แนะนำ) หรือใช้ช่องที่ bundle เก่าอ่านได้ (`message` ใน 4xx) |
| H7 | fade | fade เฉพาะ export — preview (preview-bg/preview-frame ใช้ `buildKeyChain` ไม่ผ่าน `buildCompositeFilter`) ไม่ fade → WYSIWYG แตก + timeline gradient สัญญาเกินจริง | `chroma-key.ts:304` · `composite/route.ts:234,520` · grep `buildCompositeFilter(` = 0 preview call sites | เคาะ: ใส่ fade ใน preview (CSS opacity บน overlay `<video>` ของ preview-bg = ถูกสุด) หรือประกาศ export-only + แก้ copy/indicator |
| H8 | layers | B-roll + Background layer ไม่มีการ implement เลย (type `EditorLayerVisibility` ไม่มีช่อง) — ตั๋ว bghxue2g ❌, 0hwfuq6b ได้ 2/3 | `src/lib/editor-layer-visibility.ts` (type = avatar/subtitles เท่านั้น +logo hack) | เคาะ scope: เพิ่มใน branch นี้ หรือแยกตั๋ว; ห้ามปิด 2 ตั๋วนั้นก่อนมีของ; นิยาม "background" ต้องยืนยันกับผู้แจ้ง (น่าจะ = b-roll base) |

### Medium (คัดตัว must-fix / ต้องตัดสินใจ)

| ID | Branch | เรื่อง | สถานะ |
|---|---|---|---|
| M1 | presets | apply subtitle preset ไม่ล้าง per-card overrides → พรีเซ็ตไม่ติดเงียบ ๆ (`useEditorStylePresets.ts:100-105` เทียบ pattern `applyCardLen` ที่ล้าง) | **Must-fix** |
| M2 | presets | apply logo preset ตอน project ไม่ ready = no-op แต่ toast สำเร็จ (`useV2Project.ts:137-141` return เงียบ) | **Must-fix** |
| M3 | broll | กดเจน AI Image (หักเครดิตจริง) บน window ที่ปิดอยู่ → เงินหาย ผลศูนย์ (`BrollWindowInspector.tsx:397-420`, generate route หัก `spendCredits` ก่อน) | **Must-fix (แตะเงิน)** |
| M4 | history | mobile กด "เพิ่มกล่อง" 1 ครั้ง → `editingIdx` ไม่ถูกล้าง (PostPhaseMobile ไม่อ้างถึงเลย) → auto-follow ตายถาวร | **Must-fix** |
| M5 | history | เพิ่มการ์ดใช้ไม่ได้ในโหมดซับไวรัล 1 คำ (MIN 300ms×2 ต่อการ์ด <600ms) — โหมดหลักของกลุ่มเป้าหมาย; ปุ่มไม่เคย disabled | **Must-fix ก่อนโฆษณาฟีเจอร์** |
| M6 | history | การ์ดว่าง (`text:""`) burn เป็นกล่องเปล่าใน preset ตระกูล box — ไม่มีชั้นกรอง (`renderSubtitle.tsx:389+`) | **Must-fix** (จัด High-boundary) |
| M7 | wheel | wheel ระหว่างลากขอบซับ/scrub ไม่ guard → ขอบเพี้ยน — แก้ 1 บรรทัด (`if (dragRef.current || scrubbingRef.current) return`) | แนะนำทำก่อน merge |
| M8 | integration B-1 | หลัง merge 5+8: ปิดเลเยอร์โลโก้แล้วหน้า "ปรับอวตาร" ยังโชว์โลโก้ (`AvatarAdjustOverlay.tsx:274` ไม่ส่ง `visible`) | **Must-fix ตอน integration** |
| M9 | integration B-3 | logo preset เก็บ `enabled` → apply ทับ layer toggle + bypass telemetry/guard; subtitle preset ไม่เก็บ visibility (asymmetric) | **ต้องเคาะ**: แนะนำ strip `enabled` ออกจาก preset แล้วเคารพ toggle |
| M10 | integration B-9 | cutaway ได้ tooltip/gradient "เฟดอัตโนมัติ" แต่ `cutawayComposite` ไม่รับ fade → Timeline โกหก | **Must-fix ตอน integration** (จำกัด indicator เฉพาะ mode ที่ fade จริง) |
| M11 | integration B-5 | b-roll ไม่มีปุ่มตาบน timeline ขณะ avatar/sub/logo มี → ผู้ใช้หา; per-window (7) กับ layer (5) เป็นคนละชั้น (client-toggle vs ต้อง re-render) | เคาะ UX ตอน integration |
| M12 | support-fixes | tests: legacy replay ทดสอบเฉพาะ processing + mock ทำ assert vacuous (`f(x)===f(x)`); harness+verify ไม่ผูก package.json/CI — **และ harness แดงบน main อยู่แล้ว** (build runner ยืนยัน: `verify-editor-project-recovery-hook.ts` fail ทั้ง main และ branch — unhandled mock import) | **Must-fix wiring ก่อน merge** |
| M13 | integration B-12 | `layerVisibility` เข้า autosave deps → กดปุ่มตา = bump revision + เข้า recovery lineage | ตรวจว่าไม่ trigger recovery prompt เกินจำเป็น |
| M14 | fade | blend เต็ม canvas เต็ม duration แม้ opacity คงที่ + legacy bookend composite เต็มคลิปแล้วค่อย trim (ทบของเดิม) | Can-defer — วัดจริงก่อน |
| M15 | fade | rembg mode จ่าย encode pass ที่สองเต็มรอบเพื่อ fade | Can-defer (trade-off ที่เข้าใจได้ ควร document) |
| M16-18 | presets M3-M5 | ชื่อซ้ำทับเงียบ / ลบ preset แล้ว asset ค้าง (≤100MB/user) / preset ที่ asset หายถูกซ่อนเงียบ | Can-defer |
| M19-20 | broll F5-F7 | keyword ค้างหลังเปลี่ยน upload/AI · `brollEnabled true vs undefined` หั่น segment เกิน · ไม่มี client cap 40 edits | Can-defer |

### Low (คัดสำคัญ)
- waveform: tooltip Snap แคบกว่าพฤติกรรม; tests เป็น regex-on-source (เปราะ) — เช่นเดียวกับ verify ของ layers/broll-window-mgmt/logo (pattern ทั้ง repo)
- wheel: ไม่มี keyboard alternative (pre-existing); verify ไม่ผูก package.json
- logo: LogoOverlayPreview z-index ทับกล่องลากอวตารได้ (ภาพเท่านั้น); ชื่อ branch/PR ทำให้เข้าใจผิด
- presets: L1-L8 (disabled hint อ่านไม่ได้ด้วย SR, ลิสต์ไม่มี max-height บน mobile sheet, no retry, restore ไม่มี busy guard, `<style>` ซ้ำ per instance, hardcode violet ควรมาจาก token ฯลฯ)
- history: history ท่วมจาก nudge (cap 50) กลืน entry ลบ; สี "ทั้งคลิป" ไม่เข้า history แต่ "การ์ดนี้" เข้า (ไม่สมมาตร); keydown effect closure เปราะ; mobile setBoundary overlap ได้ (pre-existing — เปิดตั๋วแยก); captions ไม่อยู่ใน draft → refresh หายหมดโดยไม่มีคำเตือน (pre-existing แต่ history ทำให้คาดหวังสูงขึ้น)
- broll: swap ล้มเงียบเมื่อ asset ไม่ internal; "พื้นหลังเรียบ" = จอดำสนิท (copy ไม่ตรง); avatar track ยังวาดเต็มความยาวใน cutaway ทั้งที่มี ranges จริงในมือ; Toggle 40×23px ต่ำกว่า WCAG 2.5.8 (ปัญหา design system เดิม)
- support-fixes: space ที่ผู้ใช้ตั้งใจพิมพ์ระหว่างการ์ดไทยหาย (trade-off — บันทึกไว้); ZWSP edge; user-typed text ไม่ normalize ตอน export; 400 message ไม่แยกเหตุ; ไม่กัน reserved prefix `legacy-v1:` (self-DoS เท่านั้น)

## D. Integration Conflict Map

**Git (11/36 คู่ conflict):** สะอาดทุกคู่: support-fixes(1), logo(8) · trivial: import/prop unions ใน TimelinePanel (3×5, 3×6, 3×9, 2×6), package.json (4/5/6 บรรทัดเดียวกัน — เก็บทั้งสามบรรทัด), usePostPhaseEditor return (4×5, 4×7 — union keys ไม่มีชื่อซ้ำ) · moderate: 2×5 (waveform ย้าย + สูตร height/LABEL_W ของ 5 — **ต้องใช้สูตรของ 5**), 4×5 (PostPhaseMobile), 5×6, 5×7 · **heavy: 5×9** avatar track block เดียวกัน (fade gradient + layer dim + trackLabel ใหม่)

**Semantic (git มองไม่เห็น):** B-1 logo visible ใน AvatarAdjustOverlay (M8) · B-3 preset `enabled` ทับ toggle (M9) · B-5 b-roll ไม่มีปุ่มตา + คนละชั้น persistence (M11) · B-7 layer toggle ไม่เข้า undo stack → Ctrl+Z undo ซับแทน (ควร toast บน toggle เอง ไม่ต้องเข้า stack) · B-9 cutaway fade tooltip โกหก (M10) · B-12 autosave revision bump (M13) · B-13 fade ไม่มี hint บน mobile · B-6 ✅ history×merge-fix ทำงานร่วมถูก (merge นิยามที่เดียว, undo merge ได้) · B-10 ✅ idempotency fingerprint ครอบ field ใหม่ของ 7 อัตโนมัติ · B-11 ✅ billing: export จาก compositeBaseUrl ยังฟรี (ChargedClip มีอยู่แล้ว)

**Schema/state:** prisma additive ล้วน (`EditorStylePreset` + virtual relations) → `deploy.sh` `db push` ปลอดภัย · V2Draft ได้ field ใหม่ตัวเดียว (`layerVisibility`, fail-open default) · job preview ได้ `cutawayPersonRanges` + `bgVideos[].brollEnabled` (optional, tri-state) · MCP input whitelist ไม่รับ field ใหม่ → client เก่าไม่กระทบ

**Backward compat:** ตรวจครบ 7 จุด (draft เก่า, payload เก่า, งานไม่มี compositeBaseUrl, client ไม่ส่ง idempotencyKey ฯลฯ) — default ปลอดภัยหมด ไม่มี migration blocker

## E. Recommended Merge Order

ลำดับ (แก้ must-fix ของแต่ละ branch **ก่อน merge ตัวนั้น**):

1. **support-fixes** (แก้ H5/H6/M12 ก่อน) — ไม่ชนใคร, เป็นฐานที่ history พึ่ง → retest: verify:subtitle-invariant + harness + smoke merge การ์ดไทย
2. **logo** — ไม่ชนใคร → retest: verify:logo-client-contract + เปิดจอปรับอวตารเห็นโลโก้
3. **fade** (เคาะ H7/M10 ก่อน) → retest: verify-avatar-fade + เรนเดอร์จริง 1 คลิป bookend-both
4. **waveform** → retest: verify:waveform-snap + ตาดู adjacency
5. **broll** (แก้ H1-H3/M3 ก่อน) — แตะ backend กว้างสุด ควร land ตอน tree นิ่ง → retest: 4 verify + e2e upload-cutaway ปิด 1 window
6. **wheel** (แก้ M7) — manual: TimelinePanel imports (union) → retest: verify + ล้อเมาส์
7. **presets** (แก้ M1/M2) — manual: usePostPhaseEditor return → retest: verify:editor-style-presets + db push บน dev
8. **history** (แก้ H4/M4/M5/M6) — manual ×3: transport bar, lucide import, package.json → retest: verify:caption-card-editing + regression "รวมการ์ด → Ctrl+Z คืนข้อความ+สี"
9. **layers** (เคาะ H8 ก่อน) — หนักสุด (ชน 8 ราย): TimelinePanel avatar track (ซ้อน fade gradient + opacity dim), สูตร height ใช้ของ 5, PostPhaseMobile, usePostPhaseEditor, package.json → retest: verify ทั้งชุด + build
10. **Integration commit (บังคับ):** M8 (visible prop) + M9 (strip enabled) + M10 (fade indicator เฉพาะ mode จริง) + M11 (ปุ่มตา b-roll หรือ copy) + B-13 (mobile fade hint) → full build + verify ทุกตัว + QA จริง

เหตุผลหลัก: 1,8 ไม่ชนใคร · 8 ก่อน 5 เพื่อให้คน resolve 5 เห็น LogoOverlayPreview แล้วเติม visible ได้ · 7 ก่อน 4/5 (backend กว้าง + ให้ 5 เห็น b-roll UI ก่อนเคาะปุ่มตา) · 5 ท้ายสุดเพราะ degree สูงสุด — resolve ก้อนเดียวจบ

## F. Combined QA Checklist (หลังรวมทุก branch)

**Matrix บังคับ: Desktop + Mobile × No-Avatar / HeyGen / Uploaded-Avatar × Full / Intro / Intro+Outro**

- [ ] B-roll: ปิด/เปิดราย window (ทั้ง 3 avatar cases) · ลบ (ดูว่าช่วงนั้นแสดงอะไร — no-avatar = จอดำ ต้องรับได้/แก้ copy) · ย้าย (สลับ ±1) · เปลี่ยน (stock/upload/AI) · **cutaway: เปิด b-roll ครบทุก window ต้องไม่ได้คลิปคนเต็มจอ (H1)** · legacy cutaway โปรเจ็กต์เก่า: เปลี่ยนคลิป 1 จุดแล้ว person ranges ต้องไม่ขยับ (H2/H3) · AI generate บน window ปิดต้องถูก block (M3)
- [ ] Subtitle: เพิ่ม (โหมด 1 ประโยค / ≤4 คำ / **1 คำ** / playhead=0 / ตรงขอบการ์ด) · ลบ · รวม (ไทย+ไทย ไม่มีช่องว่าง, ว่าง+ข้อความ ไม่มี leading space) · Undo/Redo จาก **ทุกปุ่ม** (คอลัมน์ซ้าย + Timeline + Ctrl+Z) · การ์ดว่างต้องไม่หลุดไป export
- [ ] Layer toggles: ปิด/เปิด avatar+subtitle+logo → ข้อมูลไม่หาย, reload คงสถานะ, **export ต้องตัดตาม** (ดูไฟล์จริง) · งานเก่าไม่มี compositeBaseUrl → ปุ่มตา avatar disabled · ปิดโลโก้แล้วหน้า "ปรับอวตาร" ต้องไม่โชว์ (M8)
- [ ] Preset: save/apply/delete/undo-delete ทั้ง subtitle+logo, desktop+mobile · apply ต้องล้าง per-card overrides (M1) · apply ตอนเพิ่งเปิดโปรเจ็กต์ ต้องไม่ toast โกหก (M2) · apply preset ต้องเคารพ layer toggle (M9) · ชื่อซ้ำ = อัปเดต (สื่อสารชัด)
- [ ] Logo: อัปโหลดครั้งแรก → เห็นทันทีทั้ง preview หลัก + จอปรับอวตาร · อัปโหลดทับตอน toggle ปิด → ต้องยังปิด
- [ ] Wheel: เลื่อน timeline, ctrl+wheel = browser zoom, shift+wheel, Firefox deltaMode, **หมุนระหว่างลากขอบซับต้องไม่เพี้ยน (M7)**, mobile touch scroll ไม่ regress
- [ ] Waveform: ติดแถวซับ, ไม่เบียดแทร็กโลโก้ (สูตร height ของ 5), snap ยังทำงานเมื่อ decode fail
- [ ] Avatar fade: full/bookend/bookend-both เฟดหัว-ท้ายถูกตำแหน่ง, คลิปสั้นกว่า fade duration, **preview vs export ตรงตามที่เคาะใน H7**, cutaway ต้องไม่มี indicator ถ้าไม่ fade (M10), เสียงไม่ pop
- [ ] Autosave/Reload: layerVisibility คงอยู่ · แก้ซับแล้วรีเฟรช (พฤติกรรมปัจจุบัน: หาย — ยืนยันว่ายอมรับ/มีคำเตือน) · recovery prompt ไม่เด้งเกินจาก toggle (M13)
- [ ] Preview/Export: 1 คลิปต่อ avatar case เทียบเฟรมต่อเฟรม (ซับ/โลโก้/b-roll/fade)
- [ ] Billing: FREE โดน cap เดิม · re-render b-roll ฟรี (ไม่มี ChargedClip ใหม่) · burn หลังปิด avatar ฟรี (compositeBaseUrl จ่ายแล้ว) · cancel กลางทาง refund เดิมไม่แตก · MCP path เดิม byte-identical
- [ ] Regression เดิม: scrub/drag playhead, avatar adjust ฟรี re-composite, viral card mode, MCP clients เก่า

## G. Final Recommendation

**READY WITH MUST-FIXES** — ห้าม merge/deploy ตามสภาพปัจจุบัน จนกว่า:
- High H1-H8 ถูกแก้/เคาะครบ (H6, H7, H8 เป็น decision + fix)
- Medium must-fix: M1-M6, M12 + integration M8-M10
- ทำ Integration commit ตามข้อ E-10 แล้วรัน combined QA (ข้อ F)

Branch ที่ merge ได้ทันทีโดยไม่ต้องแก้: **waveform (2), logo (8)** — ที่เหลือ Ready-after-fix ทั้งหมด, ไม่มี branch ไหน NOT READY เชิงสถาปัตยกรรม (ต้อง re-design)

**งานถัดไป (นอกขอบเขต audit นี้):** End Scene (`xe8s7dih`) · b-roll/background global toggle (จาก H8) · keyboard a11y ของ timeline · เปลี่ยน verify pattern regex-on-source → DOM/integration tests

---
*Audit artifacts: worktrees ที่ `/private/tmp/claude-501/.../scratchpad/audit/` (ลบได้ด้วย `git worktree remove <path>` ×10 + `git worktree prune`)*
