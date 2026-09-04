"""Emit Task 3 handler envelopes for Task 2's cross-language contract verifier."""

from __future__ import annotations

import base64
import hashlib
import json
import sys

from contract import EXPERIMENT_PROFILES
from handler import handle_job
from test_contract import FakeRuntime, HandlerTests, valid_payload


def main() -> None:
    fixtures = []
    identity = HandlerTests.identity()
    for profile in sorted(EXPERIMENT_PROFILES):
        payload = valid_payload(profile=profile)
        response = handle_job(
            {"id": f"cross-boundary-{profile}", "input": payload},
            runtime=FakeRuntime(),
            identity=identity,
        )
        if response.get("ok") is not True:
            raise RuntimeError(f"fixture generation failed for {profile}")
        reference = base64.b64decode(payload["ref_audio_b64"], validate=True)
        fixtures.append(
            {
                "profile": profile,
                "response": response,
                "expected": {
                    "workerVersion": identity.worker_version,
                    "imageDigest": identity.image_digest,
                    "sourceRevision": identity.source_revision,
                    "modelManifestSha256": identity.model_manifest_sha256,
                    "experimentProfile": profile,
                    "normalizerVersion": payload["normalizer_version"],
                    "requestCommitmentSha256": payload["request_commitment_sha256"],
                    "matchedSettingsSha256": payload["matched_settings_sha256"],
                    "referenceSha256": hashlib.sha256(reference).hexdigest(),
                    "referenceDurationSamples24000": 5 * 24_000,
                },
            }
        )
    json.dump(fixtures, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
