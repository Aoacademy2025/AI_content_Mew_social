# syntax=docker/dockerfile:1.7
# Intentionally non-buildable in Task 5. Task 6 must replace the build argument
# with the independently read-back linux/arm64 digest and complete RUNTIME_LOCK.
ARG EVALUATOR_BASE_IMAGE_MUST_BE_DIGEST_PINNED
FROM --platform=linux/arm64 ${EVALUATOR_BASE_IMAGE_MUST_BE_DIGEST_PINNED}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    CUDA_VISIBLE_DEVICES="" \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    TORCH_HOME=/opt/models/.offline

WORKDIR /opt/evaluator
COPY RUNTIME_LOCK.json requirements.lock verify_lock.py ./
RUN python verify_lock.py --apply \
    && python -m pip install --no-cache-dir --require-hashes -r requirements.lock
COPY canonical.py evaluator.py ./
USER 65532:65532
ENTRYPOINT ["python", "/opt/evaluator/evaluator.py"]
