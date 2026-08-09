# Brand Visual System — Gap Analysis and Implementation Plan

Date: 2026-08-09
Baseline: `origin/main` at `1d6cf486`
Product source: `docs/plans/2026-08-09-brand-visual-system-product-brief.md`
Architecture source: `docs/adr/0005-video-projects-pin-brand-profile-revisions.md`

## Guardrails

- Production access is read-only. No deploy, schema push, account mutation, or
  customer generation route is used during implementation.
- The existing shared Credit wallet remains the only paid currency. Hero AI
  Image remains 2 credits per generated image.
- Starter AI Image Allowance is an activation allowance of 8 images per shared
  30-day usage window, not a credit grant or a second paid wallet.
- V1 is text-free Z-Image only. Trend Packs, trend administration, reference
  images, LoRA/character conditioning, and model-rendered text are fast-follow.
- Existing dirty work is preserved by implementing in an isolated worktree
  based on the current production baseline.

## Evidence from the actual baseline

### Existing modules to deepen or reuse

- `BrandProfile` exists for Hero Script and currently stores writing identity
  only (`name`, `niche`, `audience`, `tone`, banned words, CTA style).
- Editor projects already persist a revisioned `draftJson`; video jobs already
  have stable idempotency keys and durable provider checkpoints.
- Hero AI Image already pins Z-Image, charges 2 credits per image, reserves
  before submission, settles/refunds failed work, retries provider polling, and
  reconciles stale reservations.
- The Credit module already drains Granted Credits before Purchased Credits and
  records an exact per-bucket ledger split for refunds.
- Stable cohort hashing, server telemetry, client telemetry, brand assets,
  subtitle presets, voice defaults, and Editor v2 rollout patterns already
  exist and should be reused.

### Read-only Mewsocial Brand Brief evidence

The production SQLite database was opened with `sqlite3 -readonly` and
`PRAGMA query_only=ON`; only aggregate `SELECT` statements were issued.

- Account: Mew Social (`duckyhero`), Business, ElevenLabs primary voice present.
- Writing `Style` rows: 0.
- Default brand mark: `Mew Social Logo-02.png`, high-contrast square asset,
  enabled as a top-right overlay.
- Recent completed-job configuration confirms Kanit, stroke, karaoke, and the
  `#38BDF8` accent. The logo stays in the deterministic brand-mark layer.

The benchmark Visual Brand Brief therefore uses high-contrast black/white,
`#38BDF8`, thick energetic rough linework, slight diagonal composition, clear
subtitle-safe space, and recurring sky-blue marker circles/arrows. It never
asks Z-Image to draw the logo or text.

## Gaps

| Area | Current baseline | V1 gap |
| --- | --- | --- |
| Visual qualification | Generic cinematic prompt path | Fixed 21-image gate, five qualified recipes, reviewed card assets |
| Domain model | Mutable writing-only BrandProfile | Draft, immutable Revision, active revision, visual brief, defaults, freeze state |
| Project reproducibility | Editor `draftJson` only | Project Look snapshot and pinned Brand Profile Revision |
| Content understanding | Keyword/scene prompt helpers | Cached Content Preflight and structured Visual Beats for all Narrative Sources |
| Prompting | Provider-oriented prompt fragments | One deep text-free compiler preserving creator-selected Visual Format/Brand Visual Language |
| Starter entitlement | One-time 10-credit trial taste grant | Eight-image allowance continuing Trial→Free inside the same usage window |
| Paid settlement | Credit reservation/refund exists | One settlement interface selecting allowance for unpaid and shared credits for paid |
| Brand workflow | Hero Script profile dialog | Full Brand Library, quick selection/create, Draft→Preview→publish Revision |
| Script edits/look changes | No visual staleness model | Explicit outdated-beat detection and explicit regenerate/continue-mixed decisions |
| Rollout | Paid public Hero flag | Internal + duckyhero + Free test, stable 10%/50% cohorts, canary metrics |
| Analytics | Generic image/telemetry events | Funnel, save/reuse/reroll, refund, COGS and cohort dimensions |

## Deep modules and seams

### 1. Brand Visual Compiler

Interface: compile a `VisualBeat` plus resolved project visual identity into a
provider-neutral, text-free image instruction and recipe version.

It hides format recipes, Brand Visual Language composition, content adaptation,
negative constraints, subtitle-safe composition, prompt normalization, and
model-specific wording. Tests and all callers cross this same seam.

### 2. Brand Profile Library

Interface: list/create draft, update draft, preview, publish, and resolve a
project snapshot. Publishing atomically creates one immutable Revision and
advances the active revision; merely editing or previewing never does.

It hides caps, downgrade freezing, revision numbering, legacy-default import,
and ownership checks. SQLite is local-substitutable in tests.

### 3. Content Preflight

Interface: resolve cached analysis for a Narrative Source and compare a new
source with existing Visual Beats. It returns structured beats and staleness;
it does not generate assets.

The managed text model is a true external dependency, injected through a small
port. Tests use an in-memory adapter; production uses the existing Gemini path.

### 4. AI Image Settlement

Interface: reserve a logical image batch, settle each durable image job, and
recover stale reservations. The caller does not choose a money implementation.

The implementation selects Starter AI Image Allowance for never-paid accounts
and the shared Credit wallet for paid accounts, records an idempotent reservation
per image, refunds exactly once, and exposes remaining allowance/credits.

## Phase plan

### Phase 0 — Quality Gate (must precede UI)

1. Encode five versioned Visual Format recipes and the fixed Hook/Explain/Close
   benchmark scenes.
2. Generate 15 vertical Z-Image outputs with identical scene briefs.
3. Generate Mewsocial vs unbranded-control stick-figure outputs for the same
   three scenes (6 outputs).
4. Inspect all 21 outputs for style recognition, within-style coherence,
   content/mood adaptation, scene compliance, and absence of text.
5. Iterate failed recipes; publish only passing images as card assets and retain
   prompts, seeds, provider IDs, hashes, timings, costs, and review results.

### Phase 1 — Persistence and domain interfaces

- Add additive migration/schema for visual drafts/revisions, project pins,
  preflight/beats, starter allowance reservations, and rollout analytics fields.
- Extend rather than replace the existing Hero Script BrandProfile identity.
- Add pure catalog/compiler and cap/freeze policies with red→green tests.

### Phase 2 — Backend and job resilience

- Add Brand Library/Draft/Revision and project-look HTTP interfaces.
- Add lazy Content Preflight for system scripts, creator scripts, and uploads.
- Route video and per-window generation through the compiler and unified
  settlement module.
- Add durable three-job preview batches, scene reroll, retry/reconcile, explicit
  stale-scene regeneration, and exact allowance/credit restoration.

### Phase 3 — Flags, analytics, and UX

- Add fail-closed stable rollout: duckyhero/Admin/test-Free, then 10%, 50%, 100%.
- Add Brand Library wizard and Editor Step 2 quick selection/Project Look.
- Use the qualified benchmark assets, Thai customer vocabulary `แนวภาพ`, and
  explicit cost/allowance disclosures. Do not expose raw prompts.
- Add responsive, keyboard, focus, loading, error, empty and reduced-motion states.

### Phase 4 — Verification

- Run migration against a disposable SQLite database and test legacy rows.
- Run seam-level unit/integration tests, existing Hero image/credit regressions,
  typecheck, lint, build, and local browser flows.
- Verify no production writes and no deployment occurred. Produce rollout/runbook
  evidence, but leave all feature flags off by default.
