# Hero Voice CER evaluator

This directory defines the offline canonical Thai CER contract and deterministic synthetic test doubles for Task 5. Canonical scoring is restricted to non-emulated `linux/arm64`, CPU-only execution, a local SHA-256-pinned `large-v3-turbo.pt`, exact single-thread FFmpeg conversion, and runtime networking disabled by an independently mounted attestation.

`RUNTIME_LOCK.json` is deliberately blocked. The current Mac has no Docker/Podman or independently attested non-emulated Linux/arm64 runtime, and the authoritative arm64 base-image digest, complete hash-locked Python wheel closure, and FFmpeg package/binary identity are not available. Both preparation and canonical execution therefore fail closed. Task 6 must supply and review those facts; the tools here do not invent pins, download models, install a host runtime, or enable execution.

Local contract tests use only synthetic bytes:

```sh
python -m unittest -v test_evaluator.py test_verify_lock.py
python -m compileall -q .
python verify_lock.py --expect-blocked
```

Once Task 6 has replaced and authenticated the complete lock and supplied the local pinned model plus runtime attestations, the real batch entrypoint is:

```text
python evaluator.py --batch {ablation-8,final-36} INVENTORY OUTPUT MODEL FIXTURE_WAV FIXTURE_EXPECTED
```

All paths are absolute. `INVENTORY` is exact JCS with exactly 8 or 36 unique declared WAV basenames, hashes, slot IDs, and expected texts. The command checks every source hash, scores one uninterrupted loaded-model batch, runs three fresh-process canonical fixtures before and after, proves the runtime fingerprint unchanged, and creates one mode-`0600` exact-JCS result without overwriting. It fails before scoring while the Task 6 lock remains incomplete.

## Dependency preparation and qualification

Preparation produces review inputs; it is not a runtime attestation. The lock uses schema version 2 and binds the exact `requirements.lock` bytes with `dependencyLockSha256`. Every distribution needs one exact version and at least one SHA-256. Includes, indexes, URLs, markers, extras, duplicate normalized package names and unpinned dependencies are rejected. Direct NumPy/PyTorch versions still need an explicit qualified choice; none is selected by the preparation tool.

1. On an independently verified native Linux/arm64 VM on this Apple-silicon Mac, prepare a Debian-family base with Python 3.11 or later and FFmpeg already installed. Record the base's immutable arm64 manifest digest, Python/installer versions, FFmpeg Debian package version and binary SHA-256. Pin the OS package/build closure in that base's provenance. The evaluator Dockerfile does not install mutable apt packages. The separately recorded host/VM/container readback must prove emulation is absent; an environment variable alone is not evidence.
2. Supply one compatible wheel per distribution for the complete runtime closure, including `openai-whisper==20250625` and reviewed exact NumPy/PyTorch versions. Retain upstream artifact hashes and native build provenance. If a distribution is available only as source, build its wheel separately with fully locked build dependencies and retain the source-to-wheel evidence. Source builds are forbidden in the evaluator Dockerfile. Include inherited Python distributions such as setuptools in the lock if the chosen base contains them; only the base's pip installer may be outside the runtime lock.
3. Place those wheels in an ignored, dedicated `wheelhouse/` directory. Run the following command with actual absolute paths to generate a new review file. It refuses existing output paths, source archives, symlinks, duplicate distributions and inconsistent wheel metadata. It reads wheel metadata and hashes without importing or executing wheel code. Its synthetic unit-test wheels are never usable runtime artifacts.

   ```sh
   python prepare_wheel_lock.py --wheelhouse /absolute/evaluator/wheelhouse --output /absolute/review/requirements.lock
   ```

4. Review and replace `requirements.lock` with that output. Populate the measured base/FFmpeg identities and printed dependency hash in `RUNTIME_LOCK.json`; mark `pythonLockComplete` only after the native wheel resolution and installation closure have been reviewed. Keep `canonicalExecutionEnabled:false`. Remove only resolved blockers; `--prepare` permits the outstanding `non_emulated_linux_arm64_runtime_attestation_missing` blocker but rejects any other outstanding blocker. The tool never modifies this manifest.
5. Run `python verify_lock.py --prepare --base-image 'repository@sha256:ACTUAL_DIGEST'` before building. Then supply that same immutable reference through `EVALUATOR_BASE_IMAGE_MUST_BE_DIGEST_PINNED` to the Docker build, with this service directory as context and `wheelhouse/` present. BuildKit installs only the hashed local wheels with `--network=none`, `--no-index` and `--only-binary`. Native pip validates wheel compatibility and dependency resolution. The post-install verifier requires the exact installed distribution/version set, a successful `pip check`, the measured FFmpeg binary hash and matching `dpkg-query` package version. No model or private audio enters the build context.
6. Independently record the resulting index/arm64 image digest, source revision, SBOM and host/container identity. With networking disabled and read-only mounts for the pinned model, non-sensitive WAV fixture, expected text and external network-disabled attestation, run the existing `--canonical-fixture WAV EXPECTED MODEL` command in three fresh processes and compare exact outputs. This fixture qualification path accepts a prepared lock; `--batch` still rejects it until canonical execution is explicitly enabled following reviewed runtime evidence. Set the documented thread variables and measured `HERO_VOICE_EVALUATOR_*` runtime values; do not manufacture attestations from those values.
7. Only after qualification review, record the approved lock/flag change and rebuild. Re-read the final image digest and repeat the offline cold-start/fixture checks on that exact final image before any paid job. Canonical batches require `--apply`-complete lock state and perform installed-runtime checks again; each actual `ablation-8` and `final-36` batch still needs its own immediately preceding/following three-process fixtures and matching runtime fingerprint. A passed preparation check is never permission to send human audio or a substitute for Task 6's separate gates.

For an already prepared image, `python verify_lock.py --prepare --base-image 'repository@sha256:ACTUAL_DIGEST' --installed` verifies the actual installation without enabling scoring. For a qualified image, use `python verify_lock.py --apply --installed`. Keep wheel/model/audio binaries and raw fixture evidence outside Git and CI artifacts. The native image build, wheel compatibility, provenance and real fixture measurements remain unverified on the current Darwin host.
