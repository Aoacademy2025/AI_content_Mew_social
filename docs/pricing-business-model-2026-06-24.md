# Pricing & Business-Model Rework — Locked Decisions

- **Date:** 2026-06-24
- **Author:** Mew (+ Claude), via `/grill-with-docs` session
- **Status:** Direction LOCKED (Q1–Q8). Numbers marked **[verify]** to re-check before launch; **[open]** = not yet decided.
- **FX used:** ~35 ฿/$ · **Pairs with:** [`scale-upgrade-plan.md`](scale-upgrade-plan.md)

## 0. Why we're changing the model (the data)

- **Activation = 10%** — 309 สมัคร → 32 ได้วิดีโอแรก. ตัวบล็อกหลัก = **Gemini key/billing wall**: Gemini API เปลี่ยนเป็น **prepaid (ตั้งแต่ 2026-03-23)** — ผูกบัตรไม่พอ ต้องเติม **ขั้นต่ำ $10 (~400฿)** ก่อน + เสียงเรา (Gemini TTS) เป็น paid-tier preview → คน 69% ของ paid ไม่มี key/ไม่เติม → เจนไม่ได้.
- **แต่ retention แข็งแรง: 66%** ของคนที่ได้วิดีโอ 1 ตัว กลับมาทำ ≥2.
- **เป้าหมาย = GROWTH** → ลบกำแพง first-success ให้คนถึงตัวแรก แล้ว 66% retention จะทำงาน.

**กลยุทธ์ใหม่ 2 เครื่องยนต์:**
- **Subscription** = เครื่องยนต์ growth (friction ต่ำ, ราคาคนไทยจ่ายไหว)
- **Credits** = เครื่องยนต์ margin (จ่ายเพิ่มเมื่อใช้เยอะ / เจน AI)

---

## 1. Core architecture (Q1–Q3)

| # | Decision |
|---|---|
| **Q1** | **แกนหลักรวมในแพ็ก** = สคริปต์ + เสียงไทย (Gemini server) + ซับ + **b-roll สต็อก (Pexels/Pixabay ฟรี)**. คุณภาพดีพอสร้าง first-success. **เครดิต = เฉพาะภาพ/วิดีโอ AI-gen** (ความหลากหลายเพิ่ม). ไม่ซื้อก็ใช้ได้เต็ม. |
| **Q2** | **Managed default** (server Gemini key, จำกัดตามแพ็ก). **Overflow = ซื้อเครดิตนาที** (ไม่ใช่ BYOK). **BYOK = option ซ่อนสำหรับ "ปลาวาฬ"** (เจนเยอะมาก อยากใช้บิล Google เอง). |
| **Q3** | **เสียงมาตรฐาน = Gemini 2.5 Flash TTS (server)**. **เสียงโคลน = ElevenLabs (BYOK)** — แพงกว่า ~10-15× ห้ามดูดเข้า base. เสียงพรีเมียม (Pro TTS/Kumram) = upsell อนาคต. |

---

## 2. Tiers, prices, quotas (Q5–Q6) — ราคาจริงจาก Stripe (verified)

**Meter = นาที/เดือน** (= หน่วยต้นทุนจริง) · **display = "~X คลิป ถ้า ~1 นาที"** · คงเพดานความยาว/คลิป (นิยาม short-form)

> **Rounding (evolved 2026-06-26):** minutes are rounded to the NEAREST whole minute (min 1), one rule everywhere — NOT ceil. Rationale: a 1:05 clip charging 2 minutes felt punitive on the real-money overflow path; nearest is statistically fair and stays integer-credit. (Supersedes the earlier "ceil to whole minute".)

| Tier | นาที/เดือน | max/คลิป | รายเดือน | รายปี (ปกติ) | **Founder annual (−50%, 100 คนแรก)** |
|---|---|---|---|---|---|
| **Free** | 3–5 คลิป (watermark) | 1–2 นาที | ฿0 | — | — |
| **PRO** | **80 นาที** | 3 นาที | ฿599 | ฿5,990/ปี (฿499/ด) | **฿2,995/ปี (฿250/ด)** |
| **BUSINESS** | **150 นาที** | 6 นาที | ฿990 | ฿9,900/ปี (฿825/ด) | **฿4,950/ปี (฿413/ด)** |

- รายปีปกติ = "จ่าย 10 เดือน ได้ 12" (~17% off) · Founder ทับอีก −50%
- **ราคาต่ำสุดที่เก็บจริง (margin floor) = Founder annual** → ใช้คิด margin
- คง **3 tier** (ความหลากหลายไปอยู่ที่เครดิต ไม่เพิ่ม tier)

