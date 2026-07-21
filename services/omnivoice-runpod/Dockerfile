# syntax=docker/dockerfile:1
# check=skip=InvalidBaseImagePlatform
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime@sha256:ac7c098a81512e719afa5d2d497f812d7db3498f340a4b819c69cb7b3b257126

ARG OMNIVOICE_SOURCE_COMMIT=346bb75330980a236540d61a0808d00767c0973b
ARG OMNIVOICE_MODEL_REVISION=c5fdb5ccb189668d56333f77ba2629f4cd7535f4
ARG OMNIVOICE_MODEL_SHA256=730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TTS_MODEL_DIR=/app/model \
    TTS_VOICES_DIR=/app/voices \
    TTS_VOICE_IDS=voice_01,voice_02,voice_03 \
    TTS_MAX_TEXT_LENGTH=800 \
    TTS_DEFAULT_NUM_STEP=4 \
    TTS_MAX_WAV_BYTES=7000000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && pip install --no-cache-dir "huggingface_hub==1.23.0"

RUN git clone --filter=blob:none https://github.com/k2-fsa/OmniVoice.git /app/OmniVoice \
    && git -C /app/OmniVoice checkout --detach "${OMNIVOICE_SOURCE_COMMIT}" \
    && pip install --no-cache-dir --no-deps /app/OmniVoice

RUN python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='k2-fsa/OmniVoice', revision='${OMNIVOICE_MODEL_REVISION}', local_dir='/app/model')" \
    && echo "${OMNIVOICE_MODEL_SHA256}  /app/model/model.safetensors" | sha256sum -c -

COPY contract.py handler.py /app/
COPY assets/voices/ /app/voices/
RUN python -c "from pathlib import Path; root=Path('/app/voices'); required=['voices.json','voice_01.wav','voice_02.wav','voice_03.wav']; missing=[name for name in required if not (root/name).is_file()]; assert not missing, f'missing voice assets: {missing}'"

RUN useradd --create-home --uid 10001 worker \
    && chown -R worker:worker /app
USER worker

CMD ["python", "-u", "/app/handler.py"]
