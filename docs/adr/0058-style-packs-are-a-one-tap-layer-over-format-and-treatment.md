---
status: accepted
---

# Style Packs are a one-tap layer over Visual Format × Treatment

Date: 2026-09-02

The two-axis model (5 Visual Formats × 8 Treatment Presets) is technically sound — versioned recipes, immutable pins, a qualification benchmark — but creators experience it as 40 pairs plus a second stock-style menu, and on production the Adaptive default collapsed onto one preset (`expert-clarity` = 79 % of pins, 74 % of recommendations; `locked` never used; Brand Look Preview used by 2 customers). Team feedback: "ใช้งานยาก, ภาพ/โทนมีไม่เยอะ". The glossary already reserved the concept (Trend Pack) but nothing was built.

**Decision.** A **ชุดสไตล์ (Style Pack)** is a curated, versioned, one-tap visual outcome. Selecting one on a Brand Profile resolves — through the *existing* fields — to: `primaryVisualFormatId`, `treatmentPolicy: "locked"`, `lockedTreatmentPresetId`, a Stock Mood (ADR 0057), a Pacing level, a default subtitle preset config, a music mood and a Hero Script tone seed. The revision payload records `stylePackId` + `stylePackVersion` and the revision snapshot stores the resolved recipe (ADR 0005 pinning applies; a catalog change never alters an existing revision or project). The two axes remain available under "กำหนดเอง" (advanced), and "ให้ AI เลือกตามเนื้อหา" (Adaptive) remains the option for creators who do not want a fixed look. A pack can also be chosen per clip as a Project Look and promoted to the Brand Library through the existing path.

Packs are the **only** customer-facing style vocabulary: creators see pack names (`หนังผีไทย`, `คดีดัง / เรื่องเล่าดาร์ก`, …), never Format, Treatment, Preset, Pin or Trend Pack. A pack whose Treatment Preset has not passed the Treatment Qualification Benchmark (ADR 0010) is stored in the catalog with `status: "pending-benchmark"` and is not selectable.

**Considered options.** (A) Keep the two-axis UI and add treatments — cheapest, but leaves the "choose twice, guess which pair" problem and the second stock menu. (C) Collapse to one axis and drop Visual Format — simplest UI, but every pin, recipe version and benchmark would need re-deriving and ADR 0005 reproducibility would break. (B) was chosen because it keeps the tested machinery and gives the one-click experience the glossary already promised.

**Consequences.** The catalog module is the single place a look is defined; adding a look is a catalog entry + qualification, not a UI change. First-pass Visual Acceptance and pin telemetry are segmented by `stylePackId` in addition to Treatment Preset. The Step-2 stock-style menu is removed (ADR 0057). The term "Trend Pack" is retired in favour of ชุดสไตล์ / Style Pack.
