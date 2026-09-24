# Task 3 — HERO-51 offline long acoustic evaluation

## Outcome

Branch `codex/hero51-long-offline-20260924` at `431ce583a424b4e5267e0b9f6f2d28efba87bbc5`, based on `origin/main` `3d2c27a65a96f88435bc4e9df45c26b493df0b35`, adds a reproducible, bounded actual-engine benchmark and a noncustomer Thai fixture generator. It does not change the production worker, acoustic clock, selection thresholds, orchestrator, 180-second verification budget, 60-second production acoustic budget, TTS behavior, release gate or Export behavior.

The exact pinned CTC engine completed 120.996, 199.644, 272.242 and 302.491-second synthetic Thai cases inside 60 seconds on this Apple M4 host. The local production-timeout mechanism therefore did not go RED. Per the approved decision rule, no alternate chunking experiment or production fix was made. This result does not clear HERO-51: it narrows the remaining explanation toward deployment hardware/load/lock differences and provides the same loop to run there with noncustomer media.

## Prior evidence and hypotheses

The production-derived refresh records two long Gemini outputs at 197.208 and 266.510 seconds. Verification returned quality failures (`incomplete_alignment` after 152,263 ms and `text_mismatch` after 178,156 ms); these were not verification timeouts and their quality rules remain unchanged. Separate local acoustic attempts timed out after approximately 60 seconds with `timeoutPhase=emissions`. That marker proves only that emissions was the last phase reached when killed; earlier lock, load and decode time was not measured.

Ranked predictions before the experiment:

1. If per-20-second emissions work alone causes the timeout, emissions time should rise with duration and a long case should cross the 60-second cap.
2. If fixed cold load/decode consumes the margin, the successful diagnostics should show those phases taking a material share before emissions.
3. If accumulated emissions cause memory pressure and nonlinear slowdown, long-case RSS and real-time factor should worsen with duration.
4. If Viterbi alignment is the main cost, completed cases should show alignment approaching emissions time despite production's last marker being emissions.

## Runtime and fixture feasibility

Initial discovery found no usable prepared CTC environment: system Python lacked NumPy/Torch/Transformers/SciPy/SoundFile, and no cache contained `airesearch/wav2vec2-large-xlsr-53-th` at the pinned revision. A cached Whisper `small.pt` and a pipx Whisper environment were rejected because Whisper is not this production engine and cannot support its performance or quality claims.

After scope clarification, one-time preparation used a dedicated task artifact root, not a shared or production environment. The venv is Python 3.11.15 with the exact committed requirements: NumPy 2.4.6, SciPy 1.17.1, SoundFile 0.14.0, Torch 2.9.1 and Transformers 4.57.6. The official Hugging Face revision is `3155938c549b23eee16b1d4b55dcb161b7fe4bcf`, reported as 1.26 GB and CC-BY-SA-4.0. Local on-disk sizes were 626 MB for the venv and 2.4 GB for the Hugging Face/Xet cache.

Successful preparation commands:

```sh
mkdir -p /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/{runtime,hf-cache,fixtures,results}
uv venv --clear --python /Users/mewsocialmacmini/.local/share/uv/python/cpython-3.11-macos-aarch64-none/bin/python3.11 /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime
uv pip install --python /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python -r scripts/subtitle-alignment/requirements.txt
HF_HOME=/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/hf-cache \
HF_HUB_CACHE=/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/hf-cache/hub \
/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python \
  scripts/subtitle-alignment/engine.py --download-model
```

Network access occurred only in that explicit preparation. All inference set both `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`.

The fixture generator used the already-installed macOS `Kanya` (`th_TH`) voice and ffmpeg. It created a 6.050-second unit and whole-unit repetitions at 120.996, 199.644, 272.242 and 302.491 seconds. Transcript lengths were 73, 1,479, 2,441, 3,329 and 3,699 characters. Each repetition carries a machine-known media boundary; no customer media, production inference, paid provider, ASR transcript or media download was used. Generated media, manifests and results remain outside git with private file modes.

