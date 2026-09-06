"""RunPod Serverless adapter for the clone-only contract-v3 worker."""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import threading
from typing import Any

from contract import ContractError, ErrorCode, failure_envelope, parse_request
from identity import WorkerIdentity, load_worker_identity, verify_worker_identity
from pipeline import PipelineError, run_pipeline


LOGGER = logging.getLogger("hero_voice_clone")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logging.getLogger().setLevel(logging.INFO)
GENERATION_LOCK = threading.Lock()
_RUNTIME: Any = None
_RUNTIME_LOCK = threading.Lock()


def _job_fingerprint(job: Any) -> str:
    raw = "unknown"
    if isinstance(job, dict) and isinstance(job.get("id"), (str, int)):
        raw = str(job["id"])
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:12]


def _default_runtime():
    global _RUNTIME
    if _RUNTIME is None:
        with _RUNTIME_LOCK:
            if _RUNTIME is None:
                from runtime import CloneRuntime

                _RUNTIME = CloneRuntime()
    return _RUNTIME


def _success_envelope(request: Any, identity: WorkerIdentity, result: Any) -> dict[str, Any]:
    return {
        "ok": True,
        "contract_version": 3,
        "mode": "clone",
        "worker_kind": identity.worker_kind,
        "worker_version": identity.worker_version,
        "image_digest": identity.image_digest,
        "source_revision": identity.source_revision,
        "model_manifest_sha256": identity.model_manifest_sha256,
        "experiment_profile": request.experiment_profile,
        "normalizer_version": request.normalizer_version,
        "mixed_language": True,
        "request_commitment_sha256": request.request_commitment_sha256,
        "matched_settings_sha256": request.matched_settings_sha256,
        "audio_base64": base64.b64encode(result.wav_bytes).decode("ascii"),
        "format": "wav",
        "sample_rate": 24_000,
        "channels": 1,
        "subtype": "PCM_16",
        "num_samples": result.num_samples,
        "duration_ms": round(result.num_samples * 1_000 / 24_000),
        "stages": result.stages,
        "metrics": result.metrics,
        "timing_ms": result.timing_ms,
    }


def handle_job(job: Any, *, runtime: Any = None, identity: WorkerIdentity | None = None) -> dict[str, Any]:
    fingerprint = _job_fingerprint(job)
    try:
        payload = job.get("input") if isinstance(job, dict) else None
        request = parse_request(payload)
        selected_identity = identity or load_worker_identity()
        verify_worker_identity(selected_identity)
        selected_runtime = runtime or _default_runtime()
        LOGGER.info(
            "generation_started job=%s profile=%s seed=%d",
            fingerprint,
            request.experiment_profile,
            request.seed,
        )
        with GENERATION_LOCK:
            result = run_pipeline(request, selected_runtime)
        response = _success_envelope(request, selected_identity, result)
        LOGGER.info(
            "generation_completed job=%s profile=%s duration_ms=%d total_ms=%d",
            fingerprint,
            request.experiment_profile,
            response["duration_ms"],
            result.timing_ms["total"],
        )
        return response
    except ContractError as error:
        LOGGER.info("generation_rejected job=%s code=%s", fingerprint, error.code.value)
        return failure_envelope(error.code)
    except PipelineError as error:
        LOGGER.info("generation_failed job=%s code=%s", fingerprint, error.code.value)
        return failure_envelope(error.code)
    except Exception:
        LOGGER.error("generation_failed job=%s code=%s", fingerprint, ErrorCode.INTERNAL_ERROR.value)
        return failure_envelope(ErrorCode.INTERNAL_ERROR)


handler = handle_job


if __name__ == "__main__":
    if os.environ.get("HERO_VOICE_EAGER_LOAD") != "1":
        raise RuntimeError("HERO_VOICE_EAGER_LOAD=1 is required in the release image")
    if os.environ.get("RUNPOD_LOG_LEVEL") != "INFO":
        raise RuntimeError("RUNPOD_LOG_LEVEL=INFO is required in the release image")
    load_worker_identity()
    _default_runtime()
    import runpod

    runpod.serverless.start({"handler": handler})
