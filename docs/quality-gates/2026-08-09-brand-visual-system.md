# Brand Visual System V1 — 21-image Quality Gate

Reviewed: 2026-08-10 (Asia/Bangkok)
Model: Z-Image Turbo (`z-image-turbo`)
Candidate recipe: `*-v2`
Compiler contract: `brand-visual-v1-provider-input-v2`
Compiler hash: `2f6c630aca7bec0d02fbaecd1cb93830b0de6295ceed51ec0ac9a1df36873c46`
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
  comic, diagrammatic vector illustration, and mid-century gouache/cel art are visually
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
- Text-free: full-resolution manual inspection found no readable words, labels,
  currency glyphs, logos, signatures or watermarks. Tesseract English OCR was
  used as a secondary triage signal; its detections were non-coherent fragments
  from temple/paper/ink texture rather than readable copy. Abstract lines and
  non-linguistic architectural motifs remain allowed visual marks.
- Layering: no candidate asks the model to draw the Mewsocial logo; subtitle and
  brand-mark layers remain deterministic overlays.

## Iteration evidence

- Attempt 1 failed: positive guard copy was painted into most outputs and
  stick-figure scenes mixed photographic backgrounds.
- Attempt 2 fixed readable copy and separated Mewsocial from control, but
  Explain/Close sometimes became multi-event layouts.
- Attempt 3 changed the original `*-v1` compiler to positive visual grammar and
  constrained every beat to subjects sharing one ground plane in one frozen
  moment. That reviewed contract remains available byte-for-byte for persisted
  `*-v1` Revision pins.
- The first `*-v2` qualification exposed simulated print signatures, a dollar
  glyph and pseudo-text in framed UI. Those candidates failed and were not
  promoted. The final `*-v2` compiler uses explicit empty solid fields for
  frames/screens, unmarked rings/discs, stronger no-copy negatives, and a
  full-bleed gouache/cel Retro recipe. The complete matrix was regenerated and
  reviewed after those material changes.

The failed attempts were not promoted.

## Operational evidence

- Candidate outputs: 21 completed, 0 provider failures, 720×1280 each.
- Candidate provider cost: $0.105 total ($0.005/image).
- Provider delay: P50 122 ms, P95 4,957 ms.
- Provider execution: P50 7,204 ms, P95 8,752 ms.
- Full manifest, prompts, provider job IDs, image hashes and source PNGs are kept
  in the local ignored artifact directory
  `artifacts/brand-visual-quality-gate/2026-08-09/`. The manifest has 21
  provider-complete entries and 21 hash-bound `reviewDecision: pass` entries.
- Current review sheets are
  `v2-visual-format-contact-sheet.png` and
  `v2-brand-differentiation-contact-sheet.png` in that directory.

## Promoted card assets

The five Hook candidates use the same scene and seed, so differences shown on
the picker come from Visual Format rather than subject matter. They are promoted
to `public/brand-visual-formats/` as reviewed WebP assets; opening the picker
never regenerates them.

| Picker asset | Reviewed WebP SHA-256 |
| --- | --- |
| `cinematic-realism.webp` | `0b0378e8d0777b1141db72a0c13bfebb1fd2da072e3d4a3c79df352dc5192fbe` |
| `stick-figure-story.webp` | `f7493d8140e7f4c159dcf2feefb50e9235f106c4e6e8a3564943d4fe391a5ad2` |
| `dramatic-comic.webp` | `4602246ffd929c01b0ffbdd13aa6ca327daf8af6d5744ce4a5159d872dd71b06` |
| `clear-infographic.webp` | `58616ca43e6a08cf649d219d51472fbf4ef60f85510c78376fad7056d481d4e5` |
| `retro-story.webp` | `8b346a81ee09395363a14184e1cbb0bdca6a7d315e822345e47fafcd4f9ab554` |
