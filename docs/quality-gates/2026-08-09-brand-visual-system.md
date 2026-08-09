# Brand Visual System V1 — 21-image Quality Gate

Date: 2026-08-09
Model: Z-Image Turbo (`z-image-turbo`)
Candidate recipe: `*-v1`, attempt 3
Result: **PASS — UI asset promotion allowed**

## Production-data guard

Mewsocial evidence was read from production with `sqlite3 -readonly` and
`PRAGMA query_only=ON`. Every statement was an aggregate `SELECT`; no customer
generation route, credit ledger, allowance, project, or profile was written.

Observed for `duckyhero`: Mew Social Business account, ElevenLabs primary voice,
zero legacy Writing Style rows, default `Mew Social Logo-02.png` overlay, and
recent render configuration using Kanit + stroke + karaoke + `#38BDF8`.

The benchmark Visual Brand Brief used black/warm-white/`#38BDF8`, thick rough
marker lines, energetic diagonal composition, subtitle-safe space, and recurring
blue marker circles/arrows. The actual logo remained outside the image prompt.

## Fixed matrix

Every format and brand variant received the same three Visual Beats and seed per
beat: mysterious Thai-history Hook, physician/data Explain, and bright
finance/commerce Close.

| Benchmark | Variant | Hook | Explain | Close |
| --- | --- | --- | --- | --- |
| Visual Format | ภาพสมจริงแบบหนัง | PASS | PASS | PASS |
| Visual Format | ก้างปลาเล่าเรื่อง | PASS | PASS | PASS |
| Visual Format | คอมิกเข้มข้น | PASS | PASS | PASS |
| Visual Format | อินโฟกราฟิกเข้าใจง่าย | PASS | PASS | PASS |
| Visual Format | เล่าเรื่องย้อนยุค | PASS | PASS | PASS |
| Brand Differentiation | Mewsocial | PASS | PASS | PASS |
| Brand Differentiation | unbranded control | PASS | PASS | PASS |

Total: **21/21 PASS**.

## Review criteria

- Recognition: cinematic photography, tactile stick-figure marker art, inked
  comic, diagrammatic vector illustration, and mid-century print are visually
  separable without card labels.
- Consistency: each format keeps line/material/palette/composition grammar across
  all three scenes.
- Adaptation: history reads mysterious, medicine reads professional, and the
  commerce close reads optimistic while preserving the selected format.
- Scene compliance: doorway/relic, doctor/heart/health states, and parcel/rising
  discs are present in their respective beats.
- Brand differentiation: Mewsocial keeps carbon black, warm paper white, thick
  raw linework and sky-blue marker circles/arrows; control stays neutral/sepia
  and omits the blue motif.
- Text-free: manual inspection found no readable words, labels, logos or
  watermarks. Tesseract English OCR returned no recognized strings for all 21
  full-resolution candidates. Abstract lines/shapes remain allowed visual marks.
- Layering: no candidate asks the model to draw the Mewsocial logo; subtitle and
  brand-mark layers remain deterministic overlays.

## Iteration evidence

- Attempt 1 failed: positive guard copy was painted into most outputs and
  stick-figure scenes mixed photographic backgrounds.
- Attempt 2 fixed readable copy and separated Mewsocial from control, but
  Explain/Close sometimes became multi-event layouts.
- Attempt 3 changed the compiler to positive visual grammar only and constrained
  every beat to subjects sharing one ground plane in one frozen moment.

The failed attempts were not promoted.

## Operational evidence

- Candidate outputs: 21 completed, 0 provider failures, 720×1280 each.
- Candidate provider cost: $0.105 total ($0.005/image).
- Provider delay: P50 104 ms, P95 2,355 ms.
- Provider execution: P50 7,858 ms, P95 9,702 ms.
- Full manifest, prompts, provider job IDs, image hashes and source PNGs are kept
  in the local ignored artifact directory
  `artifacts/brand-visual-quality-gate/2026-08-09/attempt-3/`.

## Promoted card assets

The five Hook candidates use the same scene and seed, so differences shown on
the picker come from Visual Format rather than subject matter. They are promoted
to `public/brand-visual-formats/` as reviewed WebP assets; opening the picker
never regenerates them.
