# Hero Voice Thai Quality — Map (wayfinder-lite)

Status: active · Started 2026-07-24

## Destination

Hero AI Voice is the system's primary voice: default provider for all users, Thai output
that wins a blind A/B against current Hero on emotion/naturalness and is not embarrassed
next to Gemini, and priced cheaper to the customer than Gemini. Origin: PRO customer
complaint 2026-07-24 "ยังแปลกๆ พูดไม่มีอารมณ์" + Mew's directive to make Hero the main voice.

## Decisions so far (2026-07-24 interview)

- Quality target = **emotion/naturalness first** (pronunciation is contained: 32 steps + normalizer, CER ~0–2%) — this map.
- Model strategy = **squeeze OmniVoice first**; no parallel model evaluation this round. Levers inventory: `docs/research/2026-07-24-omnivoice-emotion-prosody-levers.md`.
- Catalog = **curate down to ~12–20 genuinely distinct voices** (audit found large near-duplicate clusters + broken falsettos) — dedupe data in `docs/audits/2026-07-23-hero-voice-catalog-quality-audit.{md,json}`.
- References = **synthesize expressive refs first**; escalate to hired human recordings only if human listening fails.
- Quality gate = **blind A/B (new Hero / current Hero / Gemini), Mew decides + real customers listen**. No prod change passes without it.
- Rollout = after gate passes: remove beta allowlist, **default = Hero Voice for everyone**; Gemini/ElevenLabs stay selectable; in-flight jobs never switch provider (per v11 pin invariant).
- Pricing = **Hero included in plan minutes / Gemini TTS gets a small credit surcharge after the default flip** (amount TBD from real cost data); disclosed on Render Receipt. Today all providers cost identical minutes — fact base: no voice line in `receipt.ts`, no TTS key in `credit-costs.ts`.
- Round 1 execute = **experiment rig + blind A/B listening pack, staging only, zero prod changes** — plan: `docs/plans/2026-07-24-hero-voice-emotion-experiment.md`. **EXECUTED 2026-07-25 overnight**: 16-persona curated shortlist (independence-verified), worker v13 (`class_temperature` + clone-from-payload) on experiment endpoint `d66lniwmhsjt51`, 531 RunPod jobs ≈ $0.50 total, 16/16 winner configs, blind pack at `artifacts/hero-voice-ab-2026-07-24/pack/index.html` — **awaiting Mew's listening verdict**.
- Round-1 empirical findings (2026-07-25): temperature helps only ≤1.0 (t=2 never won); expressive-ref bootstrap works (payload-ref cloning live); S2 digit garbling was a rig artifact — prod normalizer cuts real S2 CER 23.66%→6.71%; residual S3 loanword weakness ~8.5% CER persists (future lexicon work); chunking 300-vs-700 null (S2 too short to split — retest with longer copy if it matters).

## Not yet specified

- Mew's blind-listening verdict (round-1 gate) — decides: persona keep-list, winner-ref adoption, whether to escalate to hired recordings.
- RunPod worker quota housekeeping: account capped at 5 workers; staging v8 `xl6hhpijenyj3e` parked at workersMax 0 (Mew-ratified) to make room for the experiment endpoint — decide end-state (raise quota / tear down experiment endpoint after adoption / leave).

- Final persona list + names/labels (Mew picks while listening to the A/B pack).
- Gemini surcharge amount (needs per-minute Gemini TTS cost measurement).
- Marketing copy change: "แนะนำ · 48 เสียง" label must change once catalog is curated.
- Escalation trigger detail: which personas (if any) go to hired recordings after round 1.
- Whether winning inference config (temperature/tags/chunking) needs a v12 production worker image or app-side change only.
- /updates post + customer reply to bunchar once quality ships.

## Out of scope

- Evaluating/porting other Thai TTS models (revisit only if OmniVoice squeeze fails the gate).
- ElevenLabs pricing/behavior changes (BYOK stays as-is).
- Support ticket "ย้ายพาแนลเวฟเสียงพูดมาข้างสุด" — separate small UI task, not voice quality; ticket stays open for a normal off-ramp fix.
