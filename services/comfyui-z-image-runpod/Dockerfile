# syntax=docker/dockerfile:1
# check=skip=InvalidBaseImagePlatform
FROM runpod/worker-comfyui:5.8.6-base@sha256:bc873b59b613dcd8144db9f9f080e706453f5299268c8b0b7936e07b32dbbd43

ARG Z_IMAGE_MODEL_REVISION=d24c4cf2a0cd98a42f23467e27e3d76ee9438b8e

LABEL org.opencontainers.image.title="HERO AI Z-Image Turbo Runpod worker" \
      org.opencontainers.image.description="Pinned Runpod ComfyUI worker with the official Z-Image Turbo BF16 model bundle" \
      org.opencontainers.image.source="https://github.com/Aoacademy2025/AI_content_Mew_social" \
      org.opencontainers.image.licenses="AGPL-3.0-only AND Apache-2.0"

RUN comfy model download \
      --url "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/${Z_IMAGE_MODEL_REVISION}/split_files/diffusion_models/z_image_turbo_bf16.safetensors" \
      --relative-path models/diffusion_models \
      --filename z_image_turbo_bf16.safetensors \
    && echo "2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6  /comfyui/models/diffusion_models/z_image_turbo_bf16.safetensors" | sha256sum -c -

RUN comfy model download \
      --url "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/${Z_IMAGE_MODEL_REVISION}/split_files/text_encoders/qwen_3_4b.safetensors" \
      --relative-path models/text_encoders \
      --filename qwen_3_4b.safetensors \
    && echo "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a  /comfyui/models/text_encoders/qwen_3_4b.safetensors" | sha256sum -c -

RUN comfy model download \
      --url "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/${Z_IMAGE_MODEL_REVISION}/split_files/vae/ae.safetensors" \
      --relative-path models/vae \
      --filename ae.safetensors \
    && echo "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38  /comfyui/models/vae/ae.safetensors" | sha256sum -c -

# Keep the upstream entrypoint and /start.sh command. SSH remains disabled unless
# an endpoint administrator explicitly supplies PUBLIC_KEY.
