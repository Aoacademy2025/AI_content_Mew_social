# syntax=docker/dockerfile:1.7
# check=skip=InvalidBaseImagePlatform
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime@sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential=12.9ubuntu3 \
       ca-certificates=20260601~22.04.1 \
       git=1:2.34.1-1ubuntu1.17 \
       libsndfile1=1.0.31-2ubuntu0.2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/context
COPY build-requirements.lock build-requirements.in requirements.lock requirements.in runpod-requirement.lock MODEL_MANIFEST.json SOURCE_MANIFEST.json demucs-torchaudio-2.4-compat.patch ./
RUN python -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --require-hashes -r build-requirements.lock

# These are the only dependency artifacts inherited from the parent rather than
# emitted into requirements.lock. Assert the exact ABI before source builds.
RUN /opt/venv/bin/python - <<'PY'
import torch
import torchaudio
import triton

assert torch.__version__.split("+")[0] == "2.6.0", torch.__version__
assert torchaudio.__version__.split("+")[0] == "2.6.0", torchaudio.__version__
assert triton.__version__ == "3.2.0", triton.__version__
assert torch.version.cuda == "12.4", torch.version.cuda
assert torch.backends.cudnn.version() // 10_000 == 9, torch.backends.cudnn.version()
PY

RUN git init /build/OmniVoice \
    && git -C /build/OmniVoice remote add origin https://github.com/k2-fsa/OmniVoice.git \
    && git -C /build/OmniVoice fetch --depth=1 origin 346bb75330980a236540d61a0808d00767c0973b \
    && git -C /build/OmniVoice checkout --detach FETCH_HEAD \
    && test "$(git -C /build/OmniVoice rev-parse HEAD)" = "346bb75330980a236540d61a0808d00767c0973b" \
    && /opt/venv/bin/pip wheel --no-deps --no-build-isolation --wheel-dir /build/wheels /build/OmniVoice

RUN git init /build/audioseal \
    && git -C /build/audioseal remote add origin https://github.com/facebookresearch/audioseal.git \
    && git -C /build/audioseal fetch --depth=1 origin e63a8a0e5cdf7bb797159c92ba15961557fe9bd2 \
    && git -C /build/audioseal checkout --detach FETCH_HEAD \
    && test "$(git -C /build/audioseal rev-parse HEAD)" = "e63a8a0e5cdf7bb797159c92ba15961557fe9bd2" \
    && /opt/venv/bin/pip wheel --no-deps --no-build-isolation --wheel-dir /build/wheels /build/audioseal

# Demucs only imports torchaudio on this inference path; tensor resampling is
# performed by Julius. Apply the reviewable one-line metadata compatibility
# patch, then build and install the exact pinned source without dependency drift.
RUN git init /build/demucs \
    && git -C /build/demucs remote add origin https://github.com/facebookresearch/demucs.git \
    && git -C /build/demucs fetch --depth=1 origin e976d93ecc3865e5757426930257e200846a520a \
    && git -C /build/demucs checkout --detach FETCH_HEAD \
    && test "$(git -C /build/demucs rev-parse HEAD)" = "e976d93ecc3865e5757426930257e200846a520a" \
    && grep -Fx 'torchaudio>=0.8,<2.1' /build/demucs/requirements_minimal.txt \
    && git -C /build/demucs apply --check /build/context/demucs-torchaudio-2.4-compat.patch \
    && git -C /build/demucs apply /build/context/demucs-torchaudio-2.4-compat.patch \
    && grep -Fx 'torchaudio>=0.8' /build/demucs/requirements_minimal.txt \
    && test "$(git -C /build/demucs diff --numstat requirements_minimal.txt)" = "$(printf '1\t1\trequirements_minimal.txt')" \
    && /opt/venv/bin/pip wheel --no-deps --no-build-isolation --wheel-dir /build/wheels /build/demucs

RUN /opt/venv/bin/pip install --require-hashes --no-deps --no-build-isolation -r requirements.lock \
    && /opt/venv/bin/pip install --require-hashes --no-deps -r runpod-requirement.lock \
    && /opt/venv/bin/pip install --no-deps /build/wheels/omnivoice-0.1.5-py3-none-any.whl /build/wheels/audioseal-0.2.0-py3-none-any.whl /build/wheels/demucs-4.1.0a2-py3-none-any.whl \
    && /opt/venv/bin/python - <<'PY'
