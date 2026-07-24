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
- Round 1 execute = **experiment rig + blind A/B listening pack, staging only, zero prod changes** — plan: `docs/plans/2026-07-24-hero-voice-emotion-experiment.md`.

## Not yet specified

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
