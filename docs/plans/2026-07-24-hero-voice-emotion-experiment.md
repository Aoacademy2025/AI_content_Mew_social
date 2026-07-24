# Hero Voice Emotion Experiment — Round 1 (rig + blind A/B pack)

Part of map: `docs/plans/2026-07-24-hero-voice-thai-quality-map.md`
Levers inventory (primary-source research): `docs/research/2026-07-24-omnivoice-emotion-prosody-levers.md`
Catalog data: `docs/audits/2026-07-23-hero-voice-catalog-quality-audit.{md,json}`

## Goal

Produce a blind A/B listening pack proving, per curated persona, an expressive Hero Voice
configuration (reference + inference params) that beats current production Hero on
emotion/naturalness without regressing Thai CER — judged by Mew + real customers.
Staging only. Zero production changes.

## Why these levers (from research doc)

OmniVoice has no emotion parameter, no SSML. The levers that exist:
1. **Reference audio dominates prosody in clone mode** (upstream: model "follows the style
   of the reference"). Current 48 refs are voice-design synthetics → likely flat source.
2. **`class_temperature` is 0.0 today = upstream-documented "greedy (deterministic)"** —
   an unused expressiveness knob. Current app/worker contract does not even expose it.
3. **13 fixed non-verbal tags** (`[laughter]`, `[sigh]`, interjections) — narrow, test on
   hook-style copy only.
4. **Chunking**: long-form regenerates every ~15 s against the same fixed ref; app chunk
   size (300 vs 700 chars) may shift prosodic continuity.

Fixed for all runs: 32 steps, Thai worker (v11 lineage), speed default.

## Hard constraints (every task)

- **Never call, patch, or deploy to production endpoint `txvrmtzfc8au3b`** or restart any
  prod process. No repo change may alter prod behavior (new scripts + `services/omnivoice-runpod`
  contract additions must be backward-compatible; default behavior identical).
- RunPod spend cap **$5** total; record prepaid balance before/after (pattern in
  `docs/audits/2026-07-22-omnivoice-runpod-audit.md`); leave endpoints scale-to-zero,
  workers `EXITED` after runs. Total jobs cap 700.
- Secrets: RunPod/Gemini keys read from local `.env` only; never committed, never logged.
- Audio artifacts land in `artifacts/hero-voice-ab-2026-07-24/` (ensure gitignored) — not
  in `docs/` or `assets/`.

## Eval scripts (fixed Thai copy — use verbatim in T4/T5/T6)

- **S1 hook (~15 s, energetic; the ONLY script where non-verbal tags variant is allowed):**
  «หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง»
- **S2 story + numbers/dates (~30 s):**
  «เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา»
- **S3 CTA + loanwords (~20 s):**
  «ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด»

## Tasks

### T1 — Persona shortlist proposal (data only, no code change)
From the catalog audit JSON: cluster the 48 voices (same cluster when Resemblyzer ≥ 0.86
or ECAPA ≥ 0.70), exclude voice_32/33/44 (falsetto/pathological, voiced fraction ≤ 0.21),
pick 1 representative per cluster preferring CER 0%, voiced ≥ 0.6, and spread across
gender/F0 bands. Target 12–16. Output `docs/research/2026-07-24-hero-voice-persona-shortlist.md`
+ machine-readable JSON list beside it. Mew confirms the final list while listening — do
not touch app catalog code.

### T2 — v12 staging worker + endpoint (contract: + class_temperature)
In `services/omnivoice-runpod`: accept optional `class_temperature` (validate against the
upstream-documented range; default 0.0 = exact current behavior), ensure bracketed
non-verbal tags pass through untouched, bump worker version string, extend
`test_contract.py`. Build amd64 image `staging-20260724-v12-temp-<sha>`, push to
`ghcr.io/mewic/heroai-omnivoice`, create a NEW staging template+endpoint via RunPod API
(min 0 / max 1, FlashBoot, idle 60 s, the nine-GPU pool from the v11 audit). Record
template/endpoint IDs in this file. Baseline invariant: temperature 0.0 on v12 must
reproduce v11 behavior (same refs, 32 steps) — that is the "current Hero" arm in the A/B.

**T2 status (2026-07-24): BLOCKED on ghcr push auth.** Contract/handler/tests done (25/25
`python3 -m unittest` pass); image built locally (`ghcr.io/mewic/heroai-omnivoice:staging-20260724-v12-temp-2ace232f`,
id `0b301dcd295d`) but `docker push` returns `unauthorized` — this machine's docker client has
no ghcr.io credentials (confirmed via `docker manifest inspect` on the existing v11 tag, also
unauthorized). Per task brief this is a hard stop, not self-remediated. No template/endpoint
created, no RunPod jobs spent. See `.superpowers/sdd/hv-emotion/task-2-report.md` for full detail.

### T3 — Expressiveness screening harness
New `scripts/screen-hero-voice-expressiveness.py` reusing `scripts/audit-hero-voice-catalog.py`
machinery: per WAV vs expected transcript → Thai CER (Whisper), F0 median + variability
(IQR), energy dynamic range, pause structure, duration sanity; outputs JSON + Markdown
ranking. Guard first (CER ≤ 5%), then rank by expressiveness composite. Pure functions
unit-tested with synthetic fixtures; no network.

### T4 — Gemini baseline clips
Render S1–S3 through the same managed Gemini TTS path production uses (male + female
default voices), key from local `.env` (if absent: stop and report, do not improvise).
Save WAVs + exact voice/params metadata into the artifacts dir.

### T5 — Candidate generation + matrix run (staging)
For each T1 persona, on the T2 endpoint, direct RunPod submission (extend
`scripts/benchmark-hero-voice-runpod.ts`):
1. **Ref hunting**: generate expressive reference candidates from an emotional ~8 s Thai
   ref-script (write one per persona archetype), two routes — (a) bootstrap: existing ref
   + temperature sweep {mid, high}; (b) voice-design instruct (gender/age/pitch only) +
   expressive script. ≤ 6 candidates/persona; screen with T3; keep top 2.
2. **Eval matrix**: top-2 refs × temperature {0.0, mid, high} on S1–S3; tags variant on S1
   only; chunk 300 vs 700 on S2 only. Screen everything; select per-persona winner config
   (CER guard then expressiveness).
Persist all WAVs + a run-manifest JSON (voice, ref hash, params, metrics, RunPod job id).
Respect job/spend caps; log dropped work if capped.

### T6 — Blind A/B pack assembly
`artifacts/hero-voice-ab-2026-07-24/`: per persona × script → shuffled anonymized arms
[winner Hero config, current Hero (v12 @ temp 0), Gemini baseline]; seeded randomization;
offline static `index.html` (audio players + per-trial form: naturalness 1–5 + pick one),
`answer-key.json` separate from the page; a customer-shareable subset zip (no answer key);
one-page Thai listening instructions for Mew.

## Execution Directive

| # | Task | Agent | Mode | Blocked by | Review gates |
|---|------|-------|------|-----------|--------------|
| 1 | Persona shortlist | mew-worker | subagent | — | mew-reviewer (data sanity vs audit JSON) |
| 2 | v12 worker + endpoint | mew-worker | subagent | — | build+unittest, mew-reviewer, /security-review (credentials + provider API) |
| 3 | Screening harness | mew-worker | subagent | — | unittest, mew-reviewer |
| 4 | Gemini baselines | mew-worker | subagent | — | mew-reviewer (params/metadata recorded) |
| 5 | Matrix run + selection | mew-worker | subagent | 1,2,3 | mew-reviewer (manifest complete, caps respected) |
| 6 | A/B pack | mew-worker | subagent | 4,5 | mew-reviewer + session final gate |

Eval-script + ref-script copy = session model (this plan); workers never invent copy.

## Acceptance Criteria

- [ ] Zero production changes: prod endpoint untouched (verified read-only via RunPod API), no prod deploy/restart/env change; `npm run verify:omnivoice` + `verify:hero-voice-ui` still pass unchanged.
- [ ] Shortlist: 12–16 personas, all CER ≤ 5%, one per similarity cluster, falsettos excluded.
- [ ] v12 endpoint live; temp-0 output contract-identical to v11 lineage; contract tests pass.
- [ ] ≥ 12 personas have a winner config beating their temp-0 baseline on expressiveness proxies with CER ≤ 5%.
- [ ] Pack opens offline, arms blinded, answer key separate, customer subset zip ready, Thai instructions included.
- [ ] RunPod spend ≤ $5 (balance before/after recorded), ≤ 700 jobs, workers EXITED.

## Out of scope (this round)

- Any prod rollout, default flip, allowlist removal, pricing/receipt change (map: blocked by listening gate).
- Hired human recordings (escalation path only after gate fails).
- App-side normalization changes and the waveform-panel UI ticket.

## Status

interviewed 2026-07-24 | approved: 2026-07-24 (execute) | executed: in-progress | delivered: -
