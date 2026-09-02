---
status: accepted
---

# One style system drives every B-roll source

Date: 2026-09-02

Until now the Brand Visual Language, Visual Format and Treatment Pin reached only Hero AI Image prompt compilation (`resolveProjectVisualPromptForVideoScene`). Stock B-roll — the source almost every FREE, trial and many paid creators actually render with — had its own unrelated style vocabulary (`brollVisualStyle`: auto/documentary/cinematic/business/lifestyle/tech/minimal/surreal) chosen per clip in Step 2, plus a per-script mood the keyword LLM invented on its own. A `หนังผีไทย` brand therefore rendered horror AI frames intercut with bright, generic stock, and creators had to set style in two places that did not talk to each other. ADR 0006 and ADR 0010 explicitly excluded Stock from the visual-language promise; on production (2026-09-02) 93 % of projects left the Step-2 style on auto and the team reported the panel "does not work".

**Decision.** The Brand Profile's selected look (Visual Format + Treatment Preset, expressed to creators as ชุดสไตล์ — ADR 0058) is the single source of style for **every** B-roll source of a project: Hero AI Image prompts, AutoMix AI slots, and stock search. For stock it is applied as a **Stock Mood**: a small, versioned set of query tokens, positive/avoid concepts, a visual-direction sentence and fallback queries that flow through the existing `broll-preferences` plumbing into `extract-keywords`, `fetch-stock` ranking, the per-window search, and the managed-stock cache key. The separate Step-2 style menu is removed; the region preference ("คนและสถานที่") stays because it qualifies *who and where*, not style.

Stock Mood may steer search wording, ranking and fallbacks; it may never add people, props or places the script does not imply (the existing region guardrails apply), and it never blocks a render — a mood that finds nothing degrades exactly as a dead provider does today.

**Consequences.** "Visual Brand Coverage" no longer means Stock-only output makes no promise: Stock now carries the brand's *mood* while AI images carry the full visual language; copy must not promise that stock footage matches palette or texture. Existing Brand Profile Revisions gain a Stock Mood at their next publish (the revision snapshot carries the resolved mood so ADR 0005 pinning still holds). The managed-stock 24 h cache is partitioned by mood and region, so identical queries for different looks are cached separately (Pixabay's retention requirement is unchanged). ADR 0006's "controls rendering, not scene" rule is unchanged: mood tokens are rendering words (night, desaturated, archival), never subjects.
