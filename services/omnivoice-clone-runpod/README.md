# Hero Voice clone-only RunPod worker (contract v3)

Private internal-evaluation worker for the Mew-first Hero Voice Clone canary. It
accepts exactly one operation, `contract_version:3` + `mode:"clone"`, and returns
one exact success or failure envelope. It has no HTTP application, catalog,
tenancy, persistence, credit, auth, or fallback layer.

The caller owns final `text` (`speechText`). The worker verifies the caller's
request and matched-settings commitments and never trims, normalizes,
transliterates, or otherwise rewrites `text` or `ref_text`.

## Profiles

- `control-v1`: v13-derived clone adapter (audited-v13 reference preprocessing,
  guidance 2.5, best of three by maximum speaker cosine). Source-level parity
  fixtures pass; real GPU/audio parity remains an execution gate.
- `reference-enhancement-v1`: the team's Demucs-plus-peak-normalization
  treatment. The pinned source receives one reviewable metadata-only patch that
  removes its stale `torchaudio<2.1` upper bound; immutable-image import, offline
  model load, and real GPU/audio fixtures must still pass before paid execution.
- `text-normalization-v1`: the control receiving the harness-frozen normalized
  text; its delta is in the committed input and the worker only attests the named
  normalizer.
- `guidance-ranking-v1`: guidance 2.0 and ranking
  `speaker_cosine + 0.15 * pitch_similarity_normalized`.
- `watermark-v1`: the control plus pinned AudioSeal 16-bit embedding/detection.
- `combined-quality-v1`: harness-owned normalized text, the gated Demucs
  reference path, guidance 2.0 and pitch-aware ranking, with no watermark.

Pitch similarity is fixed as `clamp(1 - (abs(median_midi_delta) +
0.5*abs(iqr_midi_delta))/24, 0, 1)` over voiced `librosa.pyin` frames from C2:C6.
An unvoiced/invalid pitch fails the requested profile.

Candidate selection and its serialized speaker, pitch, and composite metrics use
the same unrounded binary64 values, so a validator can recompute even near ties
exactly; exact ties select the lowest candidate index. Like audited v13,
reference ranking reads the final file-backed prompt WAV domain: mono 24 kHz
PCM16 frames decoded back to float32. Reference metrics reject non-exact booleans/floats/integers, extra
artifact fields, impossible 5–15-second sample counts, and clipping counts beyond
their frames. Watermark probabilities/rates are exact finite floats in `[0,1]`;
its counters are exact bounded integers tied to the maximum output duration.

Watermark evidence schema version `1` names every hash domain explicitly. Candidate
hashes are over little-endian float32 mono 24 kHz buffers; pre-embed and marked
hashes are over separate little-endian float32 mono 16 kHz buffers. Those internal
digests are pinned-worker attestations and the application does not claim it can
reproduce AudioSeal or SciPy resampling. `delivered_24k_sha256` is different: it is
SHA-256 over the exact little-endian PCM16 `data`-chunk frame bytes in the returned
mono 24 kHz WAV, so the application parses and recomputes it independently. The
contract also fixes generation count/guidance/temperature, requires exact
`ceil(selected_24k_samples * 2/3)` pre/marked counts, preserves the selected sample
count through delivery, links the selected candidate hash in its own domain, and
requires distinct pre-embed/marked hashes.

## Parity and paid-ablation gate

`audited_v13_boundary.py` is a test-only extraction of the production v13
preprocessing, exported/decoded PCM16 ranking-reference input, prompt call, speed
clamp, and cosine formula. Synthetic fixtures execute it against this worker's
boundary, including the reference quantization path. Prompt, ranking input domain,
speed, cosine, segmentation, generation parameters, and output class agree;
reference amplitude preprocessing now does: non-enhancement profiles preserve
audited v13's pydub downmix/resample without peak normalization. The team's
reference-enhancement stage intentionally includes Demucs plus peak-`0.95`
normalization as one treatment. **Paid ablation and any acoustic parity claim
remain blocked** until the immutable image and real GPU/audio fixtures pass.
Fake-runtime unit tests are not acoustic parity evidence.

## Security and retention

Reference bytes, prompts, embeddings, candidates, and output buffers exist only
for one provider job. Request files live in a per-job temporary directory and are
removed in `finally`; the runtime retains no per-user data. Logs contain only a
one-way job-ID fingerprint, profile, seed, error code, and integer timing/duration.
Do not enable DEBUG logging. Provider payload/retention remains a separate RunPod
legal and processor gate; local cleanup is not evidence of provider erasure.

The final container runs non-root, sets Hugging Face/Transformers offline mode,
and admits only the 12 hash/size-verified model files. The approved application
source baseline `8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb` is hard-coded in the
source manifest, image label, build attestation, and runtime identity verifier;
there is no source-revision build argument. Runtime module bytes are separately
bound by `RUNTIME_MANIFEST.json` through the hard-coded source-manifest digest.
Environment variables and dependency-injected identities cannot override these
values. The final OCI digest remains an external immutable runtime attestation.

`requirements.lock` contains every non-parent, non-RunPod Python distribution
with hashes. The official RunPod SDK 1.12.0 wheel has its own one-package hash
lock and an exact metadata-only patch removes its unused FastAPI local/realtime
server dependency; `RUNPOD_LOG_LEVEL=INFO` prevents result payloads from entering
SDK DEBUG logs. The parent-supplied `torch==2.6.0`, `torchaudio==2.6.0`,
`triton==3.2.0`, CUDA 12.4, and cuDNN 9 are constrained in `requirements.in` and
asserted before/after installation. Build backends have their own hash lock; all
source installs use `--no-build-isolation`; builder and runtime execute `pip
check` and import smoke. Regenerate the runtime and build locks with `bash
compile_requirements.sh`; the separately audited RunPod wheel lock is updated
only after its metadata is reviewed.

For Task 6, `verify_image.py --oci-layout OCI --expected-manifest-digest
sha256:...` verifies the OCI index, selected linux/amd64 manifest, config, every
ordered layer digest/size, and each config `rootfs.diff_ids` commitment. The
verifier rejects caller-supplied extracted layers, merged rootfs trees, and
separate history JSON. It reads history only from the authenticated config blob
and safely applies the authenticated layers in order to a new private temporary
rootfs, including OCI whiteouts, without following archive-controlled links or
admitting traversal/device entries. It then anchors the image's source, model,
and runtime manifests byte-for-byte to the checked-in expectations and checks
runtime/model hashes from those expectations. Content checks detect renamed
stock/Lao catalog identifiers and embedded audio containers anywhere in a file,
in addition to Git data, credentials/private keys, unmanifested models, caches,
and sensitive links. Run network-blocked cold-import separately. The actual Task
6 OCI/rootfs/config-history/GPU scan remains a blocker: a container runtime is
unavailable in Task 3, so none of those final-image checks is claimed complete.

## Offline checks

```bash
python -m unittest -v test_contract.py
python verify_image.py --static
python - <<'PY'
import ast
from pathlib import Path
for path in Path('.').glob('*.py'):
    ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
PY
```

No real voice, provider request, GPU, or model download is used by these checks.
The checked-in SPDX covers source, all 111 locked runtime distributions, the
separately locked RunPod SDK, all 9 locked source-build distributions, all 12
model files, and declared base/system
components and relationships; it is not the Task 6 final-image, digest-bound SBOM.
See `THIRD_PARTY_NOTICES.md`: all use remains internal evaluation only, and the
OmniVoice/Demucs/wrapper rights gaps block publication and commercial release.
