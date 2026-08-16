# Open-weight image models สำหรับ HERO AI บน RunPod + ComfyUI

วันที่ตรวจสอบ: 21 กรกฎาคม 2026

## ข้อสรุปสำหรับตัดสินใจ

ถ้าจะทำ PoC ให้มีทั้งสร้างภาพและแก้ภาพ โดยยังคุมต้นทุน/เวลา cold start บน GPU 24GB ได้ แนะนำเริ่มเพียง 2–3 รุ่น:

1. **FLUX.2 [klein] 4B Distilled** — ตัวหลักสำหรับงานเร็ว, image generation, edit และ multi-reference; Apache-2.0, ใช้ VRAM ราว 8.4GB และ native ComfyUI
2. **ERNIE-Image-Turbo** — ตัวเลือก Premium สำหรับภาพและข้อความในภาพ โดยเฉพาะ English/Chinese; Apache-2.0, 8 steps, ผู้พัฒนาระบุรองรับ GPU 24GB และ native ComfyUI
3. **LongCat-Image-Edit-Turbo** — เพิ่มเมื่ออยากขาย editing/reference consistency เป็นสินค้าแยก; Apache-2.0, 8 steps, ผู้พัฒนาระบุราว 18GB เมื่อใช้ CPU offload และมี ComfyUI support

ถ้าต้องการเริ่มแค่สองตัว ให้ใช้ **FLUX.2 [klein] 4B + ERNIE-Image-Turbo** ก่อน เพราะ FLUX ทำ edit ได้อยู่แล้ว ส่วน LongCat ค่อยเพิ่มหลังวัดว่าลูกค้าใช้ edit มากพอหรือไม่

> ข้อควรระวังเรื่องชื่อ: **FLUX.2 [klein] 4B** เป็น Apache-2.0 แต่ **FLUX.2 [klein] 9B** ใช้ FLUX Non-Commercial License จึงไม่ควรนำ 9B ไปให้บริการแบบเสียเงินโดยไม่ได้รับสิทธิ์เพิ่ม

## Open source กับ open weights ไม่เหมือนกัน

- กลุ่มที่สิทธิ์ค่อนข้างตรงไปตรงมาสำหรับ self-hosted commercial SaaS ในงานนี้: Apache-2.0 หรือ MIT เช่น FLUX.2 Klein 4B, Z-Image, ERNIE-Image, LongCat-Image, Qwen-Image, HiDream-O1, OmniGen2, SANA และ Lumina-Image 2.0
- บางรุ่นเปิดให้ดาวน์โหลดน้ำหนัก แต่มีข้อจำกัดทางการค้า/พื้นที่/จำนวนผู้ใช้ เช่น FLUX.2 Klein 9B และ HunyuanImage
- บาง repo มี license ของโค้ดไม่เหมือน license ของ weights ต้องตรวจที่ artifact ที่นำขึ้น production จริง ไม่ใช่ดูเฉพาะหน้า GitHub

การประเมินนี้ไม่ใช่คำแนะนำทางกฎหมาย ควรบันทึก model revision, license file และ checksum ของทุก artifact ตอน deploy

## ตารางรุ่นที่น่าสนใจ