import hashlib
import shutil
from pathlib import Path

omnivoice_metadata = Path("/opt/venv/lib/python3.11/site-packages/omnivoice-0.1.5.dist-info/METADATA")
omnivoice_raw = omnivoice_metadata.read_bytes()
assert hashlib.sha256(omnivoice_raw).hexdigest() == "c26956459797f59a2ba40f015d991aaefd07d7e7fa6f864ce29f707927502ad6"
omnivoice_obsolete = b"Requires-Dist: gradio\n"
assert omnivoice_raw.count(omnivoice_obsolete) == 1
omnivoice_patched = omnivoice_raw.replace(omnivoice_obsolete, b"")
assert hashlib.sha256(omnivoice_patched).hexdigest() == "f72051fb59f8967c0dd7dc6dd1cf2ca02c038dd6b1293fa5e5cb82481793d660"
omnivoice_metadata.write_bytes(omnivoice_patched)

runpod_metadata = Path("/opt/venv/lib/python3.11/site-packages/runpod-1.12.0.dist-info/METADATA")
runpod_raw = runpod_metadata.read_bytes()
assert hashlib.sha256(runpod_raw).hexdigest() == "7766c4b844c749ed119a34e37d09a6e7635e331984bb1776507f8219af5936a4"
runpod_unused = b"Requires-Dist: fastapi[all]>=0.141.1\n"
assert runpod_raw.count(runpod_unused) == 1
runpod_patched = runpod_raw.replace(runpod_unused, b"")
assert hashlib.sha256(runpod_patched).hexdigest() == "8eef34ce6018c84bb4febfeff7967a33aea0a07ce5a7f95a94279885b6505b78"
runpod_metadata.write_bytes(runpod_patched)

metadata = Path("/opt/venv/lib/python3.11/site-packages/Resemblyzer-0.1.4.dist-info/METADATA")
raw = metadata.read_bytes()
assert hashlib.sha256(raw).hexdigest() == "a8dca4f91c66d1594216af85080202fc6475f09f8a0e4c5822ce0b60bf401eb2"
obsolete = b"Requires-Dist: typing\r\n"
assert raw.count(obsolete) == 1
patched = raw.replace(obsolete, b"")
assert hashlib.sha256(patched).hexdigest() == "9171b44fb93d82cfd945f403d890c4d0f77cb241a483996133b95eb1fe2ea146"
metadata.write_bytes(patched)

scipy_audio_test_data = Path("/opt/venv/lib/python3.11/site-packages/scipy/io/tests/data")
assert scipy_audio_test_data.is_dir()
shutil.rmtree(scipy_audio_test_data)
assert not scipy_audio_test_data.exists()
PY
RUN /opt/venv/bin/pip check

RUN /opt/venv/bin/python - <<'PY'
from huggingface_hub import hf_hub_download, snapshot_download

snapshot_download(
    repo_id="k2-fsa/OmniVoice",
    revision="c5fdb5ccb189668d56333f77ba2629f4cd7535f4",
    local_dir="/opt/models/omnivoice",
    allow_patterns=[
        "config.json",
        "model.safetensors",
        "tokenizer.json",
        "tokenizer_config.json",
        "chat_template.jinja",
        "audio_tokenizer/config.json",
        "audio_tokenizer/model.safetensors",
        "audio_tokenizer/preprocessor_config.json",
    ],
)
hf_hub_download(
    repo_id="facebook/audioseal",
    revision="3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba",
    filename="generator_base.pth",
    local_dir="/opt/models/audioseal",
)
hf_hub_download(
    repo_id="facebook/audioseal",
    revision="3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba",
    filename="detector_base.pth",
    local_dir="/opt/models/audioseal",
)
PY

RUN install -d /opt/models/demucs \
    && /opt/venv/bin/python - <<'PY'
from pathlib import Path
from urllib.request import urlopen

target = Path("/opt/models/demucs/955717e8-8726e21a.th")
with urlopen("https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th") as source:
    with target.open("wb") as destination:
        while block := source.read(1024 * 1024):
            destination.write(block)
PY

