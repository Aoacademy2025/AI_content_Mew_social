# RunPod custom-endpoint real billing — Hero AI Image COGS verification (2026-08-07)

Pulled read-only via RunPod GraphQL API (`myself.billing(input:{granularity: DAILY}).serverless`)
using the local `RUNPOD_API_KEY`. Purpose: close the P0-2 gap in
`docs/audits/2026-08-07-hero-ai-image-public-launch-readiness.md` (custom route had zero
provider-reported cost in the app DB).

## Raw account serverless billing (2026-07-21 → 2026-08-07, entire beta window)

Total serverless spend: **$7.1190 / 23,896 billed GPU-seconds** across all endpoints.
Per-endpoint filtering is not exposed by the API; rows carry `gpuTypeId`, which separates
the products cleanly:

| GPU class | Product attribution | Spend | Billed seconds | Rate |
|---|---|---|---|---|
| RTX A4000 / A4500 | OmniVoice (voice endpoints prefer this class) | $1.557 | 9,657 s | ~$0.000161/s |
| NVIDIA A40 | z-image endpoints (staging + production-v3) | $3.842 | 11,331 s | $0.000339/s |
| NVIDIA L40S | z-image endpoints | $0.868 | 1,782 s | ~$0.000487/s |
| A100-SXM4-80GB (07-22 only) | z-image staging | $0.851 | 1,126 s | $0.000756/s |
| **Image-class subtotal** | | **$5.562** | **14,239 s** | blended $0.00039/s |

Daily detail in scratchpad pull (A40/L40S rows run daily 07-29 → 08-07, matching
`heroai-z-image-turbo-production-v3` created 07-29 with workersStandby=1, idleTimeout 5).

## Cost per custom-route image

- Custom-route image jobs in app DB (same window): **1,069** (`prod-stats` §1).
- **All-in COGS ≈ $5.562 / 1,069 = $0.0052/รูป ≈ ฿0.19** (36 THB/USD) — includes idle,
  cold-start, standby and retry overhead (billed seconds = 2.08× the 6.4 s avg execution,
  so the overhead is already inside the number).
- **Absolute ceiling** (attributing ALL serverless spend incl. voice to images):
  $7.119 / 1,069 = $0.0067 ≈ **฿0.24/รูป**.
- Compare: public route real reported cost = $0.005 = ฿0.18/รูป flat (`prod-stats` §5) —
  the custom endpoint lands essentially at parity.

## Decision consequence (เกณฑ์จาก audit rev.2)

เกณฑ์ที่ล็อกไว้: ต้นทุนจริง ≤ ฿0.7/รูป → เลือก Option B (ลดราคาเป็น 2cr/รูป).
**ผล: ฿0.19 (เพดาน ฿0.24) — ผ่านเกณฑ์ขาด.** Margin ที่ 2cr = ฿2/฿0.19 ≈ **×10.5**
(เพดานแย่สุด ×8.3); ที่ 3cr ≈ ×16.

## Caveats

- Attribution is by GPU class, not endpoint id (API limitation). Voice endpoints list A40
  in their GPU *fallback* set, so a minority of A40 seconds could be voice — that would make
  the image figure LOWER, never higher; the ฿0.24 ceiling already covers the worst case.
- Public-route per-request fees (506 × $0.005 = $2.53) do not appear in these GPU-second
  rows; they are billed as public-endpoint requests and do not affect custom-route math.
- Window covers the entire image beta (07-21 → 08-07); at public volume the fixed overhead
  (standby/cold-start) amortizes over more images, so cost/รูป should fall further, not rise.
- Account snapshot at pull time: clientBalance $24.90, spendLimit $80, currentSpendPerHr 0.
