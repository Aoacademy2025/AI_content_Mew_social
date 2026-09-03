# รายงาน MiniMax H3 บน RunPod: รุ่นที่ใช่ วิธีใช้ และต้นทุนปัจจุบัน

> สถานะข้อมูล: 1 กันยายน 2026 (Asia/Bangkok)  
> แหล่งข้อมูล: เอกสารทางการของ MiniMax, RunPod และ model repository ของ MiniMax เท่านั้น  
> ค่าเงินบาทในตัวอย่าง: **สมมติ $1 = ฿33.20** เพื่อช่วยกะงบ ไม่ใช่อัตราแลกเปลี่ยนที่การันตี และยังไม่รวม VAT, ค่าบัตร/FX หรือภาษี  
> ราคาและ availability ของ GPU เปลี่ยนได้ ควรเช็กหน้า pricing/console อีกครั้งก่อนเปิดเครื่องจริง

## คำตอบสั้น

ใช่—รุ่นใหม่ที่หมายถึงน่าจะเป็น **MiniMax H3** (`MiniMax-H3`) ไม่ใช่ Hailuo 2.3 รุ่นเดิม และปัจจุบันมีรุ่นเร็วชื่อ **MiniMax H3 Max** (`MiniMax-H3-Max`) เพิ่มเข้ามาด้วย ([คู่มือวิดีโอ MiniMax](https://platform.minimax.io/docs/guides/video-generation), [ราคา MiniMax](https://platform.minimax.io/docs/guides/pricing-paygo)).

แต่ **RunPod ยังไม่มี MiniMax H3 ใน Public Endpoints catalog** ณ วันที่เข้าถึง จึงยังไม่มีราคา RunPod แบบตายตัวต่อคลิป วิธีใช้บน RunPod คือ self-host `H3-Base` บน Pod/ComfyUI หรือสร้าง custom Serverless endpoint เอง; RunPod เองก็แนะนำสองเส้นทางนี้ ([RunPod Public Endpoints](https://docs.runpod.io/public-endpoints/reference), [บทความ H3 ของ RunPod](https://www.runpod.io/blog/minimax-h3-the-open-weight-omni-modal-video-model-and-what-it-takes-to-run-it)).

ข้อเสนอแนะสำหรับงานของทีม:

- **ทดลองงาน/ปริมาณน้อยถึงกลาง/ต้องการ 2K:** ใช้ MiniMax API ก่อน ราคา H3 คือ **$0.08 ต่อวินาทีที่ 768P** และ **$0.13 ต่อวินาทีที่ 2K** ใช้ง่ายกว่าและไม่รับภาระ cold start, storage และดูแล runtime
- **งานปริมาณมากต่อเนื่อง/ข้อมูลต้องอยู่ในระบบเรา/ต้อง fine-tune:** ค่อยทดสอบ H3-Base บน RunPod โดยเริ่มที่ topology ที่มี benchmark จริง เช่น 4×H200
- **งานเสียงภาษาไทย:** ให้ใช้ H3 สำหรับภาพ, ambience และ SFX ได้ แต่คง narration/บทพูดไทยไว้ใน voice pipeline เดิมจนกว่าจะทดสอบจริง เพราะ MiniMax ระบุภาษาบทพูดที่รองรับอย่างเสถียร 11 ภาษาและ **ไม่มีภาษาไทยในรายชื่อนั้น**
- **ก่อน self-host เชิงพาณิชย์:** ตรวจไลเซนส์กับฝ่ายกฎหมายก่อน เพราะนี่คือ open-weight ภายใต้ Community License ที่จำกัดพื้นที่ ไม่ใช่ permissive open source

## 1. H3 และ H3 Max คืออะไร

| รายการ | MiniMax H3 | MiniMax H3 Max |
|---|---|---|
| API model ID | `MiniMax-H3` | `MiniMax-H3-Max` |
| จุดเด่น | โมเดล multimodal ทั่วไป รับ text/image/video/audio และทำ reference generation/editing | รุ่น post-trained ร่วมกับ fal.ai เน้นความเร็ว |
| ความละเอียด API | 768P, 2K | 480P, 768P |
| ระยะเวลา output | 4–15 วินาที เป็นจำนวนเต็ม | 5–15 วินาที เป็นจำนวนเต็ม |
| โหมด | T2V, I2V, first/last frame, reference image/video/audio | T2V, I2V ณ ปัจจุบัน |

ข้อมูลในตารางมาจาก [คู่มือ Video Generation ของ MiniMax](https://platform.minimax.io/docs/guides/video-generation) และ [API reference v2](https://platform.minimax.io/docs/api-reference/video-generation-v2-create). H3 ใช้ endpoint `POST https://api.minimax.io/v2/video_generation`; อย่าสับสนกับ API รุ่นเก่าของ Hailuo.

ความสามารถสำคัญของ H3:

- สร้างภาพเคลื่อนไหวพร้อมเสียง stereo 32 kHz ใน generation เดียว, 24 fps, อัตราส่วนภาพหลักรวม 16:9 และ 9:16
- Reference mode รับได้สูงสุด 9 ภาพ, 3 คลิปวิดีโอ และ 3 คลิปเสียง โดยมีข้อจำกัดเวลารวมและจำนวนไฟล์ตาม API
- รุ่นที่เปิด weights คือ **H3-Base** ซึ่งสร้าง 768p; ระบบเต็มของ MiniMax ยังมี `H3-Context-IR` และ `H3-Regenerate-2K` ซึ่งไม่ได้รวมอยู่ใน open-weight release จึงต้องใช้ API ของ MiniMax หากต้องการเลียนแบบ workflow 2K ทางการครบชุด
- H3-Omni-Transformer เป็น dense 33B และใช้ Qwen3-VL-32B เป็น encoder; initial release ใช้ full attention โดย sparse-attention implementation ยังไม่เปิดในรุ่นแรก

ดูรายละเอียดจาก [MiniMax H3 model card](https://huggingface.co/MiniMaxAI/MiniMax-H3) และ [official self-host guide](https://platform.minimax.io/docs/guides/local-deploy-h3).

### ข้อควรระวังสำหรับเสียงภาษาไทย

MiniMax ระบุ stable dialogue support สำหรับ Arabic, Chinese, English, French, German, Italian, Japanese, Korean, Portuguese, Russian และ Spanish; ภาษาอื่นรองรับ “ในระดับที่แตกต่างกัน” แต่ **ภาษาไทยไม่ได้อยู่ในกลุ่ม stable 11 ภาษา** ([model card](https://huggingface.co/MiniMaxAI/MiniMax-H3)). ดังนั้นควร A/B test lip-sync, การออกเสียง และความสม่ำเสมอของตัวละครก่อนใช้บทพูดไทยจริง ส่วนเสียงบรรยายไทยควรใช้ OmniVoice/voice pipeline เดิมไปก่อน.

## 2. ใช้ H3 บน RunPod ได้อย่างไร

| เส้นทาง | สถานะปัจจุบัน | เหมาะกับ |
|---|---|---|
| RunPod Public Endpoint | **ยังไม่พบ H3 ใน catalog** | ยังใช้แบบ managed per-request ไม่ได้ |
| RunPod Pod + ComfyUI | ใช้ official RunPod ComfyUI template และ workflow/weights ที่เกี่ยวข้อง | ทดลอง prompt, ตรวจภาพ, งาน interactive |
| RunPod Pod + SGLang/vLLM-Omni | deploy API เอง; SGLang H3 ยังสถานะ Preview และ vLLM-Omni เป็น community-maintained/experimental path | ระบบควบคุมเองและโหลดต่อเนื่อง |
| RunPod custom Serverless | สร้าง image/handler/endpoint เอง; คิดเงินตามเวลาที่ worker ทำงาน | burst workload หลัง optimize image และ warmup |
| MiniMax hosted API | พร้อมใช้ ไม่ต้องผ่าน RunPod | เริ่มใช้งานเร็ว, 2K, Context-IR, ไม่อยากดูแล infra |

แหล่งอ้างอิง: [RunPod Public Endpoints](https://docs.runpod.io/public-endpoints/reference), [RunPod H3 guide](https://www.runpod.io/blog/minimax-h3-the-open-weight-omni-modal-video-model-and-what-it-takes-to-run-it), [MiniMax local deployment guide](https://platform.minimax.io/docs/guides/local-deploy-h3).

การ self-host บน RunPod **ไม่เท่ากับ** ได้ระบบ MiniMax hosted API ทั้งหมด: open release มี H3-Base FL2VA/Ref2VA แต่ไม่มี hosted Context-IR และ Regenerate-2K. ดังนั้นการเทียบราคาในรายงานนี้เป็นการเทียบงบ ไม่ใช่การรับรองว่าคุณภาพหรือ pipeline เหมือนกันทุกจุด.

## 3. Hardware, runtime และ storage ที่ควรรู้

ตัวเลขต่อไปนี้เป็น benchmark ของ workload เฉพาะ: 5 วินาที T2VA, 1344×768, 124 frames, 24 fps, 50 steps, batch/concurrency 1 เว้นแต่ระบุอย่างอื่น จึงใช้เป็น sizing guide ไม่ใช่ SLA ([MiniMax local deployment guide](https://platform.minimax.io/docs/guides/local-deploy-h3)).

| Topology | ผลที่เผยแพร่ | หมายเหตุ |
|---|---:|---|
| 8×B200 | เป็น pinned reference baseline | ไม่ใช่คำประกาศว่าเป็น minimum; latency exact ของ baseline นี้ไม่เผยแพร่ |
| 4×H200, lossless | เฉลี่ย **75.10 วินาที** ต่อคลิป 5 วินาที | benchmark ที่เหมาะสุดสำหรับคำนวณตัวอย่างค่าใช้จ่าย |
| 4×H200, Cache-DiT `quality: high` | **53.70 วินาที** | เป็น approximate path; รายงาน SSIM 0.931 / PSNR 28.16 เทียบ lossless |
| 8×B300, BF16 FL2VA | **19.04 วินาที** | peak 83,578 MB/GPU; เป็น warm benchmark หลัง warmup หนึ่งครั้ง |
| 2×RTX 5090, offload, lossless | **559.67 วินาที** | ต้องใช้ host RAM อย่างน้อย 200 GiB และแนะนำ 384 GiB ใน offload recipe |
| 1×RTX 4090, INT8 | GPU peak ราว 18 GB | latency ไม่ได้เผยแพร่ จึงไม่ควรใช้ตั้ง SLA/งบ |

อย่ามอง 2×RTX 5090 เป็นตัวเลือก plug-and-play บน RunPod: official offload recipe ต้องการ host RAM ≥200 GiB แต่หน้า RunPod ระบุ instance RTX 5090 มาตรฐานมี RAM 35 GB ต่อ GPU listing ([RunPod pricing](https://www.runpod.io/pricing), [MiniMax local deployment guide](https://platform.minimax.io/docs/guides/local-deploy-h3)).

ด้าน storage:

- official mixed-precision weights อยู่ราว **108 GB** ตาม deployment guide
- vLLM-Omni ใช้ราว **135 GiB ต่อ checkpoint partition**; ถ้าเก็บ FL2VA และ Ref2VA ทั้งคู่ราว 270 GiB
- RunPod แนะนำ volume ราว **600 GB** ใน tutorial เพราะดาวน์โหลดทั้ง repo เพื่อทดลอง quant หลายชุด ไม่ใช่ minimum สำหรับ production workflow เดียว
- หากตรึงเพียง ComfyUI T2V workflow และ artifacts ที่จำเป็น ขนาดดาวน์โหลดที่รวมจากไฟล์ปัจจุบันอยู่ราว 44.4 GB; การเผื่อ **80–100 GB** สำหรับ cache/output เป็น planning estimate ของรายงาน ไม่ใช่ minimum ทางการ

แหล่งอ้างอิง: [MiniMax self-host guide](https://platform.minimax.io/docs/guides/local-deploy-h3), [MiniMax H3 files](https://huggingface.co/MiniMaxAI/MiniMax-H3/tree/main), [RunPod H3 tutorial](https://www.runpod.io/blog/minimax-h3-the-open-weight-omni-modal-video-model-and-what-it-takes-to-run-it).

## 4. ราคา MiniMax API ปัจจุบัน

ราคาทางการแบบ pay-as-you-go ([MiniMax pricing](https://platform.minimax.io/docs/guides/pricing-paygo)):

| Model / resolution | ราคา USD ต่อ output second | 5 วินาที | 10 วินาที | 15 วินาที |
|---|---:|---:|---:|---:|
| H3 768P | $0.08 | $0.40 / ฿13.28 | $0.80 / ฿26.56 | $1.20 / ฿39.84 |
| H3 2K | $0.13 | $0.65 / ฿21.58 | $1.30 / ฿43.16 | $1.95 / ฿64.74 |
| H3 Max 480P | $0.05 | $0.25 / ฿8.30 | $0.50 / ฿16.60 | $0.75 / ฿24.90 |
| H3 Max 768P | $0.08 | $0.40 / ฿13.28 | $0.80 / ฿26.56 | $1.20 / ฿39.84 |

ค่า input/บริการเสริมของ H3:

- Audio input ฟรี
- 5 ภาพแรกฟรี; ภาพที่เกินคิด $0.04 ต่อภาพ
- Reference video คิดตามความยาว input ที่ $0.08/s สำหรับงาน 768P หรือ $0.13/s สำหรับ 2K
- Regenerate 768P → 2K คิดเพิ่ม $0.05 ต่อวินาที output และคิด input materials ของงานเดิมซ้ำตามตารางราคา
- H3-Context-IR: $0.90 ต่อ 1M input tokens และ $3.60 ต่อ 1M output tokens
- H3 Max ตอนนี้คิดเฉพาะ output video; input image ยังไม่คิดค่าบริการตาม note ปัจจุบัน

ตัวอย่าง: สร้าง H3 768P 5 วินาทีโดยมี reference video 6 วินาที = `(5 × $0.08) + (6 × $0.08)` = **$0.88 หรือประมาณ ฿29.22**. ถ้าใช้ reference images 7 ภาพแทน = `$0.40 + (2 × $0.04)` = **$0.48 หรือประมาณ ฿15.94**.

### งบวิดีโอสำเร็จ 60 วินาที

สมมติประกอบจาก 12 ช็อต ช็อตละ 5 วินาที, ไม่มี input ที่คิดเงินเพิ่ม:

| สมมติฐาน | H3 768P | H3 2K |
|---|---:|---:|
| สร้างครั้งเดียวต่อช็อต (12 generations) | $4.80 / ฿159.36 | $7.80 / ฿258.96 |
| เฉลี่ย 1.5 attempts ต่อช็อต (18 generations) | $7.20 / ฿239.04 | $11.70 / ฿388.44 |

นี่เป็นค่า generation เท่านั้น ไม่รวมการตัดต่อ, voice pipeline, music, reference inputs, Context-IR tokens, ภาษี หรือ clip ที่ต้องลองเกินสมมติฐาน.

## 5. ราคา RunPod ที่เกี่ยวข้อง

RunPod คิด Pod และ Serverless ตามเวลา GPU ไม่ได้คิดตามจำนวนวินาทีของวิดีโอ. ราคา live ที่เข้าถึงจาก [RunPod pricing](https://www.runpod.io/pricing):

| GPU (ต่อการ์ด) | Pod Community / hr | Pod Secure / hr | Serverless Flex / hr |
|---|---:|---:|---:|
| B300 | $6.94 | $7.89 | $9.98 |
| B200 | $5.98 | $6.79 | $8.64 |
| H200 | $3.59 | $4.59 | $5.93 |
| H100 PCIe | $1.99 | $2.89 | Serverless H100 pool $4.79 |
| H100 SXM | $2.69 | $3.29 | Serverless H100 pool $4.79 |
| RTX 5090 | $0.69 | $0.99 | $1.58 |

ราคา Secure Cloud คือค่าที่หน้า pricing แสดงเป็นค่าเริ่มต้น; Community ถูกกว่าแต่ availability และ host configuration อาจต่างกัน. Pods คิดรายวินาที ส่วน Serverless คิดตั้งแต่ worker เริ่มจนหยุดเต็มที่ ปัดขึ้นเป็นวินาที และ idle timeout เริ่มต้นคือ 5 วินาที ([Pod pricing rules](https://docs.runpod.io/pods/pricing), [Serverless pricing rules](https://docs.runpod.io/serverless/pricing)).

### ตัวอย่างต้นทุน RunPod ต่อคลิป 5 วินาที

สูตร: `จำนวน GPU × ราคา GPU/ชั่วโมง × billed wall-clock seconds ÷ 3,600`.

| กรณี | สมมติฐาน billed time | ต้นทุนต่อคลิป |
|---|---:|---:|
| 4×H200 Pod Community, lossless | warm 75.10s | **$0.300 / ~฿9.95** |
| 4×H200 Pod Secure, lossless | warm 75.10s | **$0.383 / ~฿12.72** |
| 4×H200 Serverless, lossless | warm 75.10s + idle 5s; ไม่รวม cold load | **$0.528 / ~฿17.52** |
| 4×H200 Pod Community, Cache-DiT high | warm 53.70s | **$0.214 / ~฿7.11** |
| 4×H200 Pod Secure, Cache-DiT high | warm 53.70s | **$0.274 / ~฿9.09** |
| 4×H200 Serverless, Cache-DiT high | warm 53.70s + idle 5s | **$0.387 / ~฿12.84** |
| 8×B300 Pod Community, BF16 | warm 19.04s | **$0.294 / ~฿9.75** |
| 8×B300 Pod Secure, BF16 | warm 19.04s | **$0.334 / ~฿11.08** |
| 8×B300 Serverless, BF16 | warm 19.04s + idle 5s | **$0.533 / ~฿17.70** |

ข้อจำกัดของตารางนี้:

- เป็น arithmetic จาก published benchmark ไม่ใช่ราคาหรือ performance guarantee ของ RunPod
- ถือว่า worker/model warm แล้วและได้ topology/interconnect เหมือน benchmark
- ไม่รวม startup, ดาวน์โหลด weights, health check, failed generations, retries, storage และเวลาว่างระหว่างงาน
- Cache-DiT/FP8/quantized ComfyUI เป็น approximate หรือ converted paths จึงเทียบคุณภาพกับ lossless/API ตรง ๆ ไม่ได้
- H100 มี benchmark บางตาราง แต่ upstream ไม่เผย request shape จึงไม่ใช้คำนวณต่อคลิปในรายงานนี้

### Cold start และ storage

official guide ระบุว่าการ load/warm อาจกินเวลาหลายนาที. ตัวอย่างเชิงงบเท่านั้น: ถ้า 4×H200 Serverless ใช้ cold load 3–5 นาที แล้ว render 75.10 วินาทีและ idle 5 วินาที งานแรกจะอยู่ราว **$1.71–$2.50 หรือ ฿56.9–฿83.2**; ทุก 1 นาทีที่เพิ่มบน 4×H200 Serverless มีต้นทุนประมาณ **$0.395 หรือ ฿13.12**. นี่ไม่ใช่ benchmark cold-start และยังไม่รวม download จากอินเทอร์เน็ต.

Storage ตาม [RunPod pricing](https://www.runpod.io/pricing): container disk $0.10/GB/month, volume disk $0.10/GB/month ขณะ running และ $0.20/GB/month ขณะ idle, network storage standard ต่ำกว่า 1TB อยู่ที่ $0.07/GB/month. ดังนั้น tutorial ขนาด 600 GB จะเท่ากับราว **$60/month** บน running volume disk, **$120/month** หาก idle ทั้งเดือน หรือ **$42/month** บน standard network storage—ก่อนค่า compute.

### เทียบงบ 60 วินาทีแบบ warm

สมมติ 12 ช็อต × 5 วินาที, ใช้ lossless 4×H200 benchmark, ทำต่อเนื่องบน model ที่ warm และไม่รวม storage/cold start:

| ทางเลือก | ต้นทุน 12 ช็อต |
|---|---:|
| MiniMax API H3 768P | $4.80 / ฿159.36 |
| 4×H200 Pod Community | ~$3.59 / ~฿119.35 |
| 4×H200 Pod Secure | ~$4.60 / ~฿152.59 |
| 4×H200 Serverless | ~$5.97–$6.33 / ~฿198.2–฿210.3 |

Serverless range คือให้ worker warm ต่อเนื่องและจ่าย idle 5s ครั้งเดียว เทียบกับปล่อย scale-to-zero หลังทุกช็อตโดยยัง **ไม่** ใส่ cold-load time. ถ้าเฉลี่ย 1.5 attempts ต่อช็อต ให้คูณ compute/API generation ข้างต้นประมาณ 1.5 เท่า. ความต่างราคาไม่มากพอจะตัดสินจาก GPU arithmetic อย่างเดียว โดยเฉพาะเมื่อ H3-Base ที่ self-host ไม่ใช่ hosted workflow ครบชุด.

## 6. ไลเซนส์และข้อจำกัดสำคัญ

ข้อจำกัดต่อไปนี้เกี่ยวกับ **open-weight/self-host H3 Works และ outputs ภายใต้ MiniMax H3 Community License**; การใช้ hosted MiniMax API ต้องตรวจ Paid Service Terms/checkout terms แยกต่างหาก. ไม่ใช่คำแนะนำทางกฎหมาย.

- Applicable Territory คือทั่วโลก **ยกเว้น EU, UK, Republic of Korea และ USA**; license ห้ามใช้/แสดง/distribute H3 Works หรือ outputs นอกพื้นที่ที่อนุญาต
- ไทยอยู่ในพื้นที่ที่ license ระบุว่าใช้ได้ แต่หาก CDN, ผู้ใช้, ทีมงาน หรือการเผยแพร่ output เข้าถึงจากพื้นที่ที่ยกเว้น ต้องขอ license/คำยืนยันเพิ่มก่อน
- ผลิตภัณฑ์เชิงพาณิชย์ที่รายได้เกิน $20M ต่อปีต้องขอ written authorization ล่วงหน้า
- UI ของ commercial product/service ต้องแสดง “MiniMax H3” อย่างเด่นชัด
- Hosted service ของตนเองต้องมีข้อกำหนดผู้ใช้และ safeguards/abuse-reporting/การตรวจสอบตาม license
- ห้ามใช้ H3 Works/outputs ไปพัฒนา AI model อื่น ยกเว้น H3 derivative
- เนื้อหาที่เผยแพร่สู่ public environment ต้องเปิดเผยอย่างชัดเจนว่า machine-generated
- MiniMax ไม่อ้างสิทธิ์ใน outputs แต่ผู้ใช้รับผิดชอบ output และการนำไปใช้

อ่านฉบับเต็มที่ [MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE). ข้อจำกัดเหล่านี้ทำให้ควรเรียกรุ่นนี้ว่า **open-weight/source-available** มากกว่า “open source แบบ permissive”.

## 7. ข้อสรุปเลือกใช้งาน

1. **เริ่มด้วย MiniMax API H3 768P** สำหรับ production pilot: ราคา 5 วินาที $0.40, 10 วินาที $0.80, 15 วินาที $1.20 และไม่มีงาน infra.
2. **ใช้ H3 Max 480P** ถ้าความเร็ว/ราคา preview สำคัญกว่าความละเอียดหรือ reference workflow: เริ่ม $0.25 ต่อ 5 วินาที.
3. **ใช้ API 2K** เมื่อต้องส่งงานความละเอียดสูง; self-host H3-Base เพียงอย่างเดียวไม่ให้ official full 2K workflow.
4. **ทดสอบ RunPod 4×H200** ก็ต่อเมื่อมีคิวงานต่อเนื่องพอให้ model warm, ต้องควบคุมข้อมูล/fine-tune หรือยอมรับภาระ runtime ได้. Warm compute อาจถูกกว่า API เล็กน้อย แต่ cold start, storage, retries และ ops ลบส่วนต่างได้ง่าย.
5. **ยังไม่ย้ายเสียงบรรยายไทยเข้า H3 โดยอัตโนมัติ**: ใช้ H3 ทำ visuals/ambience/SFX แล้วใช้ voice pipeline ไทยเดิม จนกว่าผล A/B test จะผ่าน.
6. **อย่าเปิด public/global self-host service ก่อน legal review** เนื่องจาก territorial restrictions ครอบคลุมทั้งตัวโมเดลและ outputs.

---

ข้อมูลทั้งหมดเข้าถึงเมื่อ **2026-09-01**. ตัวเลข USD จากผู้ให้บริการเป็นฐานอ้างอิง; ตัวเลข THB เป็นเพียงผลคูณด้วยสมมติฐาน ฿33.20/USD. ตรวจ [MiniMax pricing](https://platform.minimax.io/docs/guides/pricing-paygo), [RunPod pricing](https://www.runpod.io/pricing) และ availability ใน RunPod console อีกครั้งก่อนสั่งงานจริง.
