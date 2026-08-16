# OpenRouter "5.6 Luna" / "5.6 Terra" — Live Test vs. Hero Script (Gemini) Stack

Date: 2026-07-31
Scope: real API calls against OpenRouter to evaluate replacing Gemini in the Hero Script
(Thai viral script writer) feature with the founder's "5.6 luna" (free-tier candidate) /
"5.6 terra" (paid-tier candidate) models.

Endpoints used:
- `GET https://openrouter.ai/api/v1/models` — model discovery + pricing
- `POST https://openrouter.ai/api/v1/chat/completions` (with `"usage": {"include": true}`) — probes

Budget used: 4 completion calls (2 models × 2 probes), well under the 10-call cap.

## 1. Model IDs found

Search of the full `/models` list for "luna" / "terra" returned exactly 4 candidates that match
"GPT-5.6 Luna/Terra" naming (all under `openai/`), plus one unrelated match (`sao10k/l3-lunaris-8b`,
a Llama 3 8B roleplay model — clearly not what the founder meant, excluded).

| id | name | context | prompt $/M | completion $/M | notes |
|---|---|---|---|---|---|
| `openai/gpt-5.6-luna` | OpenAI: GPT-5.6 Luna | 1,050,000 | $0.10 | $0.60 | base tier |
| `openai/gpt-5.6-luna-pro` | OpenAI: GPT-5.6 Luna Pro | 1,050,000 | $0.10 | $0.60 | same list price as base Luna |
| `openai/gpt-5.6-terra` | OpenAI: GPT-5.6 Terra | 1,050,000 | $1.00 | $6.00 | base tier |
| `openai/gpt-5.6-terra-pro` | OpenAI: GPT-5.6 Terra Pro | 1,050,000 | $1.00 | $6.00 | same list price as base Terra |