RUN install -d /opt/models/resemblyzer \
    && cp /opt/venv/lib/python3.11/site-packages/resemblyzer/pretrained.pt /opt/models/resemblyzer/pretrained.pt \
    && find /opt/venv/lib/python3.11/site-packages/resemblyzer -maxdepth 1 -type f -name pretrained.pt -delete \
    && find /opt/models -type d -name .cache -prune -exec rm -rf {} + \
    && /opt/venv/bin/python - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path("/opt/models")
manifest = json.loads(Path("/build/context/MODEL_MANIFEST.json").read_text())
expected = {artifact["path"] for artifact in manifest["artifacts"]}
present = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()}
assert present == expected, sorted(present ^ expected)
for artifact in manifest["artifacts"]:
    path = root / artifact["path"]
    assert path.stat().st_size == artifact["size"], artifact["path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == artifact["sha256"], artifact["path"]
PY

# The source distributions are now installed with pinned build backends and no
# isolation. pip-check and imports prove closure before anything enters runtime.
RUN /opt/venv/bin/pip check \
    && /opt/venv/bin/python - <<'PY'
import importlib

for name in (
    "accelerate", "audioseal", "demucs", "huggingface_hub", "librosa",
    "numpy", "omnivoice", "pydub", "resemblyzer", "runpod", "scipy",
    "soundfile", "tensorboardX", "torch", "torchaudio", "transformers",
    "triton", "webdataset", "webrtcvad",
):
    importlib.import_module(name)
PY

FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime@sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    HF_HOME=/opt/models/.offline-hf-home \
    TORCH_HOME=/opt/models/.offline-torch-home \
    XDG_CACHE_HOME=/tmp/hero-voice-clone-cache \
    HERO_VOICE_EAGER_LOAD=1 \
    RUNPOD_LOG_LEVEL=INFO

LABEL org.opencontainers.image.source="https://github.com/Aoacademy2025/AI_content_Mew_social" \
      org.opencontainers.image.revision="8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb" \
      org.opencontainers.image.base.digest="sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates=20260601~22.04.1 \
       gpgv=2.2.27-3ubuntu2.5 \
       libsndfile1=1.0.31-2ubuntu0.2 \
       libssl3=3.0.2-0ubuntu1.29 \
       openssl=3.0.2-0ubuntu1.29 \
    && apt-get purge -y linux-libc-dev \
    && rm -rf /var/lib/apt/lists/* \
    && /opt/conda/bin/pip uninstall -y Brotli jaraco.context pillow setuptools soupsieve urllib3 wheel \
    && rm -rf /opt/conda/pkgs /opt/conda/etc/conda/test-files \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin worker \
    && install -d -o worker -g worker -m 0700 /tmp/hero-voice-clone-cache

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/models /opt/models
WORKDIR /app
COPY --chown=worker:worker \
    contract.py handler.py identity.py language.py pipeline.py runtime.py \
    MODEL_MANIFEST.json SOURCE_MANIFEST.json RUNTIME_MANIFEST.json THIRD_PARTY_NOTICES.md UPSTREAM.md \
    build-requirements.lock requirements.lock runpod-requirement.lock SBOM.spdx.json verify_image.py \
    /app/

RUN test "$(sha256sum /app/MODEL_MANIFEST.json | cut -d' ' -f1)" = "ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb" \
    && test "$(sha256sum /app/SOURCE_MANIFEST.json | cut -d' ' -f1)" = "6f9ccbc33549f1d309118464bae06c61829f150216218c12c2fd659008bae585" \
    && python -c 'import json; json.dump({"schema_version":1,"worker_version":"hero-voice-clone-contract-v3-internal-eval-2","worker_kind":"clone-only","source_revision":"8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb","source_manifest_sha256":"6f9ccbc33549f1d309118464bae06c61829f150216218c12c2fd659008bae585","model_manifest_sha256":"ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb","base_image":"pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime@sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee"},open("/app/BUILD_ATTESTATION.json","w"),sort_keys=True,separators=(",",":"))' \
    && chmod 0444 /app/BUILD_ATTESTATION.json \
    && ! find /app /opt/models /opt/venv -type d -name .git -print -quit | grep -q . \
    && /opt/venv/bin/pip check \
    && /opt/venv/bin/python -c 'import contract,handler,identity,language,pipeline,runtime'

USER worker
CMD ["python", "-u", "/app/handler.py"]
