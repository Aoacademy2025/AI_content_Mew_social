# Map: Script-First Creation Funnel

> Wayfinder map — one decision resolved per session. Index, not store: gist + pointer only.

## Destination

Every HERO subscriber starts their video *inside* the Studio: they write a viral script with **Hero Script**, send it to the editor in one click, and (after AI image gen launches) every generated visual carries their brand's mood & tone plus their Logo Overlay. The effort is done when the write → edit → brand-personalized-visuals loop ships end-to-end and drives editing volume.

## Decisions so far

- 2026-07-31 — **Hero Script v1 fully spec'd** (short-form Thai-first, hook-first flow, framework engine + structured BrandProfile, Niche Drill-down, profile caps FREE 1/PRO 5/BUSINESS ∞, continuity-aware idea gen, new page + 1-click handoff, subscription-included billing, flash/pro model split, name "Hero Script") — see `docs/plans/2026-07-31-hero-script-v1.md`
- 2026-07-31 — TubeMagic teardown (features, flow, single-tier pricing + premium-credit upsell, gaps: no Thai, no video, no persistent brand profile) — see `docs/research/2026-07-31-tubemagic-script-writing.md`

## Not yet specified

- **Personalized image-gen prompts** — extend BrandProfile with visual fields (mood, palette, visual style) and inject into Hero AI Image / b-roll AI-gen prompt building so outputs match each brand's look. Blocked on: AI image gen launch learnings. (This is the phase Mew named for right after image-gen launch.)
- **Reference-clip analysis** — "ถอดแบบจากคลิปไวรัลจริง": ingest a viral clip URL/transcript, extract its structure, write ours in that shape. Needs transcript-ingest infra + plagiarism guardrails.
- **Trend-based idea research** — upgrade the light idea generator AND the Niche Drill-down (v1 = LLM-knowledge-only) to real market signals (trending clips, underserved niches, competitor gaps). Needs external data source decision.
- **Premium-model upsell** — if pro-model COGS ever bites, TubeMagic-style "premium model credits" is the fallback packaging (research doc has the mechanics).
- **Hero Script launch marketing** — /updates post + sale-page section once v1 ships.

## Out of scope

- YouTube metadata suite (titles/descriptions/tags/SEO) — TubeMagic's turf; our wedge is script → finished video, not channel tooling.
- Long-form scripts beyond plan duration caps — render pipeline can't consume them; revisit only if the Destination is redrawn.
- Team collaboration / content calendar — solo-creator product for now.
- Chat-refine interface — hook-first + per-section regenerate replaces it deliberately (cost + UX decision, Q6).