## RED/GREEN evidence

- `python3 scripts/subtitle-alignment/test_long_benchmark.py` first failed with `ModuleNotFoundError: long_benchmark`; the final suite passes three tests covering invariant summaries, bounded real-child termination/privacy, and preservation of the venv launcher.
- `python3 scripts/subtitle-alignment/test_prepare_long_fixtures.py` first failed with `ModuleNotFoundError: prepare_long_fixtures`. Its first implementation run exposed an off-by-one boundary (`3/7` instead of `4/8` UTF-16 offsets); the final test passes.
- The first actual matrix returned five `unavailable` results in 63 ms because the harness resolved the venv Python symlink to the base interpreter. A regression test now locks the launcher behavior; the corrected matrix used the intended venv and actual model.
- No production behavior change was attempted because the corrected actual-engine long loop stayed green.

Tier-1 review found that the first harness accepted incomplete evidence as `aligned`. Semantic RED was captured against exact commit `2f1a1df0`: the public `run_case` seam received a child result with valid pinned identity, hashes and 2,000 ms duration, but only one of six eligible spans and one of two known boundaries. It reported `status=aligned`, `coveragePermille=167` and `boundariesComplete=false`; an assertion requiring `invalid` failed with `AssertionError: aligned`. The earlier missing-helper import failure was test setup, not semantic RED.

Commit `431ce583` makes `aligned` require an exact ordered match between emitted and eligible spans, with no omissions, duplicates or unexpected spans, plus at least one known boundary and complete boundary matching. The report retains raw emitted, unique, missing, duplicate and unexpected span counts; rounded permille remains display evidence rather than the acceptance predicate. Seven harness tests now cover the existing positive path, missing spans, duplicate spans, no known boundaries, the public child-process regression, timeout privacy and venv launcher identity.

## Actual offline run

Host: macOS 26.2, Apple M4, 16 GiB RAM. Engine: exact committed `engine.py`, two Torch CPU threads. Each case started a new process under a 60,000 ms wall deadline. The first case includes a cold/filesystem-cold load; later processes still load a fresh model but benefit from OS file cache. Peak RSS was sampled from the child every 50 ms. The report retained fixed IDs and numeric evidence only.

```sh
python3 scripts/subtitle-alignment/prepare_long_fixtures.py \
  /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/fixtures

HF_HOME=/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/hf-cache \
HF_HUB_CACHE=/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/hf-cache/hub \
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python \
  scripts/subtitle-alignment/long_benchmark.py \
  /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/fixtures/manifest.json \
  /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/results/report-60s.json \
  --python /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python \
  --cache-dir /Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/results/cache \
  --deadline-ms 60000 --threads 2
```

| Audio | Total | Model load | Decode | Emissions | Alignment | Peak RSS | Eligible coverage | Synthetic boundary max / drift max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6.050 s | 4.198 s | 2.928 s | 0.440 s | 0.394 s | 0.002 s | 1.950 GB | 100.0% | 43 / 0 ms |
| 120.996 s | 11.350 s | 1.478 s | 0.248 s | 9.080 s | 0.220 s | 3.363 GB | 100.0% | 57 / 14 ms |
| 199.644 s | 17.705 s | 1.611 s | 0.219 s | 14.857 s | 0.612 s | 3.378 GB | 100.0% | 57 / 14 ms |
| 272.242 s | 23.753 s | 1.468 s | 0.215 s | 20.665 s | 1.042 s | 3.386 GB | 100.0% | 57 / 14 ms |
| 302.491 s | 28.087 s | 1.661 s | 0.216 s | 24.504 s | 1.312 s | 3.276 GB | 100.0% | 57 / 14 ms |

All outputs matched the pinned model identity, audio duration, audio/text hashes and monotonic character/time invariants. Emissions used approximately 0.074–0.081 seconds per second of long audio. The 302.491-second case retained 31.913 seconds of the production deadline. Alignment remained 1.312 seconds or less. Long-case RSS was approximately 3.28–3.39 GB, operationally material but not by itself evidence of pressure on the 15 GB deployment host.

