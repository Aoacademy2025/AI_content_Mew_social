# Clone enhancement and watermarking: primary-source pins and experiment recipe

Date: 2026-09-04
Scope: a reproducible, offline-fetched internal experiment for Demucs reference enhancement and AudioSeal output watermarking. No model was executed. The Demucs checkpoint was streamed only to compute its SHA-256; no checkpoint was deserialized. Claims about the two projects come from their official repositories, official model repository, and official API documentation. `Aoacademy2025/Hero-Voice-Ai` is inspected only as a comparison implementation, never as authority for API, behavior, or licensing.

## Bottom line

- **AudioSeal is sufficiently specified for an internal experiment:** pin `audioseal==0.2.0`, the official code commit and Hugging Face revision below, use the 16-bit generator/detector pair, and explicitly resample to **16,000 Hz mono** before both embedding and detection. AudioSeal 0.2 does not resample internally. Its code **and official weights are MIT**.
- **Demucs can be made technically reproducible:** pin official code commit `e976d93...`, load the single model signature `955717e8` from a local checkpoint whose full SHA-256 is recorded below, set `shifts=0`, and keep input/output handling fixed. The model operates at **44,100 Hz stereo** and yields `drums`, `bass`, `other`, and `vocals` stems.
- **Demucs production licensing remains unresolved:** the official repo licenses the software under MIT, but it does not publish a separate checkpoint license or explicitly extend MIT to the released `.th` weights. Unlike AudioSeal, there is no first-party sentence saying model weights are MIT. Treat the weight license as **not separately specified**, do not redistribute or deploy commercially without legal/owner confirmation, and record this as a gate in the experiment manifest.
- The public comparison is not reproducible as written: its dependencies and model downloads float, Demucs/AudioSeal failures silently return the original audio, its AudioSeal code feeds the model the product sample rate without resampling even though AudioSeal 0.2 ignores the `sample_rate` argument, and its comment incorrectly calls AudioSeal `CC-BY-4.0`.

## 1. AudioSeal — authoritative identity, API, thresholds, and license

### Immutable artifacts