| รุ่น | จุดเด่น/ข้อจำกัด | License สำหรับ paid SaaS | ComfyUI | ความเหมาะสมกับ GPU 24GB |
|---|---|---|---|---|
| [FLUX.2 Klein 4B](https://bfl.ai/models/flux-2-klein) | 4B, Distilled 4 steps, T2I + semantic edit + multi-reference; BFL ระบุ ~1.2 วินาทีและ 8.4GB บน RTX 5090 | **Apache-2.0: ใช้เชิงพาณิชย์ได้** ([license](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/blob/5b4408e59397a4a37ccb46afe426d8ed86379441/LICENSE.md)) | [Native workflow](https://docs.comfy.org/tutorials/flux/flux-2-klein) ทั้ง generate/edit | **สบาย**; เหมาะที่สุดกับ Serverless/cold start ใน shortlist |
| [Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | 6B, 8 steps, photorealism, prompt adherence, text English/Chinese; 1024 แนะนำ; official edit/omni ยังไม่ปล่อยตาม model card | **Apache-2.0** | [Native ComfyUI](https://docs.comfy.org/tutorials/image/z-image/z-image-turbo), มี Fun ControlNet | **สบาย**; ผู้พัฒนาระบุว่าอยู่ใน 16GB |
| [ERNIE-Image-Turbo](https://huggingface.co/baidu/ERNIE-Image-Turbo) | 8B, 8 steps (รุ่นเต็ม 50), เด่น text/layout, poster/comic/multi-panel; ตอนนี้เป็น T2I | **Apache-2.0** | [Native ComfyUI](https://docs.comfy.org/tutorials/image/ernie-image/ernie-image) | **พอดีสเปก**; ผู้พัฒนาระบุ 24GB เหมาะเป็น Premium T2I มากกว่าตัวประหยัด |
| [LongCat-Image](https://github.com/meituan-longcat/LongCat-Image) | 6B; มี Base/Dev/Edit/Edit-Turbo, edit turbo 8 steps, เด่น identity/reference consistency; English/Chinese | **Apache-2.0** | มี native implementation ใน ComfyUI ตาม official repo/changelog | **ได้**; official ระบุ edit ราว 18GB เมื่อ CPU offload |
| [HiDream-O1-Image](https://github.com/HiDream-ai/HiDream-O1-Image) | รุ่นใหม่ พ.ค. 2026; unified generation/edit, subject-driven multi-reference, layout/skeleton/storyboard, สูงสุด 2K; Full 50 / Dev 28 steps | **MIT** | [Native ComfyUI](https://docs.comfy.org/tutorials/image/hidream/hidream-o1), มี FP8/MXFP8 | **ได้แบบ quantize/offload ที่ 1K**; weights หลัก ~35GB และ 2K มีความเสี่ยง OOM/ช้า จึงควรเป็น Phase 2 |
| [Qwen-Image / Qwen-Image-Edit](https://huggingface.co/Qwen/Qwen-Image) | 20B, เด่น complex text rendering และ precise edit โดยเฉพาะ English/Chinese | **Apache-2.0** ([Edit card](https://huggingface.co/Qwen/Qwen-Image-Edit)) | มี native Qwen Image/Edit nodes และ workflow ใน [ComfyUI](https://docs.comfy.org/built-in-nodes/TextEncodeQwenImageEdit) | **หนัก**; BF16 repository ใหญ่มาก ต้อง FP8/offload บน 24GB, cold start ไม่ดี |
| [Boogu-Image-0.1](https://huggingface.co/Boogu/Boogu-Image-0.1-Base) | ใหม่มาก มิ.ย.–ก.ค. 2026; 10B, Base/Turbo/Edit/Edit-Turbo, Turbo 4 steps, 1K และ Base/Edit ถึง 2K | **Apache-2.0** | มี [ComfyUI repack](https://huggingface.co/Comfy-Org/Boogu-Image) | **พอได้ด้วย FP8 + CPU offload**; ผู้พัฒนาระบุว่าเป็น research project และ edit consistency ยังไม่เสถียร — watchlist ไม่ใช่ paid production รุ่นแรก |
| [OmniGen2](https://huggingface.co/OmniGen2/OmniGen2) | 4B image model; unified T2I/edit/in-context/person/reference; ทำงานดีที่สุดกับ prompt ภาษาอังกฤษ | **Apache-2.0** | [Official ComfyUI example](https://comfyanonymous.github.io/ComfyUI_examples/omnigen/) | **ได้**; official ระบุ native ~17GB บน RTX 3090 และ offload ลดได้อีก |
| [SANA 1.5 / SANA-Sprint](https://github.com/NVlabs/Sana) | 0.6B/1.6B/4.8B; Sprint one/few-step, official ระบุ 0.3 วินาทีบน RTX 4090 ที่ 1024; เหมาะ preview/budget | **Apache-2.0** | มี ComfyUI node/support ตาม official repo | **สบายมาก**; 4-bit ต่ำกว่า 8GB แต่คุณภาพ/ข้อความไม่ใช่ระดับรุ่น flagship ปี 2026 |
| [Lumina-Image 2.0](https://github.com/Alpha-VLLM/Lumina-Image-2.0) | 2.6B, 1024, 50 steps; compact และปรับแต่งง่าย แต่ถูกตัวใหม่กว่าแซงด้านความเร็ว/คุณภาพ | **Apache-2.0** | [Native example](https://comfyanonymous.github.io/ComfyUI_examples/lumina2/) | **สบาย** แต่ไม่ใช่ priority เว้นแต่ต้องการ fine-tune baseline เล็ก |
| [Ovis-Image 7B](https://huggingface.co/ATH-MaaS/Ovis-Image-7B) | T2I 7B, text rendering English/Chinese, hardware ระดับกลาง | **Apache-2.0** | [Native ComfyUI](https://docs.comfy.org/tutorials/image/ovis/ovis-image) | **น่าจะได้** บน 24GB แต่ยังไม่มีตัวเลข VRAM official ชัดเจน; ERNIE/Z-Image น่าสนใจกว่า |
| [Chroma1-HD/Flash](https://huggingface.co/lodestones/Chroma1-HD) | 8.9B, สาย aesthetics/fine-tuning บนฐาน FLUX Schnell | **Apache-2.0 เฉพาะ Chroma1-HD/Flash artifact นี้** | [Native example](https://comfyanonymous.github.io/ComfyUI_examples/chroma/) | **มีโอกาสได้** บน 24GB แต่ไม่ใช่ core shortlist; ห้ามสับสนกับ Chroma-8.9B รุ่นเก่าที่ใช้ FLUX Dev non-commercial license |

## รุ่นที่ไม่แนะนำให้เริ่มบน RunPod 24GB

| รุ่น | เหตุผล |
|---|---|
| [HunyuanImage 2.1](https://github.com/Tencent-Hunyuan/HunyuanImage-2.1) | 17B/2K; FP8 + CPU offload พอรัน 24GB ได้ แต่ repository ใหญ่ราว 173GB ทำให้ serverless cold start/volume ยุ่งยาก และ [Tencent Hunyuan Community License](https://huggingface.co/tencent/HunyuanImage-2.1/blob/0c42ca929df2a8b6ff404d123c822c7290283fe6/LICENSE) มี Territory/MAU/use restrictions ไม่ใช่ Apache/MIT |
| [HunyuanImage 3.0](https://huggingface.co/tencent/HunyuanImage-3.0/blob/630d5dab77575abcdeb6e614aaaff1f4d2640e0d/LICENSE) | ใหญ่มากระดับ ~80B และมีข้อจำกัด license; ไม่เหมาะ 24GB |
| [BAGEL](https://github.com/bytedance-seed/BAGEL) | 14B total/7B active; full model ต้อง 32GB+ ส่วน 24GB ต้อง NF4/INT8 และ custom node; cold start/เสถียรภาพไม่คุ้ม PoC |
| [GLM-Image](https://github.com/zai-org/GLM-Image) | hybrid 9B autoregressive + 7B diffusion; model stack ใหญ่และยังไม่พบ native ComfyUI workflow ที่ mature พอสำหรับ catalog แรก |
| FLUX.2 Klein 9B | น้ำหนักอาจพอ 24GB แต่ใช้ [FLUX Non-Commercial License](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md); ห้ามใช้แทน 4B ใน paid service โดยอัตโนมัติ |
| NewBie-image / Anima | น้ำหนักเปิด แต่ license เป็น non-commercial; ตัดออกจาก paid HERO AI catalog |

## Ranking ตามงาน

### เร็วและต้นทุนต่ำ

1. FLUX.2 Klein 4B Distilled — สมดุลดีที่สุด และแก้ภาพได้ในตัว
2. Z-Image-Turbo — 6B/8 steps/16GB, เหมาะภาพ photorealistic ราคาประหยัด
3. SANA-Sprint — เร็วและเล็กมาก เหมาะ preview/draft มากกว่างาน final
4. ERNIE-Image-Turbo — ยังเร็วที่ 8 steps แต่ใช้ 24GB; เหมาะ premium text/layout

### คุณภาพภาพ final

1. HiDream-O1 — capability กว้างที่สุด แต่ช้า/หนักกว่า เหมาะ Phase 2
2. ERNIE-Image / Turbo — เด่น composition และ dense text/layout
3. LongCat-Image — ภาพและ text English/Chinese ดี พร้อมสาย edit
4. Qwen-Image — text/edit แข็งแรง แต่ 20B ไม่เป็นมิตรกับ serverless 24GB

อันดับนี้เป็นการสังเคราะห์จาก capability และข้อกำหนดของผู้ผลิต ไม่ใช่ benchmark ข้ามค่ายภายใต้ hardware/prompt เดียวกัน จึงต้องยืนยันด้วยชุดทดสอบของ HERO AI

### Editing, reference และ character consistency

1. HiDream-O1 — multi-reference, identity/personalization และ storyboard ครบที่สุด
2. LongCat-Image-Edit-Turbo — เหมาะทำ edit endpoint เฉพาะทางบน 24GB
3. FLUX.2 Klein 4B — เร็ว, unified generate/edit และดีที่สุดสำหรับ PoC
4. Qwen-Image-Edit — text edit ดี แต่ model ใหญ่
5. OmniGen2 — ใช้งานได้จริงใน 17GB แต่รุ่นปี 2026 น่าสนใจกว่า

## เรื่องข้อความภาษาไทย

ยังไม่พบ primary source ของรุ่นใดในรายการที่ยืนยันคุณภาพ **Thai text rendering** โดยตรง หลายค่ายพูดถึง multilingual แต่ผล/ตัวอย่างที่ชัดมักเป็น English และ Chinese ดังนั้นยังไม่ควรขายคำว่า “พิมพ์ภาษาไทยในภาพได้แม่น” จาก model ranking อย่างเดียว

แนวทาง production ที่เสี่ยงต่ำกว่า:

1. ให้ model สร้าง background/subject/empty text area
2. วางข้อความไทยด้วย deterministic renderer เช่น Canvas/SVG/Sharp หรือระบบ template พร้อมฟอนต์ไทยที่มีสิทธิ์ใช้งาน
3. ใช้ generative text เฉพาะงานทดลอง แล้วทำ benchmark ภาษาไทยของเราเองอย่างน้อย: พาดหัวสั้น, วรรณยุกต์ซ้อน, ตัวเลข/ราคา, ชื่อแบรนด์, ข้อความหลายบรรทัด และภาพหลาย aspect ratio
4. ให้คะแนน exact-character accuracy แยกจากความสวย ไม่ใช้ human impression อย่างเดียว

นี่เป็นข้อเสนอเชิงวิศวกรรมจากการที่ยังไม่มีหลักฐาน Thai-specific ไม่ใช่ข้อพิสูจน์ว่าโมเดลเหล่านี้สร้างภาษาไทยไม่ได้เลย

## รูปแบบ deployment ที่แนะนำ

ไม่ควรรวม model ทั้งหมดไว้ใน RunPod worker image เดียว เพราะ image ใหญ่, cold start สูง และ VRAM cache แย่งกัน ให้แยกตาม workload:

- `image-fast-edit`: FLUX.2 Klein 4B Distilled, GPU 16–24GB, scale-to-zero
- `image-premium-t2i`: ERNIE-Image-Turbo, GPU 24GB, scale-to-zero
- `image-edit-consistency` (เพิ่มหลัง PoC): LongCat-Image-Edit-Turbo, GPU 24GB + CPU offload ตาม official config

ใช้ ComfyUI workflow JSON เป็น versioned artifact, pin exact model revision และหักเครดิตตาม **GPU-seconds + resolution/steps + storage/egress** ไม่ควรตั้งเครดิตจากจำนวนภาพอย่างเดียว เพราะ 512 preview, 1K final, 2K และ editing มีต้นทุนต่างกันมาก

สำหรับ PoC ให้ `minimum workers = 0`; ใช้ queue และแสดงสถานะ cold start ให้ผู้ใช้ ถ้าปริมาณงานนิ่งและ latency กระทบ conversion ค่อยตั้ง warm worker เฉพาะ endpoint ยอดนิยม ไม่ใช่อุ่นทั้งสาม endpoint

## เกณฑ์ Go/No-Go สำหรับ PoC

ใช้ prompt ชุดเดียวกันอย่างน้อย 50 เคสต่อรุ่น แยกหมวด product, people, poster/layout, Thai-safe-background, edit, reference consistency แล้ววัด:

- success/OOM/error rate บน GPU 24GB
- cold start, warm latency และ GPU-seconds ต่อภาพที่ 1K
- prompt adherence และ artifact rate
- edit identity/reference consistency
- safety moderation และ reproducibility
- Thai text exact-match; ถ้าต่ำให้บังคับ deterministic overlay
- ต้นทุนจริงต่อภาพแล้วบวก margin ของแต่ละ tier

เกณฑ์เบื้องต้น: PoC ผ่านเมื่อ FLUX.2 Klein รองรับ fast+edit ได้เสถียร, ERNIE เพิ่มคุณภาพที่ผู้ใช้มองออกจริง และต้นทุน/latency ของ ERNIE ยอมรับได้เมื่อเทียบกับราคาขาย หาก LongCat ไม่ชนะ FLUX อย่างชัดใน consistency ไม่จำเป็นต้องเปิด endpoint ตัวที่สาม

## แหล่งต้นทางเพิ่มเติม

- [Black Forest Labs: FLUX.2 Klein overview](https://docs.bfl.ai/flux_2/flux2_overview)
- [Z-Image base model](https://huggingface.co/Tongyi-MAI/Z-Image)
- [ERNIE-Image official repository](https://github.com/baidu/ernie-image)
- [HiDream-I1 official repository](https://github.com/HiDream-ai/HiDream-I1) — รุ่นก่อนหน้า O1, MIT
- [RunPod ComfyUI Worker](https://github.com/runpod-workers/worker-comfyui)

