# Upstream provenance

This clone-only worker was selectively extracted from the audited application
worker boundary. The application base is
`Aoacademy2025/AI_content_Mew_social@8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb`.
The team voice source is independently pinned to its only/default branch,
`Aoacademy2025/Hero-Voice-Ai/main@f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37`.
It is not a wholesale merge of either that FastAPI application or
`AI_content_Mew_social/origin/dev_waow`.

The control adapter derives its clone engine behavior from
`Aoacademy2025/Hero-Voice-Ai@565d0e62e1d4269099a4c3fba8a2ecef9167eeea`:
application-provided speech text, Thai/English segmentation, base-speed multiplier
1.4, three candidates, class temperature 0.8, guidance 2.5, maximum speaker-cosine
selection, and mono 24 kHz PCM16 output. Synthetic executable fixtures confirm
those boundaries. The source model API is pinned to
`k2-fsa/OmniVoice@346bb75330980a236540d61a0808d00767c0973b`.

The experimental Demucs and AudioSeal procedures come from their primary-source
pins in `MODEL_MANIFEST.json`, not from the comparison wrapper. Optional-stage
load or inference failure is terminal; no profile silently falls back to control.
The current Demucs commit's own metadata requires `torchaudio<2.1`, while the
pinned hardened base uses 2.6.0. The build applies the hash-pinned one-line
`demucs-torchaudio-2.4-compat.patch`, which removes only that stale metadata upper
bound; inference source stays at the exact upstream commit. Runnable
compatibility is not inferred from the patch: immutable-image import, offline
model loading, and real GPU/audio fixtures remain mandatory gates.

OmniVoice 0.1.5 declares Gradio for its interactive demo, but this clone-only
worker imports no demo or public-server surface. The build removes that single
METADATA requirement with exact before/after SHA-256 assertions and omits the
entire Gradio dependency graph so its bundled media assets never enter a worker
layer. Inference source remains unchanged.

RunPod SDK 1.12.0 declares FastAPI for its local/realtime API-server path, which
this queue-only worker never imports or enables. The SDK wheel is separately
hash-locked and installed without dependency resolution; an exact before/after
METADATA patch removes only that FastAPI requirement. Its complete non-FastAPI
serverless dependency closure remains in `requirements.lock`, and the release
environment fixes SDK logging at INFO so request/result payloads are not emitted
by DEBUG logging.

The latest team-source files used as design provenance are
`core/audio_enhance.py`, `core/server.py`, `core/text_utils.py`, and
`core/watermark.py`. Their enhancement, normalization, ranking, and watermark
hypotheses are reimplemented behind the exact contract and primary-source pins;
their fail-open fallbacks, mutable model lookup, public HTTP/storage surface,
stock/Lao assets, and unbounded request behavior are deliberately excluded.

Declared wrapper-level differences from audited v13 are required by contract v3:
an explicit 31-bit seed, exact-key commitment fields, the tighter approved 5–15 s
reference window (v13 accepted 3–15 s), clone-only loading, and versioned failure
envelopes. There is also one unresolved experiment-plan conflict: contract v3
peak-normalizes references to `0.95`; v13's pydub downmix/resample did not. The
control's speech segmentation, prompt API, effective-speed policy, candidate
count/temperature/guidance, full-precision maximum-cosine selection, and output
class are fixed to v13. Ranking now receives the same file-backed reference
domain as v13: final exported mono 24 kHz PCM16 frames decoded to float32; the
synthetic fixture covers that quantization path. The peak-policy conflict remains
the separately disclosed material mismatch, so end-to-end parity and paid
ablation remain blocked. These differences are not audio-quality evidence.

Excluded by design: `mode:"tts"`, stock and Lao voices/assets, FastAPI, Studio
HTML, previews, ASR, Gemini/network rewriting, voice design, emotion/age controls,
persistent voice libraries, authentication, credits, billing, and retry/fallback.