The full model matrix was not repeated after the validation-only fix. Revalidation used the retained numeric report and original manifest: every case records `monotonic=true`, emitted character count exactly equal to eligible character count (72/72, 1,440/1,440, 2,376/2,376, 3,240/3,240 and 3,600/3,600), and matched boundary count equal to the manifest's nonzero expected count (1/1, 20/20, 33/33, 45/45 and 50/50). In the old validator, monotonicity also required every emitted span to be eligible and non-overlapping, so these retained raw counts rule out omission, duplication and unexpected spans for the measured outputs. All five measurements satisfy the strengthened predicate without rerunning inference.

The duration-only hypothesis did not reproduce on this host. Cold load was 2.928 seconds and OS-cache-assisted loads were 1.468–1.661 seconds, too small to explain a 60-second timeout here. Emissions scaled roughly linearly rather than showing a decisive nonlinear rise; alignment was secondary. Deployment CPU contention, cleanup overlap, lock wait, scheduling and hardware remain unisolated. The production last-phase marker cannot apportion their earlier cost.

## Delivered files

- `scripts/subtitle-alignment/long_benchmark.py`: actual-engine, offline-only, per-process deadline, RSS/phase capture, identity/duration/coverage/monotonicity/boundary checks, numeric private report.
- `scripts/subtitle-alignment/prepare_long_fixtures.py`: local macOS Thai speech fixture generation with whole-phrase repetition and known boundaries.
- Two Python regression files; CI runs them without model weights.
- `scripts/subtitle-alignment/README.md`: preparation, invocation and qualification limits.

No artifacts, weights, audio, manifest, generated transcript or benchmark JSON were committed.

## Verification

```sh
/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python scripts/subtitle-alignment/test_engine.py
/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python scripts/subtitle-alignment/test_prepare_long_fixtures.py
/Users/mewsocialmacmini/orca/artifacts/hero51-long-offline-20260924/runtime/bin/python scripts/subtitle-alignment/test_long_benchmark.py
npm run verify:acoustic-subtitle-clock
npm run verify:subtitle-audio-sync
git diff --check
```

- Python: 5 engine tests, 1 fixture test and 7 harness tests passed.
- `verify:acoustic-subtitle-clock`: all four acoustic repeat/share/clock/worker verifiers passed.
- The first `verify:subtitle-audio-sync` run had a transient preview assertion failure (`A: progress 100`) after 107 other preview assertions passed; all provider/acoustic alignment checks passed. This was checked rather than assumed: an exact-base archive and the branch both passed the isolated preview verifier on the next run, 108/108. The base command was `git archive 3d2c27a65a96f88435bc4e9df45c26b493df0b35 | tar -x -C "$baseline_dir"`, followed inside that disposable archive by `node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-preview-mode.ts`, reusing the branch's read-only `node_modules`; exit code was 0. The same Node command at branch HEAD also exited 0.
- `git diff --check` and Python compile checks passed.
- No full build was run here; the root task coordinates one combined build after integrating all reviewed heads.

## Limits and next gate

The repeated OS voice is useful for runtime scaling, exact-script coverage, monotonicity and cumulative boundary drift. It is not varied natural Thai, an independent human timing reference, production hardware or concurrent production load. Silence/fake models were not used as Thai quality evidence, and the successful result does not override the two production timeouts or the independent verification quality failures.

Run the same offline harness on deployment-equivalent CPU/storage with this noncustomer fixture and representative safe contention while retaining the 60-second deadline. If that actual loop goes RED in emissions, then compare an alternate bounded chunk strategy against the same short known-boundary case and all long durations, requiring full coverage, monotonic timestamps, stable boundaries and no higher RSS. Until that gate exists, a chunking or budget change would be speculative. HERO-51 remains In Progress.
