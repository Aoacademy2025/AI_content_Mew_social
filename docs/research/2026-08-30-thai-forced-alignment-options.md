# Thai Forced Alignment Options — Research (2026-08-30)

Goal: deterministic forced alignment of a **known** Thai script to TTS audio (word/syllable onset
times), CPU-only, ~10-20% of audio duration, clips 30s-6min. Primary sources only.

## 1. ctc-forced-aligner (MahmoudAshraf97) + torchaudio `forced_align` / MMS_FA

- **Thai support:** Partial/indirect. The tool is not Thai-specific — it romanizes *any* script
  via `uroman` before aligning with Meta's MMS acoustic model, which was fine-tuned across
  1000+ languages incl. Thai (`tha` appears in the 1162-language list on the
  [`facebook/mms-1b-all` model card](https://huggingface.co/facebook/mms-1b-all)). uroman's own
  changelog explicitly claims "significantly improved support for Thai" in v1.3.1
  ([isi-nlp/uroman](https://github.com/isi-nlp/uroman)), but neither uroman nor the aligner repo
  publishes Thai-specific alignment accuracy — no CER/WER-of-alignment number found.
- **CPU throughput:** No published number in the repo or PyPI page. The repo claims "at least 5x
  less memory usage" vs. torchaudio's own API, but gives no wall-clock/RTF figures
  ([GitHub README](https://github.com/MahmoudAshraf97/ctc-forced-aligner)). **Unknown — no
  published number found.**
- **Install footprint:** PyPI now offers a **CPU + ONNXRuntime** install path (`pip install
  ctc_forced_aligner`) as well as `[torch]`/`[gpu]`/`[all]` extras
  ([PyPI](https://pypi.org/project/ctc-forced-aligner/)) — the ONNX path avoids the ~200MB
  torch-CPU wheel that a straight `pip install torch` (CPU index) otherwise pulls in.
- **Integration path:** Python-only CLI/library; from Next.js this must run as a shelled-out
  subprocess or a small sidecar service (FastAPI/CLI) — no Node port exists.
- **License:** Aligner code is **BSD**; the *default* model
  (`MahmoudAshraf/mms-300m-1130-forced-aligner`) is **CC-BY-NC 4.0** — non-commercial, so a
  commercial SaaS would need a different/self-fine-tuned model
  ([GitHub README](https://github.com/MahmoudAshraf97/ctc-forced-aligner)). `facebook/mms-1b-all`
  itself is also CC-BY-NC 4.0.
- **Maintenance:** Active — last push 2026-07-12 (GitHub API `pushed_at`).
- **Gotchas:** torchaudio's own `forced_align`/MMS_FA tutorial APIs are **deprecated as of
  torch 2.8 and slated for removal in 2.9**, consolidating into TorchCodec
  ([docs.pytorch.org tutorial](https://docs.pytorch.org/audio/stable/tutorials/forced_alignment_for_multilingual_data_tutorial.html))
  — pin torch version or use the standalone `ctc-forced-aligner` package instead of torchaudio's
  native API to avoid near-term breakage. Also: alignment happens on **romanized** text, so
  reported onset times are per-romanized-token, not per-Thai-grapheme; mapping back to original
  Thai character spans needs uroman's alignment output (it does provide source-char offsets).

## 2. WhisperX alignment step

- **Thai support: No.** The source (`whisperx/alignment.py`) hardcodes two dicts:
  `DEFAULT_ALIGN_MODELS_TORCH` = `{en, fr, de, es, it}` and `DEFAULT_ALIGN_MODELS_HF` covering 31
  more languages (ja, zh, nl, uk, pt, ar, cs, ru, pl, hu, fi, fa, el, tr, da, he, vi, ko, ur, te,
  hi, ca, ml, no, nn, sk, sl, hr, ro, eu, gl, ka, lv, tl, sv, id) — **Thai (`th`) is absent from
  both** ([source, m-bain/whisperX](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py)).
- **Fallback for unsupported languages:** WhisperX does **not** silently degrade — it raises
  `ValueError("No default align-model for language: {code}")` and requires the caller to pass a
  Hugging Face wav2vec2 CTC checkpoint via `--align_model`
  ([same source]). This means WhisperX's Thai path is entirely a manual pairing with a
  community model (see §3) — WhisperX itself supplies no Thai alignment model or config.
- **CPU throughput:** No published CPU-specific benchmark; project targets GPU (README speaks in
  GPU-memory terms, e.g. "<8GB for large-v2").
- **License:** BSD-2-Clause.
- **Maintenance:** Active — last push 2026-07-13, latest tagged release `v3.8.6` (2026-05-25),
  per GitHub API.
- **Integration path:** Python-only; Node app would shell out / run a sidecar.
- **Verdict:** WhisperX is not itself a Thai solution — at best it's a harness that could load a
  Thai wav2vec2-CTC model from §3, which is functionally equivalent to using
  `ctc-forced-aligner` or torchaudio directly with that model, minus WhisperX's Whisper-transcription
  step (unneeded here since the script is already known).

## 3. Thai wav2vec2/CTC models on Hugging Face (for forced alignment)

Only CTC-head models qualify for classic forced alignment (`Wav2Vec2ForCTC`). **Whisper-family
Thai models are explicitly excluded** — they are encoder-decoder, not CTC, and cannot be used with
the frame-level forced-alignment algorithm (e.g. `biodatlab/whisper-th-medium-combined`, a
fine-tune of `openai/whisper-medium`, confirmed encoder-decoder, Apache-2.0, WER 7.42 on
Common Voice 13 with Deepcut tokenizer — useful only as an ASR/ground-truth source, not an aligner;
[model card](https://huggingface.co/biodatlab/whisper-th-medium-combined)).

- **`airesearch/wav2vec2-large-xlsr-53-th`** — confirmed `Wav2Vec2ForCTC` architecture, so usable
  for forced alignment. License **CC-BY-SA 4.0** (commercial-compatible with attribution/share-alike).
  Reported on Common Voice 7 test: **CER 0.162**, WER 0.95 (with PyThaiNLP tokenization), SER 1.23
  ([model card](https://huggingface.co/airesearch/wav2vec2-large-xlsr-53-th)). No explicit
  last-updated date surfaced; download count (~1.28M) indicates heavy real-world use. No
  forced-alignment-specific benchmark (CER above is transcription CER, not alignment-timing
  accuracy) — **flag as unverified for alignment quality specifically**, only transcription
  quality is documented.
- **`facebook/mms-1b-all`** (the multilingual model underlying §1's aligner) also has an
  explicit `tha` entry among 1162 languages and a Wav2Vec2-based CTC architecture, license
  CC-BY-NC 4.0, aggregate mean WER 22.54 / RTFX 230.79 across all languages (not Thai-specific,
  and RTFX (real-time-factor, higher=faster) figure's compute target — GPU vs CPU — is not stated
  on the model card) ([model card](https://huggingface.co/facebook/mms-1b-all)).

## 4. aeneas (DTW + eSpeak-based synthesis alignment)

- **Thai via eSpeak:** eSpeak-ng's own language table **does list Thai** (`th`, family "Tai")
  with no caveats or "experimental" flag
  ([espeak-ng/docs/languages.md](https://github.com/espeak-ng/espeak-ng/blob/master/docs/languages.md)),
  so the underlying synthesizer aeneas depends on can technically speak Thai. However, aeneas'
  own README lists only **"confirmed working on 38 languages"**, and Thai is **not** among them
  (the list runs afr, ara, bul, cat, ... tur, ukr — no tha/th)
  ([README](https://github.com/readbeyond/aeneas/blob/master/README.md)). Thai would be
  unverified/experimental territory for aeneas even though eSpeak itself supports it.
- **CPU throughput:** No benchmark numbers in the README; it references an external, unfetched
  benchmark site (readbeyond.github.io/aeneas-benchmark) — **unknown — no published number
  confirmed** in this pass.
- **License:** **AGPLv3** — copyleft; using it inside a closed-source SaaS backend would need
  legal review (AGPL's network-use clause) or a commercial-license conversation with the author.
- **Maintenance status:** Latest tagged **release is 1.7.3.0 from March 2017**
  ([PyPI](https://pypi.org/project/aeneas/)); GitHub API shows a `pushed_at` of 2026-07-25, but
  given the still-2017 release/version number this is most likely doc/CI churn, not functional
  development — **treat as effectively unmaintained/frozen** for anything beyond what's shipped.
- **Integration path:** Python C-extension package; needs `numpy` pre-installed, then `aeneas`
  (order matters per README), plus a system eSpeak/eSpeak-ng binary — shell-out/sidecar only.
- **Gotcha:** eSpeak-ng's Thai voice is a rule-based grapheme-to-phoneme synthesizer, not tuned
  for naturalness — accuracy of the DTW alignment depends on how well eSpeak's synthetic-Thai
  audio's spectral envelope matches the real Gemini/ElevenLabs TTS audio, which is unverified.

## 5. TTS-native timing marks

- **Gemini TTS (`generateContent` audio, and the Live/streaming API):** The official
  [speech generation docs](https://ai.google.dev/gemini-api/docs/speech-generation) describe
  voice/style control and audio delivery tags (`[whispers]`, `[laughs]`) but **no word/character
  timestamp field and no SSML `<mark>` support** is documented. The
  [Live API docs](https://ai.google.dev/gemini-api/docs/live) likewise document only text
  transcripts of input/output audio, not timing marks. **Confirmed absent as of this check** —
  matches the app's existing observation that Gemini TTS returns no timestamps.
- **ElevenLabs `.../with-timestamps`:** The
  [API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
  confirms **character-level** timing: response includes an `alignment` object with parallel
  arrays of characters, `character_start_times_seconds`, `character_end_times_seconds` (plus a
  `normalized_alignment` variant). This is already a deterministic, exact solution **for the
  ElevenLabs path** the app already integrates — no forced-aligner needed there. It does not help
  the Gemini-TTS path, which is the actual gap.

## 6. Thai-specific tokenization/normalization constraints across pipelines

- **No native word boundaries:** every candidate above needs a word-boundary step before or
  during alignment. `uroman` (used by §1/§3's MMS pipeline) romanizes Thai character-by-character
  and reportedly improved this in v1.3.1, but does not itself claim to produce linguistically
  correct Thai word segmentation — it romanizes, it doesn't segment.
  `airesearch/wav2vec2-large-xlsr-53-th`'s own reported WER used **PyThaiNLP**
  (`pythainlp.tokenize`, default `newmm` dictionary-based maximum-matching engine, with a Rust
  `nlpo3` 2.5x-faster variant and a `deepcut` CNN-based alternative;
  [PyThaiNLP docs](https://pythainlp.org/docs/4.0/api/tokenize.html)) as an external, separate
  segmentation step — i.e., a working Thai forced-alignment pipeline will likely need PyThaiNLP
  (or deepcut) to segment the known script into words *before* handing it to any CTC aligner,
  since none of these aligners segment Thai on their own.
- **Syllable/character-level fallback:** viable in principle — MMS/uroman-based alignment already
  operates at romanized-character granularity internally, so falling back to
  character-level onset times (skipping word grouping entirely) is a lower-risk target than
  betting on correct Thai word segmentation; this trades caption-grouping quality for determinism.
- **Digits/loanwords:** none of the fetched docs describe explicit normalization rules for mixed
  Thai/English/digit text (e.g. "2568", "AI", "Content") in uroman, PyThaiNLP, or the CTC
  aligners — this is an **unverified gap**; in practice such tokens likely pass through uroman's
  generic Latin-passthrough (digits/Latin letters mostly uroman to themselves) but this needs
  empirical testing, not just doc-reading, before trusting mixed-script scripts.

## Ranked recommendation

1. **`ctc-forced-aligner` (MahmoudAshraf97) with an MMS/CTC checkpoint** — best-fit primary
   candidate: actively maintained (pushed 2026-07-12), CPU-viable via the ONNXRuntime install
   path (avoids full torch), BSD tool license, and Thai is in-scope through uroman + the
   1162-language MMS acoustic model. Two model choices to pilot: the default
   CC-BY-NC MMS aligner model (fastest to try, but non-commercial license blocks production
   use) vs. swapping in `airesearch/wav2vec2-large-xlsr-53-th` (CC-BY-SA, commercially usable,
   Thai-native training data, but not explicitly validated for the alignment code path — needs
   verification it loads as a drop-in CTC checkpoint).
2. **`airesearch/wav2vec2-large-xlsr-53-th` run directly through torchaudio's/aligner's CTC
   forced-align, with PyThaiNLP pre-segmentation** — same technique as #1 but skips MMS/uroman
   romanization entirely, aligning native Thai characters. Worth piloting in parallel since it
   avoids the romanization-fidelity unknown and is unambiguously CC-BY-SA licensed.
3. **WhisperX** — do not pilot as a distinct system; it has no Thai alignment model and would
   just be a heavier wrapper around #1/#2's model choice.
4. **`aeneas`** — deprioritize: unmaintained since 2017, AGPLv3 licensing risk for a closed
   SaaS, and Thai is outside its confirmed-working language list even though eSpeak-ng
   nominally supports Thai.
5. **TTS-native timing** — not viable for the Gemini path (confirmed no timestamp support);
   note for future: if voice cloning ever standardizes on ElevenLabs, its character-level
   `with-timestamps` endpoint is a deterministic, alignment-free alternative worth reusing
   instead of any aligner.

## Minimal pilot design

- **Inputs:** 10-15 real production clips spanning 30s-6min, existing known Thai script text
  (already segmented at chunk level by the app) and the corresponding Gemini-TTS 24kHz PCM audio
  already generated for those jobs.
- **Candidates to run head-to-head:** (a) `ctc-forced-aligner` default pipeline (uroman + MMS
  CC-BY-NC model, for a licensing-blocked but fastest technical read), and (b) the same aligner
  code path pointed at `airesearch/wav2vec2-large-xlsr-53-th` with PyThaiNLP-segmented input
  (the production-licensable option).
- **Outputs to capture per clip:** per-word (or per-character, if word segmentation is unreliable)
  onset/offset times in seconds; wall-clock alignment runtime (to check the 10-20%-of-duration
  budget); process peak RSS (to size a VPS sidecar).
- **Ground truth for accuracy scoring:** run `faster-whisper` with `word_timestamps=True` (or
  `whisper-timestamped`) over the same audio as a rough, independent word-timing baseline (not
  perfect, but decoupled from the aligner under test since it estimates timing from acoustics
  without being told the script) — plus manual spot-checking of ~10 sentences per clip length
  bucket by ear/waveform inspection, since Whisper's own timestamps are approximate.
- **Metric:** mean/95th-percentile absolute offset (seconds) between each aligner's word onsets
  and the nearest Whisper-word onset for the same word, plus a manual "does the caption change
  land on the right syllable" pass/fail count, bucketed by clip length (30s/2min/6min) to check
  whether the ~800-char-chunking problem the app has today is actually eliminated end-to-end.
