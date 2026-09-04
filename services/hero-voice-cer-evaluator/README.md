# Hero Voice CER evaluator

This directory defines the offline canonical Thai CER contract and deterministic synthetic test doubles for Task 5. Canonical scoring is restricted to non-emulated `linux/arm64`, CPU-only execution, a local SHA-256-pinned `large-v3-turbo.pt`, exact single-thread FFmpeg conversion, and runtime networking disabled by an independently mounted attestation.

`RUNTIME_LOCK.json` is deliberately blocked. The current Mac has no Docker/Podman or independently attested non-emulated Linux/arm64 runtime, and the authoritative arm64 base-image digest, complete hash-locked Python wheel closure, and FFmpeg package/binary identity are not available. `verify_lock.py --apply` and the Docker build therefore fail closed. Task 6 must supply and review those facts; Task 5 does not invent them or download a model.

Local contract tests use only synthetic bytes:

```sh
python -m unittest -v test_evaluator.py
python -m compileall -q .
python verify_lock.py --expect-blocked
```

Once Task 6 has replaced and authenticated the complete lock and supplied the local pinned model plus runtime attestations, the real batch entrypoint is:

```text
python evaluator.py --batch {ablation-8,final-36} INVENTORY OUTPUT MODEL FIXTURE_WAV FIXTURE_EXPECTED
```

All paths are absolute. `INVENTORY` is exact JCS with exactly 8 or 36 unique declared WAV basenames, hashes, slot IDs, and expected texts. The command checks every source hash, scores one uninterrupted loaded-model batch, runs three fresh-process canonical fixtures before and after, proves the runtime fingerprint unchanged, and creates one mode-`0600` exact-JCS result without overwriting. It fails before scoring while the Task 6 lock remains incomplete.
