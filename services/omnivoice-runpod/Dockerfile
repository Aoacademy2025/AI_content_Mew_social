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
    TTS_LAO_VOICES_DIR=/app/voices_lao \
    TTS_CUSTOM_VOICES_DIR=/tmp/hero-voice-custom \
    TTS_VOICES_DB=/tmp/hero-voice-custom/voices.db \
    TTS_VOICE_IDS="" \
    TTS_BASE_SPEED=1.0 \
    TTS_MAX_TEXT_LENGTH=800 \
    TTS_MAX_WAV_BYTES=7000000 \
    TTS_MAX_CONCURRENCY=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && pip install --no-cache-dir -r /app/requirements.txt \
    && pip install --no-cache-dir "huggingface_hub==1.23.0" \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --filter=blob:none https://github.com/k2-fsa/OmniVoice.git /app/OmniVoice \
    && git -C /app/OmniVoice checkout --detach "${OMNIVOICE_SOURCE_COMMIT}" \
    && pip install --no-cache-dir --no-deps /app/OmniVoice

RUN useradd --create-home --uid 10001 worker \
    && install -d -o worker -g worker /app/model /app/voices
USER worker

RUN python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='k2-fsa/OmniVoice', revision='${OMNIVOICE_MODEL_REVISION}', local_dir='/app/model')" \
    && echo "${OMNIVOICE_MODEL_SHA256}  /app/model/model.safetensors" | sha256sum -c -

COPY --chown=worker:worker \
    contract.py handler.py server.py text_utils.py voice_similarity.py voice_library.py credits.py engine_indextts.py \
    asr_engine.py watermark.py gemini_translit.py audio_enhance.py \
    /app/
COPY --chown=worker:worker data/ /app/data/
COPY --chown=worker:worker assets/voices/ /app/voices/
COPY --chown=worker:worker assets/voices_lao/ /app/voices_lao/
# Manifest ชุดหลักตอนนี้เหลือ 33 เสียง (upstream 10649b5 ตัดเสียงสำเนียงต่างชาติ + เสียงกระซิบออก
# — ต้องตรงกับ _FOREIGN_ACCENT_IDS ใน server.py) ส่วนชุดลาวแยกอยู่ /app/voices_lao (lao_01..08)
RUN python -c "import json, soundfile as sf; from pathlib import Path; root=Path('/app/voices'); manifest=json.loads((root/'voices.json').read_text()); removed={16,27,28,29,30,31,32,33,38,39,40,41,42,43,48}; expected=[f'voice_{n:02d}' for n in range(1,49) if n not in removed]; ids=[v['id'] for v in manifest]; assert ids == expected, f'invalid voice IDs: {ids}'; required=('desc','instruct','ref_audio','ref_text');bad_meta=[v.get('id') for v in manifest if any(not isinstance(v.get(key), str) or not v[key].strip() for key in required)]; assert not bad_meta, f'invalid voice metadata: {bad_meta}'; missing=[v['ref_audio'] for v in manifest if not (root/v['ref_audio']).is_file()]; assert not missing, f'missing voice assets: {missing}'; infos=[(v['ref_audio'], sf.info(root/v['ref_audio'])) for v in manifest]; bad=[name for name, info in infos if info.samplerate != 24000 or info.channels != 1 or not 1.5 <= info.duration <= 10]; assert not bad, f'invalid voice assets: {bad}'; lao=Path('/app/voices_lao'); lao_manifest=json.loads((lao/'voices.json').read_text()); lao_ids=[v['id'] for v in lao_manifest]; assert lao_ids == [f'lao_{n:02d}' for n in range(1,len(lao_ids)+1)] and lao_ids, f'invalid lao voice IDs: {lao_ids}';lao_missing=[v['ref_audio'] for v in lao_manifest if not (lao/v['ref_audio']).is_file()]; assert not lao_missing, f'missing lao assets: {lao_missing}'; lao_bad=[v['ref_audio'] for v in lao_manifest if (lambda i: i.samplerate != 24000 or i.channels != 1)(sf.info(lao/v['ref_audio']))]; assert not lao_bad, f'invalid lao assets: {lao_bad}'"

CMD ["python", "-u", "/app/handler.py"]