| Item | Required pin | Evidence |
|---|---|---|
| Python package | `audioseal==0.2.0`; PyPI wheel SHA-256 `a5989d1e831177e09ba94ec6789ad28ffbd75a2b64e4463a44d92b81f72faf75` | [official PyPI release JSON](https://pypi.org/pypi/audioseal/0.2.0/json) |
| Source snapshot | `facebookresearch/audioseal@e63a8a0e5cdf7bb797159c92ba15961557fe9bd2` (`__version__ = "0.2.0"`) | [official tree](https://github.com/facebookresearch/audioseal/tree/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2), [version source](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/__init__.py) |
| Official model repository | `facebook/audioseal@3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba` | [pinned official model tree](https://huggingface.co/facebook/audioseal/tree/3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba) |
| Generator weight | `generator_base.pth`, 58,805,980 bytes, SHA-256 `7a845b5fbe9364a63a3909d8ab3fe064d13a76ae4c2e983573e08c69b7b51748` | [pinned weight](https://huggingface.co/facebook/audioseal/blob/3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba/generator_base.pth), [official generator card mapping](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/cards/audioseal_wm_16bits.yaml) |
| Detector weight | `detector_base.pth`, 34,667,641 bytes, SHA-256 `8a78e8a83584113523e161fc599fcab10fd0e94c04d2eb9d2fa1e9ec91ab69d9` | [pinned weight](https://huggingface.co/facebook/audioseal/blob/3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba/detector_base.pth), [official detector card mapping](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/cards/audioseal_detector_16bits.yaml) |

The published card names are exactly `audioseal_wm_16bits` and `audioseal_detector_16bits`; the official examples load them with `AudioSeal.load_generator(...)` and `AudioSeal.load_detector(...)`. The cards point at mutable `/resolve/main/` URLs, so a reproducible build must fetch the two files from the immutable HF revision above, verify their full SHA-256 values, bake them into the image, and load the local files with `nbits=16`. [Official README usage](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/README.md#-usage), [loader API](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/loader.py#L358-L396).

### Sample rate and tensor contract

- Use float waveform tensors shaped `(batch, channels, samples)`; the published checkpoint is a one-channel model, so standardize on **mono**. [Generator card](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/cards/audioseal_wm_16bits.yaml), [official generator docs](https://facebookresearch-audioseal.mintlify.app/api/generator#get-watermark).
- Standardize on **16,000 Hz**. The official model card says the released model supports 16 kHz; current official API docs say the expected rate is typically 16 kHz. Although the README says the default model can work well on some 24/48 kHz speech, AudioSeal 0.2 explicitly deprecated internal resampling: the supplied `sample_rate` is ignored and callers are responsible for preparing the correct rate. That makes 16 kHz the only conservative reproducibility choice. [Official model card](https://huggingface.co/facebook/audioseal), [0.2 changelog](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/CHANGELOG.md#020---2025-12-09), [source warning and implementation](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/models.py#L24-L32).

### Embed procedure

The official API offers equivalent forms:

```python
generator = AudioSeal.load_generator(LOCAL_GENERATOR_PATH, nbits=16, device=DEVICE)
generator.eval()
message = torch.tensor(
    [[1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0]],
    dtype=torch.int64,
    device=DEVICE,
)
with torch.no_grad():
    watermarked_16k = generator(audio_16k_mono, message=message, alpha=1.0)
# Equivalent: watermark = generator.get_watermark(...); watermarked_16k = audio + watermark
```

`message=None` creates/reuses a random 16-bit message, so the experiment must supply a fixed message. `alpha=1.0` is the official default and must be logged; lower values trade robustness for subtlety. The output has the same shape and length as the input. [Official generator docs](https://facebookresearch-audioseal.mintlify.app/api/generator), [implementation](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/models.py#L272-L338).

For a 24 kHz product output: convert the final generated audio to mono 16 kHz, embed there, store that 16 kHz float master for measurement, then resample the watermarked audio to the product rate. Every delivered/rendered artifact must be resampled back to mono 16 kHz before detection. Do not call `get_watermark()` directly on 24 kHz samples and assume that passing `sample_rate=24000` fixes the rate; in 0.2 it is a no-op.

### Detection output and thresholds

```python
detector = AudioSeal.load_detector(LOCAL_DETECTOR_PATH, nbits=16, device=DEVICE)
detector.eval()
with torch.no_grad():
    detect_fraction, decoded_bits = detector.detect_watermark(
        candidate_16k_mono,
        detection_threshold=0.5,
        message_threshold=0.5,
    )
    frame_probabilities, bit_probabilities = detector(candidate_16k_mono)
positive = bool(detect_fraction.item() > 0.5)
```

- Low-level `forward()` returns framewise softmax probabilities shaped `(batch, 2, frames)` plus 16 message-bit probabilities shaped `(batch, 16)`. Channel 1 is watermark presence. [Official detector docs](https://facebookresearch-audioseal.mintlify.app/api/detector#forward).
- `detect_watermark()` does **not** return a calibrated posterior for the whole clip. Its `detect_fraction` is the proportion of frames whose channel-1 probability exceeds `detection_threshold`; defaults are `0.5` for both frame detection and message binarization. [Official source](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/models.py#L389-L455), [official detector docs](https://facebookresearch-audioseal.mintlify.app/api/detector#detect-watermark).
- The official docs' basic example declares a clip watermarked when `detect_fraction > 0.5`. Use that exact cut-off as the pre-registered **reference rule** for this experiment, while also retaining all frame scores and the decoded 16-bit error rate. Do not describe the returned fraction as calibrated confidence. [Official detector example](https://facebookresearch-audioseal.mintlify.app/api/detector#example).
- The inspected first-party sources provide these defaults/examples, **not a universal or Thai/Hero-calibrated operating threshold or guaranteed FPR**. Production threshold selection therefore requires a separate representative calibration set and held-out validation; do not tune on the experiment test set.
- A decoded message from unwatermarked audio is essentially random. Message equality/bit error rate is therefore a secondary attribution check, not a replacement for measuring detector false positives on clean controls. [Official detector return contract](https://facebookresearch-audioseal.mintlify.app/api/detector#returns).

### License

The official repository is MIT, and its README explicitly says the April 2024 change made the license full MIT **including the model weights**. The official HF model repository is marked MIT. This directly contradicts the comparison wrapper's `CC-BY-4.0` comment. Preserve the MIT notice in distributions. [Official README license update](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/README.md#-key-updates), [MIT license](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/LICENSE), [official model repository](https://huggingface.co/facebook/audioseal).

## 2. Demucs `htdemucs` — authoritative identity, download, outputs, and license

### Immutable code and model identity

| Item | Required pin | Evidence |
|---|---|---|
| Code/API | `facebookresearch/demucs@e976d93ecc3865e5757426930257e200846a520a` (archived official Meta repo, reports `4.1.0a2`) | [official pinned tree](https://github.com/facebookresearch/demucs/tree/e976d93ecc3865e5757426930257e200846a520a), [version source](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/__init__.py), [API source](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/api.py) |
| Public alias | `htdemucs` is a one-model bag containing signature `955717e8` | [`htdemucs.yaml`](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/remote/htdemucs.yaml), [official model-zoo description](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/docs/training.md#hybrid-transformer-demucs) |
| Exact checkpoint | `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th` | [official remote manifest](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/remote/files.txt#L24-L32), [loader root and mapping](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/pretrained.py#L26-L76) |
| Checkpoint SHA-256 | `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4` (84,141,911 bytes) | Independently streamed from the official URL on 2026-09-04; the first eight hex characters match the checksum embedded by Meta in the official filename. The official loader calls `torch.hub.load_state_dict_from_url(..., check_hash=True)`, which verifies that filename prefix. [official repository loader](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/repo.py#L67-L72) |

Do **not** substitute the PyPI release merely because it is versioned. `demucs==4.0.1` / tag `ef66d254...` predates `demucs/api.py`; official release notes list the API as a later `4.1.0a1` addition. The comparison wrapper imports `from demucs.api import Separator`, so its unpinned requirement can resolve to a package without that module and then silently disable enhancement. Pin the official commit above (and lock all transitive dependencies) if using `Separator`. [Official release notes](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/docs/release.md), [PyPI 4.0.1 artifact metadata](https://pypi.org/pypi/demucs/4.0.1/json), [comparison requirements](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/requirements.txt).

### Sample rate and output semantics

- `HTDemucs` metadata defaults to **44,100 Hz**, two audio channels. It does not internally resample in the model; the high-level `Separator` converts input audio to the model rate/channel count. [Official HTDemucs source](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/htdemucs.py#L394-L555), [Separator conversion path](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/api.py#L173-L226).
- The official `htdemucs` model separates four **stereo, 44.1 kHz** stems named `drums`, `bass`, `other`, and `vocals`; the API returns `(resampled_original, {stem_name: tensor})`. [Official README output contract](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/README.md#separating-tracks), [Separator return implementation](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/api.py#L209-L256).
- Tensor input to `separate_tensor` is float32 shaped `(channels, samples)`. If `sr` differs, the API resamples it and returns the resampled original. [Official API](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/api.py#L187-L218).
- CLI WAV output defaults to int16 and rescale-to-avoid-clipping, with optional float32/int24. That file-writing rescale can change relative stem volumes, so the experiment should consume the in-memory float32 `vocals` tensor and apply one explicitly logged normalization policy to both A/B arms. [Official README](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/README.md#separating-tracks), [CLI flags](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/separate.py#L119-L145).

### Deterministic enhancement procedure

Fetch the checkpoint during the image build, verify the full SHA-256, place it in a read-only local model directory, and prohibit runtime network access. Load the exact signature rather than the mutable alias:

```python
separator = Separator(
    model="955717e8",
    repo=Path("/models/demucs"),  # contains 955717e8-8726e21a.th
    device=FIXED_DEVICE,
    shifts=0,
    split=True,
    overlap=0.25,
    segment=7,
    jobs=0,
    progress=False,
)
_, stems = separator.separate_tensor(reference_float32, sr=reference_sr)
vocals_44k_stereo = stems["vocals"]
vocals_44k_mono = vocals_44k_stereo.mean(dim=0)
```

- `shifts` defaults to 1 and uses a random time shift; set it to **0** so repeated runs do not change from that augmentation. [Official API docs](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/docs/api.md#class-separator), [apply implementation](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/apply.py#L128-L185).
- Keep `split=True`, `overlap=0.25`, and integer `segment=7`. The official README says Hybrid Transformer models have a maximum 7.8-second segment; seven seconds is valid under the API's integer parameter and removes checkpoint/default ambiguity. [Official README segment guidance](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/README.md#separating-tracks), [Separator signature](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/api.py#L67-L94).
- Fix the device/backend and full software/container lock for each repeated run. `shifts=0` removes an explicit RNG source but does not promise cross-hardware bit identity.
- For the clone experiment, downmix the `vocals` stem to mono, then resample once to OmniVoice's required 24 kHz input. Apply the same deterministic peak normalization (`peak=0.95`, or no normalization) to **both** raw and enhanced reference arms; that is an internal confound-control choice, not Demucs behavior. Record pre/post duration, peak, RMS, clipping count, and SHA-256.

### License

The official repository and code files state MIT. The root MIT text grants rights in “this software and associated documentation.” The official model manifest supplies the `.th` checkpoint but neither it, the model-zoo text, nor the download endpoint supplies a separate weight license; the README does not contain AudioSeal-like language explicitly extending MIT to weights. Therefore:

- code: **MIT**;
- `955717e8-8726e21a.th` weight: **not separately specified by the first-party materials inspected**;
- internal research may record and evaluate the artifact subject to company counsel, but redistribution/commercial production remains gated on explicit license confirmation.

This is a licensing evidence gap, not a conclusion that the checkpoint is forbidden or that MIT definitely does not apply. [Official MIT license](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/LICENSE), [official README license statement](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/README.md#license), [official remote weight manifest](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/demucs/remote/files.txt).

## 3. Public Hero-Voice-Ai comparison (non-authoritative)

Observed comparison pin: `Aoacademy2025/Hero-Voice-Ai@f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37`.

| Comparison behavior | Why not adopt it as the experiment contract |
|---|---|
| `MODEL_NAME` defaults to `htdemucs`; `Separator` uses defaults; returned `vocals` is averaged to mono and peak-normalized to `0.95`. | Model/code/dependencies/checkpoint float; default `shifts=1` is stochastic; peak normalization is wrapper policy, not Demucs. [comparison enhancement](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/core/audio_enhance.py) |
| Any load/separation error permanently disables enhancement or returns the original file. | An “enhancement” arm can silently become the control. The internal harness must fail closed and emit model/artifact IDs. [comparison enhancement](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/core/audio_enhance.py) |
| Requirements list bare `demucs`; wrapper imports `demucs.api.Separator`. | Official PyPI 4.0.1 predates that module. This is not a reproducible install. [comparison requirements](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/requirements.txt), [official release notes](https://github.com/facebookresearch/demucs/blob/e976d93ecc3865e5757426930257e200846a520a/docs/release.md) |
| AudioSeal loads the mutable card name, calls `get_watermark(x)` at the incoming rate, adds it, and has no detector endpoint/test. | At the app's normal 24 kHz this omits the 16 kHz conversion required by 0.2's no-resample behavior; there is no proof of survival through delivery transforms. [comparison watermark](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/core/watermark.py), [official 0.2 source warning](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/src/audioseal/models.py#L24-L32) |
| Watermark import/apply errors return unwatermarked audio and an environment variable can disable it. | A safety experiment must distinguish `watermarked`, `not requested`, and `failed`; a requested watermark profile must fail closed. [comparison watermark](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/core/watermark.py) |
| Comment calls AudioSeal “Meta, CC-BY-4.0.” | First-party AudioSeal sources say MIT including model weights. Never inherit license labels from the comparison wrapper. [comparison watermark](https://github.com/Aoacademy2025/Hero-Voice-Ai/blob/f9b6c0a4a9adcf2fb44f35c9b35a44c007127c37/core/watermark.py), [official AudioSeal README](https://github.com/facebookresearch/audioseal/blob/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/README.md#-key-updates) |

## 4. Pre-registered internal experiment parameters

### Enhancement A/B

1. Use the same consented 3–15 second reference clips and canonical `ref_text` in both arms; decode once to float32 mono and hash that canonical input.
2. **Control:** canonical reference → the same chosen peak policy → 24 kHz mono clone input.
3. **Treatment:** canonical reference → pinned Demucs recipe above → `vocals` → mono mean → the identical peak policy → 24 kHz mono clone input.
4. Keep OmniVoice model/revision, inference text, seed, guidance, steps, speed, ranking, device and software/container digest identical. Enhancement failure invalidates the treatment item; it must never fall back to control audio.
5. Preserve hashes and audio statistics for canonical input and enhanced reference. Blind-rate the paired generated outputs and report speaker similarity/intelligibility metrics separately; do not bundle the result with normalization, guidance/ranking, or watermark changes.

### Watermark robustness

1. Start from each final generated clone before product encoding. Convert to float32 mono 16 kHz and embed the fixed 16-bit message above with `alpha=1.0`.
2. Create an unwatermarked paired negative from the same 16 kHz master. Store hashes and artifact labels out of band; do not let evaluator filenames reveal the arm.
3. Detect on: (a) embedded 16 kHz float master, (b) resampled 24 kHz WAV after converting back to 16 kHz, and (c) the exact outputs of the Hero render/delivery path, MP3, AAC, speed change, trims, and concatenation, each decoded/resampled to 16 kHz mono by one pinned transform.
4. Fixed reference decision: `detection_threshold=0.5`, `message_threshold=0.5`, clip positive iff `detect_fraction > 0.5`. Record `detect_fraction`, all frame probabilities, decoded bits, bit error rate against the fixed message, transformation, codec parameters, duration, and hash.
5. Report TPR and FPR on paired positives/negatives for every transform, with confidence intervals. The fixed rule is the official example and enables comparison; it is not evidence that `0.5` is calibrated for Thai speech or the Hero codec chain. Any later threshold chosen from data must be selected on a separate calibration set and evaluated on a held-out set.
6. A requested watermark model/load/embed failure is a failed experiment item and must fail closed. AudioSeal is a statistical watermark, not cryptographic provenance or consent enforcement; retain the existing consent, access control, deletion and abuse controls.

## Reproducibility manifest fields

Record at minimum: container digest; Python/torch/torchaudio/codec/resampler versions; device/backend; Demucs code commit, signature, checkpoint URL/size/full SHA-256 and parameters; AudioSeal package/source/HF revision, both weight sizes/full SHA-256, fixed 16-bit message, alpha and thresholds; canonical input/output hashes; all sample-rate/channel conversions; and explicit model-load/embed/detect success states. Build with network access only during the verified fetch stage and verify that inference makes no outbound model download.
