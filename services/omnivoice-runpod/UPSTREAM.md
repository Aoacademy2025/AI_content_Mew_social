# Upstream provenance

This module replaces the original HERO AI OmniVoice RunPod worker with the completed
Hero-Voice-Ai implementation from:

- Repository: `https://github.com/Aoacademy2025/Hero-Voice-Ai.git`
- Imported commit: `565d0e62e1d4269099a4c3fba8a2ecef9167eeea`
- Imported on: 2026-08-24

The FastAPI engine, language splitting, voice cloning, similarity selection, voice
library, stock catalog, and 48 reference WAV files originate from that commit. The
RunPod contract, pinned container build, privacy-safe logging, payload limits, and
application adapter are maintained in this repository because HERO AI Creator Studio
owns authentication, quotas, durable jobs, cancellation, billing, and media retention.

## Follow-up sync

- Merged commit: `f00358da80d93b706b7d521ce52b9e05bdafd8e3`
  ("Add Thai text normalization, faster ASR, and audio watermarking")
- Merged on: 2026-08-26

Brought in: English→Thai transliteration before TTS (`text_utils.transliterate_english`,
curated dict + bundled wannaphong dictionary in `data/en_th_transliteration.tsv`,
optional Gemini API fallback via `gemini_translit.py`), Thai number/currency/phone
normalization (`text_utils.normalize_thai_numbers`, uses `pythainlp`), Lao script
detection in `split_by_language`, faster ASR via `asr_engine.py` (faster-whisper),
and AudioSeal audio watermarking (`watermark.py`) applied to every generated clip.
Exposed on the RunPod contract as `transliterate_english` / `normalize_numbers`
request fields (default `true` for both) — see `contract.py` and `handler.py`.
`num_step` default raised 24 → 32 to match `build_voices.py` and the model default.

## Follow-up sync 2

- Merged commit: `10649b5` ("Remove emotion feature, add Lao voices 5-7, sync API docs")
- Merged on: 2026-09-02

Brought in: Lao stock voices `lao_01..lao_07` (`assets/voices_lao/` → `/app/voices_lao`,
loaded via `_load_extra_manifest`; listed only with `/voices?language=lao`), the main
voice catalog trimmed 48 → 33 (foreign-accent + whisper voices removed — manifest now
uses Thai person names for `desc`, `preview_text` dropped since previews stream the ref
WAV directly), audio enhancement via Demucs (`audio_enhance.py`, `/enhance` endpoint,
`enhance_ref` param on `/clone` + `/voices`; lazy-loaded, fail-safe without demucs),
`class_temperature` request param (engine default now `TTS_CLASS_TEMPERATURE`=0.4
instead of greedy decoding — fixes flat/robotic tone), and removal of the IndexTTS
emotion feature. Exposed on the RunPod contract as optional `class_temperature`
(0.0–2.0) — see `contract.py` and `handler.py`.
