# Build memory sampler

Use `scripts/build_memory_sampler.py` only with the next necessary Linux build. It is an opt-in diagnostic; it is not wired into deployment and does not change Node heap settings.

The sampler follows one deploy-shell PID and its current descendants once per second. It writes a new mode-0600 JSONL file with PID, PPID, `/proc/<pid>/stat` start time, fixed process role, fixed build stage, numeric effective compiler heap, `smaps_rollup` RSS/PSS/private/shared/swap values, and host `MemAvailable`/swap values. It reads command lines and the compiler environment only long enough to derive allowlisted fields. Raw command lines, environment entries, log text, URLs, and application data are never written.

## Preconditions

- Run only when the approved build is already necessary and host-workload coordination says it is safe.
- Run as the same account as the build, or another account allowed to read that process tree's `/proc` files.
- Create a private record directory and a fresh private build log. The optional log parser recognizes only fixed Next/build markers; omit `--log-path` to record `unknown` stage.
- The output path must not exist. The default limits are 1-second intervals, 30 minutes, and 64 MiB. Hard limits are 2 hours and 256 MiB.

## Direct or nohup launch

Wrap the already-authorized build command so its shell remains the sampled root. This example survives SSH loss because both processes use `nohup`:

```bash
umask 077
record_dir=/var/lib/heroai/releases/RELEASE_ID
build_log="$record_dir/build.log"
mkdir -p "$record_dir"
chmod 700 "$record_dir"
test ! -e "$build_log"
touch "$build_log"
chmod 600 "$build_log"

nohup /bin/bash deploy/deploy.sh >"$build_log" 2>&1 </dev/null &
build_pid=$!
nohup /usr/bin/python3 scripts/build_memory_sampler.py \
  --root-pid "$build_pid" \
  --log-path "$build_log" \
  --output "$record_dir/build-memory.jsonl" \
  >"$record_dir/build-memory-sampler.log" 2>&1 </dev/null &
```

For a build already running in a persistent systemd service, read that service's `MainPID`, then launch the sampler in its own transient service:

```bash
build_pid=$(sudo systemctl show --property MainPID --value hero-build.service)
sudo systemd-run \
  --unit="hero-build-memory-RELEASE_ID" \
  --collect \
  --uid=hero \
  --working-directory=/srv/hero \
  /usr/bin/python3 scripts/build_memory_sampler.py \
    --root-pid "$build_pid" \
    --log-path /var/lib/heroai/releases/RELEASE_ID/build.log \
    --output /var/lib/heroai/releases/RELEASE_ID/build-memory.jsonl
```

Use the actual build service, account, working directory, release ID, and private paths. Do not start another build just to collect this measurement.

## Reading the result

The final `summary` record reports why sampling stopped, tree RSS/PSS/private/swap peaks with timestamps and stages, baseline and minimum host `MemAvailable`, and the ten highest per-process PSS peaks. Raw `sample` records remain the audit trail. Compare:

- RSS inflation: `tree.rss_kib - tree.pss_kib`
- private pressure: `tree.private_kib`
- host impact: `summary.host.mem_available_drop_kib`
- heap truth: `effective_max_old_space_size_mib` on `webpack-compiler` rows

The heap field applies Node's supported hyphen or underscore flag before the `processChild.js` entrypoint; that command-line value overrides `NODE_OPTIONS`. Flags passed to the worker script are ignored. An ambiguous or unsupported explicit heap form records `null` rather than claiming an effective limit.

A child that exits between `/proc` reads is retained with `status: exited_during_sample` and `memory_kib: null`; a reused child PID is `pid_reused_during_sample`. Neither becomes a zero-memory observation. That sample's tree totals are also `null`, and peak calculations skip it. The sampler stops if the root exits, its PID is reused, duration expires, or the output limit is reached. This tool does not use cgroup `memory.peak`.

## Synthetic check

The scoped test creates a fake Linux `/proc` tree and launches no build:

```bash
env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/python3 -m unittest scripts.test_build_memory_sampler
```