### Free tier & Trial (Q4)
- **Free:** 3–5 คลิปเต็มฟีเจอร์/เดือน (server Gemini + สต็อก) + **watermark** (= growth loop) ≤1–2 นาที. กันโกง: verify อีเมล/มือถือ + cap/บัญชี.
- **Trial = capped reverse-trial:** 7 วัน PRO เต็ม (ไม่มี watermark) **cap ~10–15 คลิป**, ไม่ต้องใส่บัตร, หมดแล้วลดเป็น Free อัตโนมัติ. (บังคับบัตร = lever ทดสอบทีหลัง.)

---

## 3. Credit system (Q7–Q8)

**สกุลเดียวรวม · 1 credit = ฿1** · ใช้ได้กับ: นาทีเจนเพิ่ม / รูป AI / วิดีโอ AI

### Markup: core ×2 (utility), premium ×3 (AI-gen)

| Action | COGS | **เครดิต** | margin |
|---|---|---|---|
| นาทีเจนเพิ่ม (overflow) | ฿0.7 | **2 cr** | ~60% |
| รูป AI — **gpt image 2 (1K)** ⭐budget | ฿1.05 | **3 cr** | ~65% |
| รูป AI — Nano Banana 2 (1K) | ฿1.4 | **4 cr** | ~65% |
| รูป AI — gpt image 2 (2K) | ฿1.75 | **5 cr** | ~65% |
| รูป AI — Nano Banana 2 (2K) | ฿2.1 | **6 cr** | ~65% |
| วิดีโอ AI — Seedance 1.5 pro 5วิ (720p, no-audio) | ฿3.06 | **10 cr** | ~69% |

- **รูป:** gpt image 2 = budget/default (ถูกสุด) · Nano Banana 2 = quality. ทั้งคู่ผ่าน kie.ai
- **วิดีโอ:** Seedance 1.5 pro (ByteDance ผ่าน kie) — เจนบนเซิร์ฟเวอร์ kie (external) ไม่โหลด VPS เรา; render เราแค่ "เย็บ" เหมือน b-roll สต็อกวิดีโอเดิม

### Credit packs (โบนัสยอดใหญ่ดันซื้อก้อนโต)
| Pack | จ่าย | ได้ | โบนัส |
|---|---|---|---|
| Starter | ฿199 | 200 cr | — |
| Popular | ฿499 | 540 cr | +8% |
| Pro | ฿999 | 1,150 cr | +15% |

`฿199 (200cr) = ~100 นาที overflow / ~50–66 รูป AI / ~20 วิดีโอ AI`

### เครดิตแถม + กฎ reset
| ประเภท | จำนวน | reset |
|---|---|---|
| **แถมรายเดือน** (มากับซับ) | PRO **50 cr** · BUSINESS **150 cr** | **reset ทุกเดือน** (use-it-or-lose-it) — perk รายเดือน + คุมต้นทุน |
| **ซื้อเติมเอง** | ตาม pack | **ยกยอด** (หมดอายุ ~12 เดือน) — จ่ายเงินสด = ของเขา |

---

## 4. Cost model (verified) — Variable + Fixed

### Variable (ต่อนาทีวิดีโอ) — AI อย่างเดียว
- **Gemini 2.5 Flash TTS** = $10/1M audio out, **25 tokens/วินาที** = **$0.015/นาที = $0.90/ชม.** [verified Google pricing] **[verify: preview model ราคา/ความพร้อมเปลี่ยนได้]**
- + text passes (script/keyword/split, 2.5 Flash $0.30/$2.50) ~$0.003/นาที
- **รวม ≈ $0.02/นาที ≈ ฿0.7/นาที** (per-minute variable จริง)

### Fixed infra (ตามแผน 2 กล่อง)
- web box (เล็ก) ~฿600 + **worker box 8 vCPU ~฿2,000** = **~฿2,600/เดือน base** [verify: Hostinger KVM8 = ฿1,050 ถ้า commit 24ด / ~฿2,000 รายเดือน]
- 1 worker (8vCPU) รับ **~20,000 คลิป/เดือน ≈ ~400 sub** → เพิ่ม worker (+฿2,000) ต่อ ~400 sub
- render compute = อยู่ในกล่อง worker (ไม่ใช่ต่อนาที); marginal ~฿0.1/คลิป ตอนสเกล

### Margin & break-even
| | รายได้ | AI cost | contribution | margin |
|---|---|---|---|---|
| PRO @ Founder ฿250 (floor) | ฿250 | 56฿ (80น.) | ฿194 | **68%** |
| PRO @ รายเดือน ฿599 | ฿599 | 56฿ | ฿543 | 91% |
| BIZ @ Founder ฿413 (floor) | ฿413 | 105฿ (150น.) | ฿308 | **64%** |
| BIZ @ รายเดือน ฿990 | ฿990 | 105฿ | ฿885 | 89% |