Both Luna and Terra also carry a long-context pricing override that kicks in above
272,000 prompt tokens (Luna → $0.20/$0.90 per M; Terra → $0.20/$0.90... actually $2.00/$9.00 per M —
irrelevant at Hero Script's typical prompt sizes of a few hundred tokens).

**Ambiguity / ⚠️ flag:**
- There is **no `:free` variant** of Luna (or Terra) on OpenRouter. The founder's "free tier" framing
  does not correspond to a $0-cost SKU — Luna is simply ~10x cheaper than Terra per token, not free.
- `-pro` variants exist for both and are priced identically to the base variants in this snapshot,
  so "5.6 luna" most plausibly means `openai/gpt-5.6-luna` (tested) with `-pro` as an untested,
  same-priced alternate; same logic for Terra.
- Tested `openai/gpt-5.6-luna` and `openai/gpt-5.6-terra` (the plain, non-"-pro" ids) as the closest
  match to "5.6 luna"/"5.6 terra".

## 2. Probes run

Both probes were run against both models (4 calls total), Thai-language, `temperature=0.9`,
`usage: {include: true}` for exact per-call cost from OpenRouter.

- **Probe A (hook gen — fast-tier workload):** 5 viral hooks (≤20 คำ each, no greetings, spoken
  Thai) for topic "การเงินสาย dark: กลโกงแชร์ลูกโซ่", JSON array of strings.
- **Probe B (full script — pro-tier workload):** ~240-word 60-second script, 1 line = 1 sentence,
  ปัญหา→ขยี้→ทางออก structure, closing CTA inviting comments, JSON `{body, cta}`.

## 3. Per-probe results

| Model | Probe | Latency | Prompt tok | Completion tok | Reasoning tok | Cost (actual, from `usage.cost`) | Valid JSON? | finish_reason |
|---|---|---|---|---|---|---|---|---|
| gpt-5.6-luna | A (hooks) | 3.61s | 152 | 220 | 65 | $0.0001472 | Yes — array of 5 strings | stop |
| gpt-5.6-luna | B (script) | 6.27s | 225 | 653 | 85 | $0.0004143 | Yes — `{body, cta}` | stop |
| gpt-5.6-terra | A (hooks) | 3.14s | 152 | 146 | 0 | $0.0010280 | Yes — array of 5 strings | stop |
| gpt-5.6-terra | B (script) | 8.81s | 225 | 582 | 103 | $0.0037170 | Yes — `{body, cta}` | stop |

No rate limits hit, no truncated/garbled output, no HTTP errors across all 4 calls.

## 4. Thai quality assessment

Grading scale 1-5 (5 = best). No garbled Thai or code-switching (English filler/loanwords beyond
normal register) observed in any of the 4 outputs.

| Model | Naturalness (spoken Thai) | Hook sharpness | Instruction compliance | Notes |
|---|---|---|---|---|
| gpt-5.6-luna | 4.5 | 4 | 5 | Hooks natural and punchy; script reads slightly more "informational/PSA" than edgy-viral, but structure and 1-line-1-sentence + JSON shape followed exactly. Body ≈1272 chars (≈240-260 Thai words by rough estimate) — close to the ~240-word target. |
| gpt-5.6-terra | 5 | 5 | 5 | Hooks use more specific, vivid framing ("เงินแสนหายไปในไม่กี่วัน", "กับดักแชร์ลูกโซ่ที่แต่งตัวดูน่าเชื่อถือ") — marginally sharper/more colorful than Luna. Body ≈1086 chars (≈200-220 words) — slightly under the ~240-word target but still in a reasonable range. |

Word-count caveat: Thai script has no spaces between words within a clause, so `str.split(" ")`
undercounts (it only splits at clause boundaries). Actual "≤20 คำ" compliance for the hooks was
verified by eye — every hook in both sets is a single short clause or two, clearly well under any
reasonable 20-word ceiling. Full-script word counts above are estimated from character count
(~5 chars/Thai word average), not exact.

### Full raw Thai outputs

**gpt-5.6-luna — Probe A (hooks):**
```json
["เงินก้อนแรกที่ได้ อาจไม่ใช่กำไร…แต่มาจากคนที่โดนหลอกต่อจากคุณ","ทำไมแชร์ลูกโซ่ถึงทำให้คนฉลาด กลายเป็นคนชวนเพื่อนตัวเองมาลงเงิน?","ถ้าเขาบอกว่าได้กำไรชัวร์ แค่ชวนคนต่อไป…หนีให้ไกล นี่อาจคือแชร์ลูกโซ่","เบื้องหลังผลตอบแทนสุดสวย อาจมีคนหนึ่งคนกำลังเสียเงินทั้งชีวิต","แชร์ลูกโซ่ไม่ได้เริ่มจากคำโกหก แต่มักเริ่มจากคำว่า “การันตีผลตอบแทน”"]
```

**gpt-5.6-luna — Probe B (script):**
```json
{"body":"เคยสงสัยไหมว่าทำไมแชร์ลูกโซ่ถึงยังหลอกคนได้ แม้ข่าวเตือนจะมีทุกวัน?\nปัญหาไม่ใช่แค่คนโลภ แต่คือกลโกงถูกออกแบบให้ดูเหมือนโอกาสทองที่พลาดไม่ได้.\nมิจฉาชีพมักเริ่มจากคำว่า “ลงทุนง่าย กำไรเร็ว ความเสี่ยงต่ำ” แล้วใช้ภาพรถหรู บ้านใหญ่ และชีวิตอิสระมาสร้างความน่าเชื่อถือ.\nจากนั้นพวกเขาจะชวนคนกลุ่มแรกให้โอนเงิน โดยอ้างว่าเป็นค่าสมัคร ค่าสินค้า หรือค่าลงทุนในธุรกิจลับ.\nช่วงแรกสมาชิกบางคนอาจได้เงินจริง แต่เงินนั้นมักไม่ได้มาจากกำไรของธุรกิจ.\nมันคือเงินของสมาชิกใหม่ที่ถูกนำมาจ่ายให้สมาชิกเก่า เพื่อสร้างภาพว่าระบบทำเงินได้จริง.\nเมื่อคนเริ่มเชื่อ พวกเขาจะเร่งให้ชวนเพื่อน ครอบครัว และคนรู้จักเข้ามาเพิ่ม.\nนี่คือจุดที่กับดักเริ่มปิด เพราะรายได้ของคุณไม่ได้ขึ้นอยู่กับสินค้าหรือบริการ แต่ขึ้นอยู่กับการหาคนใหม่.\nสัญญาณอันตรายคือการการันตีกำไร การเร่งให้ตัดสินใจ การปิดบังแหล่งรายได้ และการบอกว่าอย่าสงสัยหรืออย่าบอกคนนอก.\nถ้าถามว่าบริษัททำกำไรจากอะไรแล้วตอบไม่ชัด ให้หยุดก่อนโอนเงินทันที.\nตรวจสอบใบอนุญาต ชื่อบริษัท งบการเงิน สัญญา และเงื่อนไขถอนเงินจากแหล่งข้อมูลทางการ.\nอย่าเชื่อเพียงเพราะคนชวนเป็นเพื่อนหรือมีคนดังรับรอง เพราะภาพลักษณ์ไม่ใช่หลักฐานความถูกต้อง.\nถ้าโอนไปแล้ว ให้เก็บสลิป แชต ลิงก์ และข้อมูลบัญชีทั้งหมด แล้วรีบติดต่อธนาคารและแจ้งหน่วยงานที่เกี่ยวข้อง.\nจำไว้ว่า ผลตอบแทนสูงแบบการันตีไม่มีอยู่จริง และในแชร์ลูกโซ่ คนที่เข้าทีหลังมักเป็นคนรับภาระความเสียหายหนักที่สุด.","cta":"คุณเคยเจอกลโกงแบบไหน หรือมีสัญญาณอะไรที่ทำให้รู้ว่าเป็นแชร์ลูกโซ่ คอมเมนต์บอกกันไว้เพื่อเตือนคนอื่น"}
```

**gpt-5.6-terra — Probe A (hooks):**
```json
["เงินแสนหายไปในไม่กี่วัน เพราะเชื่อคำว่า “ลงทุนง่าย ได้กำไรไว”", "แชร์ลูกโซ่ไม่ได้หลอกคนโง่ แต่มันหลอกคนที่อยากเชื่อว่ารวยเร็วได้", "ถ้ามีคนบอกให้ชวนเพื่อนมาลงทุน ระวัง นั่นอาจไม่ใช่ธุรกิจ", "กำไรที่คุณได้ อาจไม่ใช่กำไรจากลงทุน แต่มาจากเงินคนที่เพิ่งโดนชวน", "ก่อนโอนเงินเข้ากลุ่มลงทุน ดูสัญญาณนี้ให้ทัน ไม่งั้นอาจถอนตัวไม่ทัน"]
```

**gpt-5.6-terra — Probe B (script):**
```json
{"body":"เคยเห็นคนรอบตัวโพสต์ว่า ลงเงินไม่กี่พัน แต่รับกำไรทุกวันไหม\nนั่นอาจไม่ใช่การลงทุน แต่มันคือกับดักแชร์ลูกโซ่ที่แต่งตัวดูน่าเชื่อถือ\nปัญหาคือคนส่วนใหญ่ไม่ได้โดนหลอกเพราะโลภอย่างเดียว\nแต่โดนหลอกด้วยคำว่า รายได้เสริม อิสรภาพทางการเงิน และโอกาสสำหรับคนวงใน\nช่วงแรกระบบมักจ่ายเงินจริงให้คุณเร็วมาก\nเพราะเงินที่จ่าย ไม่ได้มาจากกำไรของธุรกิจ แต่มาจากเงินของสมาชิกใหม่\nพอคุณได้เงินครั้งแรก คุณจะเริ่มเชื่อ เริ่มชวนเพื่อน และเริ่มลงเพิ่ม\nนี่คือจุดที่กลโกงมันมืดที่สุด เพราะเหยื่อถูกเปลี่ยนให้กลายเป็นคนดึงเหยื่อรายต่อไป\nพวกเขาจะเร่งคุณด้วยประโยคว่า เหลือสิทธิ์ไม่กี่ที่ หรือ ถ้าไม่รีบจะพลาดรอบทอง\nแต่ลองถามให้ชัดว่า บริษัททำกำไรจากสินค้า บริการ หรือธุรกิจอะไร\nถ้าคำตอบวกวน เน้นโบนัสจากการชวนคน และการันตีผลตอบแทนสูงผิดปกติ ให้ถอยทันที\nการลงทุนจริงมีความเสี่ยง และไม่มีใครรับประกันกำไรสูงสม่ำเสมอได้ง่าย ๆ\nก่อนโอนเงิน ตรวจชื่อบริษัท ใบอนุญาต และข้อมูลกับหน่วยงานที่เกี่ยวข้อง\nอย่าเชื่อเพียงรีวิวภาพถอนเงิน เพราะภาพสร้างได้ และยอดเงินอาจเป็นแค่เหยื่อล่อ\nถ้าเริ่มสงสัย อย่ารีบโอนเพิ่ม เก็บหลักฐานการแชต สลิป และชวนคนใกล้ตัวหยุดก่อน\nจำไว้ เงินที่ดูง่ายเกินจริง มักมีคนอีกหลายคนกำลังจ่ายราคาที่แพงกว่า","cta":"คุณเคยเจอคำชวนลงทุนแบบไหนที่ฟังแล้วเริ่มเอะใจบ้าง คอมเมนต์มาเตือนกันหน่อย"}
```

## 5. Cost vs. current Gemini anchors

Anchors as given (approximate, per the task): Gemini 2.5 Flash ≈ $0.30/M in + $2.50/M out;
gemini-pro-latest ≈ $1.25/M in + $10/M out.

| Comparison | Luna actual cost | Same tokens priced at Gemini Flash anchor | Terra actual cost | Same tokens priced at gemini-pro-latest anchor |
|---|---|---|---|---|
| Probe A (152 in / 220 or 146 out) | $0.0001472 | $0.0005956 | $0.0010280 | $0.0016500 |
| Probe B (225 in / 653 or 582 out) | $0.0004143 | $0.0017000 | $0.0037170 | $0.0061013 |
| **Sum (A+B)** | **$0.0005615** | **$0.0022956** | **$0.0047450** | **$0.0077513** |

At list pricing: Luna is $0.10/M in + $0.60/M out — roughly 3x cheaper on input and 4x cheaper on
output than Gemini 2.5 Flash. Terra is $1.00/M in + $6.00/M out — roughly on par on input and
~1.7x cheaper on output than gemini-pro-latest.

Both Luna and Terra returned nonzero `reasoning_tokens` on 3 of 4 calls (Luna: 65 and 85; Terra: 0
and 103) — these are billed as completion tokens and included in the costs above; they were not
separately requested via a `reasoning` param.

## 6. What this means (facts only)

- Exactly 4 OpenRouter model ids match "5.6 luna"/"5.6 terra" naming; no `:free` SKU exists for
  either, so "free tier" in the founder's framing is relative (Luna is ~10x cheaper per token than
  Terra), not literally $0.
- All 4 live calls (2 models × 2 Thai probes) returned HTTP 200, valid JSON matching the requested
  shape, and complete (non-truncated) responses — zero JSON-parse failures, zero garbled/code-switched
  Thai, zero rate-limit errors encountered in this run.
- Per-call actual cost (from OpenRouter's `usage.cost`, which reflects live billing, not list-price
  estimation) was lower than the equivalent token volume priced at the stated Gemini anchors for
  both models on both probes.
- Terra's Probe A used 0 reasoning tokens while Luna's Probe A used 65 — the two models are not
  behaving identically under the same prompt at `temperature=0.9`, which is visible in the price
  spread per call as well as subtle differences in hook phrasing.
- This test covered 1 topic, 1 temperature setting, and a single sample per (model, probe) pair —
  it is not a statistically robust sample; it establishes that both models are live-callable,
  return valid structured Thai output, and are cost-competitive with the stated Gemini anchors at
  the tested prompt sizes.
