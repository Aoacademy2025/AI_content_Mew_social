#!/usr/bin/env bash
set -euo pipefail

uv pip compile build-requirements.in \
  --python-version 3.11 \
  --python-platform x86_64-unknown-linux-gnu \
  --generate-hashes \
  --refresh \
  --output-file build-requirements.lock

uv pip compile requirements.in \
  --python-version 3.11 \
  --python-platform x86_64-unknown-linux-gnu \
  --generate-hashes \
  --no-emit-package torch \
  --no-emit-package torchaudio \
  --no-emit-package triton \
  --no-emit-package nvidia-cublas-cu12 \
  --no-emit-package nvidia-cuda-cupti-cu12 \
  --no-emit-package nvidia-cuda-nvrtc-cu12 \
  --no-emit-package nvidia-cuda-runtime-cu12 \
  --no-emit-package nvidia-cudnn-cu12 \
  --no-emit-package nvidia-cufft-cu12 \
  --no-emit-package nvidia-curand-cu12 \
  --no-emit-package nvidia-cusolver-cu12 \
  --no-emit-package nvidia-cusparse-cu12 \
  --no-emit-package nvidia-nccl-cu12 \
  --no-emit-package nvidia-nvjitlink-cu12 \
  --no-emit-package nvidia-nvtx-cu12 \
  --no-emit-package typing \
  --refresh \
  --output-file requirements.lock