- **Break-even fixed infra (฿2,600/ด): ~14 PRO sub (Founder) หรือ ~5 sub (รายเดือน)** → จากนั้น margin บานเร็ว (>200 sub = infra <5% รายได้)
- **margin floor (worst-case) ยัง 64-68%** + เครดิต = กำไรก้อน 2 ล้วน
- ⚠️ launch: ช่วง <14 sub มี burn คงที่ ฿2,600/ด (hurdle เตี้ย)

---

## 5. Scaling alignment ([`scale-upgrade-plan.md`](scale-upgrade-plan.md))

- Ladder: Rung 0 (queue+worker isolation) ✅ done · Rung 1 = 8vCPU worker · Rung 2 = N workers · Rung 3 = Redis+multibox · Rung 4 = Postgres+S3/CDN
- **สอดคล้อง + align ดี:** cost driver ทั้ง render CPU + AI token สเกลตาม **"นาที"** → การคิดเงินเป็นนาที **cap ทั้งคู่พร้อมกัน**
- **⚠️ ต้องอัปเดต doc นั้น:** บรรทัด "AI cost = $0 (BYOK)" ใช้ไม่ได้แล้ว → AI = ฿0.7/นาที variable
- ใกล้ trigger Rung 1 (p95 คิว >10 นาที) ถ้าคนแห่มา — ฿2,000/worker ถูกคุ้มด้วย sub หลักสิบ

---

## 6. Relaunch & reactivation (Q9)

**ไม่ใช่ migration — เป็น relaunch + reactivation.** paid base จริง ≈ **Founder 1 คน** ("138 ลูกค้า" = trial users, plan=PRO เพราะ trial grant ไม่ใช่คนจ่าย).

- **Founder (1 คน):** คงดีลเดิม/แพ็กเดิม/สิทธิ์เดิม/เครดิตเดิม **ไม่แตะ** — legacy privilege (light user → ไม่มีประเด็นต้นทุน)
- **ทุกคนที่เหลือ → flip server-key managed วันแรก** → 96 ที่ค้างเพราะ key + FREE ทั้งหมด **เจนได้ทันที**
- **🎯 Reactivation email** หา cohort ที่สมัครแล้วไม่เคยได้วิดีโอ (~277) → *"ใช้ได้แล้ว ไม่ต้องใส่ key — trial 7 วันใหม่ที่ใช้ได้จริง"* → ติดเครื่อง 66% retention
- **BYOK เดิม (76 คน):** เก็บ key เป็น overflow/whale option, default → managed
- **Founder-100 เหลือ ~99 ที่นั่ง** → urgency ตอน relaunch

## 7. Growth models (Q10) — 3 ชั้นทับ subscription+credits

หลักการ: activation = คอขวด, retention แข็ง (66%) → ลงทุนที่ "ขยายปาก funnel + เร่ง activation" คุ้มสุด

| Layer | กลไก | ต้นทุน | บทบาท |
|---|---|---|---|
| **① Referral loop** | watermark = โฆษณาฟรี + ชวนเพื่อน → ทั้งคู่ได้เครดิต/ฟรีเดือน | ถูก (~฿20/เครดิต) | viral ถูกสุด — คูณกับ watermark + 66% retention · **ทำก่อน** |
| **② Affiliate / Creator** | ครีเอเตอร์โปรโมท → จ่าย % recurring | จ่ายเมื่อขายได้ | ช่องทาง acquisition นอก organic |
| **③ Agency / Team tier (B2B)** | seats + credit pool รวม + brand kit + client folders · ฿2,990+/ด | ใช้ infra เดิม | **revenue scaler** ระยะกลาง (ACV สูง, stickier) |

เก็บทีหลัง (ต้องมี user/product พร้อมกว่านี้): ④ template marketplace · ⑤ API/white-label · ⑥ lifetime/AppSumo (cash ก้อนแรก, ใช้ระวัง margin)

## 8. Open decisions (ยังไม่ปิด)

- **[open]** Free = 3 หรือ 5 คลิป · บังคับบัตรตอน trial (lever) · ส่วนลดรายปี (คง 17%+Founder50% หรือปรับ) · เสียงพรีเมียม upsell · BIZ Founder margin ~49% เมื่อใช้เครดิตแถมหมด (ยอมรับสำหรับ Founder cohort)
- **[verify ก่อน launch]** Gemini TTS preview pricing · Hostinger KVM8 จริง · FX rate

---

## 9. กฎที่ทำให้ทั้งหมดสอดคล้อง

1. **คิดเงินเป็น "นาที"** = หน่วยเดียวที่ cap ทั้ง AI cost + render load
2. **Subscription = growth (ถูก, friction ต่ำ) · Credit = margin (premium markup)**
3. **server key ปลดกำแพง prepaid** → activation ↑ → 66% retention ทำงาน
4. **Fixed infra เตี้ย (~14 sub คุ้ม)** → โตแล้ว margin บาน
