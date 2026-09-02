# Brand Library & Style System — Map

Charted 2026-09-02 from the `/brands` review (`docs/audits/2026-09-02-brands-review.md`). One decision per session; each pass runs the normal pipeline (interview the delta → plan → execute) and appends one gist line below.

## Destination

`/brands` is the place a Faceless creator picks **one ชุดสไตล์** (Style Pack) and every clip they make afterwards — stock B-roll, AI images, subtitles, music, pacing, script tone — looks and sounds like the same channel, with no second style menu anywhere, no bug that misquotes credits or blocks a plan, and a catalog wide enough to cover Thai ghost stories, history, politics, dark stories, mystery, dharma, motivation, finance, news and health.

## Decisions so far

- One style system drives every B-roll source (stock, AI image, AutoMix) — ADR 0057.
- ชุดสไตล์ is a one-tap layer over the existing Visual Format × Treatment Preset axes, never a replacement — ADR 0058.
- Brand Library opens to every plan; only AI-image actions keep the paid/rollout gates — ADR 0059.
- V1 catalog = 12 packs in two waves (7 on existing treatments now, 5 on new treatments after qualification) — `docs/plans/2026-09-02-brands-wave1-style-packs.md` §Catalog.
- A pack also fixes pacing (ช้า / ปกติ / เร็ว) through existing hold/Ken Burns knobs; no new Remotion effects in V1 — wave-1 plan Task 5.
- Team feedback and prod numbers that drove the above — audit §1–§3.
- Render-time readers take the pack from the job's pinned project context first, then the Brand Revision recipe snapshot, never the live catalog — wave-1 plan Task 4 (`stockMoodForProject`, ADR 0005).
- A malformed Stock Mood in a request is ignored, never a 400: validation stays, renders fail open — wave-1 plan ruling R20.
- Content Preflight ranking rule re-balanced; measured 2026-09-03: `expert-clarity` first on 25 % of the fixture set (was 79 % of prod pins) — `docs/research/2026-09-03-content-preflight-distribution-benchmark.md`.

## Sessions (one decision each)

| Order | Plan | Status |
|---|---|---|
| 0 | `2026-09-02-brands-wave0-make-it-work.md` — existing feature works as promised (quote truth, access, Step-2 preferences, copy, dead code, CI) | approved, execution deferred to next session |
| 1 | `2026-09-02-brands-wave1-style-packs.md` — 7 packs, stock mood, pacing, music mood, editor pack picker, recommendation rebalance | executed 2026-09-03 on `mew/brands-wave1` (PR pending Mew review) |
| 2 | `2026-09-02-brands-wave2-new-treatments.md` — 5 new Treatment Presets + qualification benchmark + pack activation | drafted, approval pending (paid benchmark needs Mew's explicit go) |

## Not yet specified

- Pack sample images: who generates the 12 representative cards and from which fixture scenes (internal paid generation ≈ ฿0.175/image; needs Mew's go per ADR 0017 rule).
- Whether "คนและสถานที่" (region preference) moves into the Brand Profile or stays per-clip in Step 2 (wave-1 keeps it per-clip; revisit after telemetry).
- Motion effects per pack (zoom punch, hard cut, crossfade) — Q5 option B, fast-follow after wave 1 telemetry.
- Series Character / Character Identity Lock for recurring characters across clips (ADR 0011 leaves it future).
- Whether Hero Script should suggest a pack from the script topic before the creator reaches the editor.

## Out of scope

- AI video / 3D animation / motion-graphics looks (research looks #2, #7, #9, #12) — the still-image + stock pipeline cannot produce them; returns only if the Destination is redrawn around AI video.
- Replacing Z-Image or adding hidden quality retries (ADR 0023 stands).
- Reworking subtitle timing (ADR 0056 minefield) — packs select a subtitle *preset*, never timing.
- Hero Story Film / Grok lane (ADRs 0026–0055) — separate workflow.
