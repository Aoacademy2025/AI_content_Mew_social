# Experimental Gemini acoustic clock

This package aligns the exact Gemini narration to its generated WAV. It is an opt-in candidate clock, **off by default**. Neither a model-confidence score nor a successful render certifies subtitle accuracy. See `docs/plans/2026-09-05-gemini-acoustic-caption-timing.md` for the release criteria.

## Model and attribution

VISTEC/AIResearch, [`airesearch/wav2vec2-large-xlsr-53-th`](https://huggingface.co/airesearch/wav2vec2-large-xlsr-53-th), revision `3155938c549b23eee16b1d4b55dcb161b7fe4bcf`, CC-BY-SA-4.0. Keep the model attribution/license with installed weights and preserve the applicable terms when distributing adaptations. Weights are downloaded separately, not included in this repository. This is a Thai model; unsupported Latin/digit spans remain explicitly approximate. The default noncommercial MMS weights from other aligner packages are not used.

The decoder uses source-indexed CTC Viterbi alignment. Twenty-second interiors have two seconds of context on each side; sample-exact convolution offsets and integer rounding prevent a chunk boundary from accumulating an offset. UTF-16 character ranges refer to the unmodified input. The decoder emits numeric timing and confidence only. It does not transcribe or rewrite the script.

## Prepare on a development/staging machine

Use Python 3.11 and a separate environment, outside the web renderer:

```sh
python3.11 -m venv /opt/heroai-subtitle-venv
/opt/heroai-subtitle-venv/bin/pip install -r scripts/subtitle-alignment/requirements.txt
/opt/heroai-subtitle-venv/bin/python scripts/subtitle-alignment/engine.py --download-model
```

The explicit preparation command downloads pinned weights. Runtime uses offline-only loading, and failure to find dependencies/weights returns to the existing rendering path. Do not install or download models during a customer request or the web build.

## Runtime controls

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUBTITLE_ACOUSTIC_MODE` | `off` | `off`, `shadow` (record only), or `apply` (allow clock selection) |
| `SUBTITLE_ACOUSTIC_ROLLOUT_PERCENT` | `0` | Stable per-account apply cohort (0–100); remaining accounts stay shadow |
| `SUBTITLE_ACOUSTIC_PYTHON` | unset | Absolute path to the prepared Python executable |
| `SUBTITLE_ACOUSTIC_BUDGET_MS` | `45000` | Whole local attempt, including lock wait/model load; hard cap 90 seconds and existing verification budget |
| `SUBTITLE_ACOUSTIC_THREADS` | `2` | CPU threads, clamped to 1–4 |
| `SUBTITLE_ACOUSTIC_CACHE_DIR` | OS temp `heroai-subtitle-alignment` | Private cache/lock directory; use a service-owned durable directory if desired |

Only Gemini create jobs enter this path. One low-priority Python child runs at a time across processes using a file lock. The parent kills an over-budget process; there is no retry or provider spend. The existing remote alignment call is unchanged and the local attempt runs concurrently with it. This preserves legacy behavior during shadow/canary evaluation; it does not yet remove remote transcription cost. Cache entries are keyed by audio content, exact text, model revision and algorithm version; they contain hashes and numeric timing, never raw scripts or audio. A changed WAV cannot reuse the previous timing. Cache hits are revalidated and expire after seven days. A bounded periodic sweep removes only expired entries owned by this cache.

`apply` can replace an estimated clock with a partial acoustic clock; unsupported/weak words are bounded by verified neighbours and labelled in `uncertainRanges`. Their cards are merged into phrases using original text slices. A partial result preserves existing fully aligned timing unless every uncertain range is exactly one Thai repetition mark (ๆ), bounded by verified words within 1.5 seconds. That narrow bridge may replace remote forced alignment in apply mode; provider-supplied alignment remains protected. Every selected partial clock records `partial_forced_alignment` and retains warning status through export. Complete local alignment may replace one only under `apply`. Partial clocks retain warning-quality provenance. No local error stops rendering.

The preview persists the chosen captions, words and `verification.acoustic`. Export keeps the saved track, makes zero new alignment calls, and records original identity as `sourceAcoustic`; that identity is **not** a claim that a creator-edited export was newly acoustically verified.

## Verification and private benchmark

```sh
npm run verify:acoustic-subtitle-clock
python scripts/subtitle-alignment/test_engine.py
npm run verify:subtitle-audio-sync
npx tsx scripts/subtitle-alignment/benchmark.ts /private/path/corpus.json /private/path/clocks-and-references /private/path/report.json
```

The benchmark manifest is an array of `{id, text, timing}` (private). Per ID, `<id>-clock.json` contains the engine's numeric result and `<id>-references.json` contains `{boundaries:[{startChar,baselineMs,referenceMs,labelSource}]}`. `labelSource` distinguishes `human-reviewed` from an automatic screening reference. Keep manifests/media/ASR transcripts outside git and restrict their directory to the operator. Reports contain numeric evidence only; the harness always identifies qualification as pending because load and final-export verification are external to it.

Python algorithm tests use NumPy without loading a model. Node integration tests exercise real process termination/cache behavior with a local stub, and the actual orchestrator tests verify off/shadow/apply/partial/export behavior. Neither substitutes for the actual-audio benchmark.

## Activation and rollback

Do not activate from the smoke-test result alone. Complete a held-out human-reviewed timing set and measure cold/warm latency, RSS and render contention on deployment hardware. Run shadow first, inspect unavailable/timeout/partial rates, then apply to a bounded cohort. Application uses a stable hashed account cohort, default 0%; start with an explicitly configured small percentage after qualification and increase only after reviewing both quality and operational metrics. Revert `SUBTITLE_ACOUSTIC_MODE=off` to restore future jobs' current clock selection; saved customer projects are not rewritten. Never automatically repair or overwrite old edited captions.
