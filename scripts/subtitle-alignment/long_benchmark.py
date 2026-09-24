"""Bounded, offline benchmark for the real Thai CTC engine.

The manifest may contain synthetic transcript text and local paths. The report
contains fixed identifiers and numeric evidence only. Runtime is forced offline;
model preparation remains an explicit, separate step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import subprocess
import threading
import time
import unicodedata
from pathlib import Path


VERSION = "thai-ctc-v1"
REVISION = "3155938c549b23eee16b1d4b55dcb161b7fe4bcf"
PHASES = {"lockWait", "modelLoad", "audioDecode", "emissions", "alignment"}


def runtime_executable(path: Path) -> Path:
    """Keep a venv launcher intact; resolving its symlink discards the venv."""
    executable = path.absolute()
    if not executable.is_file():
        raise FileNotFoundError(executable)
    return executable


def _eligible_offsets(text: str) -> set[tuple[int, int]]:
    offsets: set[tuple[int, int]] = set()
    offset = 0
    for character in text:
        size = len(character.encode("utf-16-le")) // 2
        if unicodedata.category(character)[0] in "LMN" and character not in "ฯๆ":
            offsets.add((offset, offset + size))
        offset += size
    return offsets


def _median(values: list[int]) -> int | None:
    return round(statistics.median(values)) if values else None


def is_aligned_result(summary: dict) -> bool:
    return all(summary.get(key) is True for key in (
        "identityValid", "monotonic", "durationWithinTolerance",
        "eligibleSpansComplete", "boundariesComplete",
    ))


def validate_result(case: dict, result: dict) -> dict:
    """Return content-free timing invariants for one successful engine result."""
    text = case["text"]
    characters = result.get("characters")
    eligible = _eligible_offsets(text)
    valid_identity = result.get("version") == VERSION and result.get("modelRevision") == REVISION
    valid_characters = isinstance(characters, list) and bool(characters)
    monotonic = valid_characters
    matched: dict[int, int] = {}
    emitted_spans: list[tuple[int, int]] = []
    previous_char = previous_ms = -1
    if valid_characters:
        for character in characters:
            try:
                span = (character["startChar"], character["endChar"])
                if not all(isinstance(value, int) for value in span):
                    monotonic = False
                    break
                emitted_spans.append(span)
                monotonic = monotonic and span in eligible
                monotonic = monotonic and character["startChar"] >= previous_char
                monotonic = monotonic and character["startMs"] >= previous_ms
                monotonic = monotonic and 0 <= character["startMs"] < character["endMs"] <= result["audioDurationMs"]
                monotonic = monotonic and 0 <= character["confidence"] <= 1
                previous_char = character["endChar"]
                previous_ms = character["endMs"]
                matched[character["startChar"]] = character["startMs"]
            except (KeyError, TypeError):
                monotonic = False
                break
    boundary_errors = [
        matched[boundary["startChar"]] - boundary["referenceMs"]
        for boundary in case.get("boundaries", [])
        if boundary.get("startChar") in matched
    ]
    origin = boundary_errors[0] if boundary_errors else 0
    boundary_drift = [error - origin for error in boundary_errors]
    absolute_errors = [abs(error) for error in boundary_errors]
    expected_duration = case.get("expectedDurationMs")
    duration_delta = result.get("audioDurationMs") - expected_duration if isinstance(expected_duration, int) else None
    expected_boundaries = len(case.get("boundaries", []))
    emitted_eligible = [span for span in emitted_spans if span in eligible]
    unique_emitted_eligible = set(emitted_eligible)
    return {
        "identityValid": valid_identity,
        "monotonic": bool(monotonic),
        "characterCount": len(characters) if isinstance(characters, list) else 0,
        "eligibleCharacterCount": len(eligible),
        "emittedSpanCount": len(emitted_spans),
        "emittedEligibleSpanCount": len(emitted_eligible),
        "uniqueEmittedEligibleSpanCount": len(unique_emitted_eligible),
        "missingEligibleSpanCount": len(eligible - unique_emitted_eligible),
        "duplicateEligibleSpanCount": len(emitted_eligible) - len(unique_emitted_eligible),
        "unexpectedSpanCount": len(emitted_spans) - len(emitted_eligible),
        "eligibleSpansComplete": emitted_spans == sorted(eligible),
        "coveragePermille": round(1000 * len(unique_emitted_eligible) / len(eligible)) if eligible else 0,
        "durationDeltaMs": duration_delta,
        "durationWithinTolerance": duration_delta is None or abs(duration_delta) <= 250,
        "boundaryCount": len(boundary_errors),
        "boundaryExpectedCount": expected_boundaries,
        "boundariesComplete": expected_boundaries > 0 and len(boundary_errors) == expected_boundaries,
        "boundaryAbsoluteMedianMs": _median(absolute_errors),
        "boundaryAbsoluteMaxMs": max(absolute_errors, default=None),
        "boundaryDriftMedianMs": _median([abs(value) for value in boundary_drift]),
        "boundaryDriftMaxMs": max((abs(value) for value in boundary_drift), default=None),
    }


def _rss_bytes(pid: int) -> int:
    try:
        value = subprocess.run(
            ["/bin/ps", "-o", "rss=", "-p", str(pid)],
            check=False, capture_output=True, text=True, timeout=1,
        ).stdout.strip()
        return int(value) * 1024 if value else 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def run_case(case: dict, python: Path, engine: Path, deadline_ms: int, threads: int, cache_dir: Path) -> dict:
    identifier = case.get("id")
    if not isinstance(identifier, str) or not identifier or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for c in identifier):
        raise ValueError("benchmark_id_invalid")
    audio_path = Path(case["audioPath"]).resolve(strict=True)
    audio = audio_path.read_bytes()
    audio_hash = hashlib.sha256(audio).hexdigest()
    text_hash = hashlib.sha256(case["text"].encode()).hexdigest()
    request = json.dumps({"audioPath": str(audio_path), "audioHash": audio_hash, "text": case["text"]})
    environment = {
        **os.environ,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "SUBTITLE_ACOUSTIC_CACHE_DIR": str(cache_dir),
        "SUBTITLE_ACOUSTIC_THREADS": str(threads),
    }
    started = time.monotonic()
    process = subprocess.Popen(
        [str(python), str(engine)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=environment,
    )
    stdout: list[str] = []
    phase_events: list[tuple[str, int]] = []
    lock = threading.Lock()

    def read_stdout():
        assert process.stdout
        stdout.append(process.stdout.read(2_000_001))

    def read_stderr():
        assert process.stderr
        for line in process.stderr:
            prefix = "HERO_ACOUSTIC_PHASE="
            if line.startswith(prefix):
                phase = line[len(prefix):].strip()
                if phase in PHASES:
                    with lock:
                        phase_events.append((phase, round((time.monotonic() - started) * 1000)))

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    assert process.stdin
    process.stdin.write(request)
    process.stdin.close()
    peak_rss = 0
    timed_out = False
    while process.poll() is None:
        elapsed_ms = round((time.monotonic() - started) * 1000)
        peak_rss = max(peak_rss, _rss_bytes(process.pid))
        if elapsed_ms >= deadline_ms:
            timed_out = True
            process.kill()
            break
        time.sleep(.05)
    process.wait()
    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)
    if process.stdout:
        process.stdout.close()
    if process.stderr:
        process.stderr.close()
    duration_ms = round((time.monotonic() - started) * 1000)
    with lock:
        events = list(phase_events)
    row = {
        "id": identifier,
        "status": "timeout" if timed_out else "unavailable",
        "durationMs": duration_ms,
        "deadlineMs": deadline_ms,
        "exitCode": process.returncode,
        "peakRssBytes": peak_rss,
        "lastPhase": events[-1][0] if events else "startup",
        "phaseReachedAtMs": {phase: elapsed for phase, elapsed in events},
    }
    if timed_out:
        row["timeoutPhase"] = row["lastPhase"]
        return row
    try:
        result = json.loads("".join(stdout))
    except (json.JSONDecodeError, TypeError):
        return row
    if process.returncode != 0 or result.get("error"):
        return row
    if result.get("audioHash") != audio_hash or result.get("textHash") != text_hash:
        row["status"] = "invalid"
        return row
    summary = validate_result(case, result)
    row.update(summary)
    row["audioDurationMs"] = result.get("audioDurationMs")
    phase_timings = result.get("diagnostics", {}).get("phaseTimingsMs")
    if isinstance(phase_timings, dict):
        row["phaseTimingsMs"] = {
            phase: round(value) for phase, value in phase_timings.items()
            if phase in PHASES and isinstance(value, (int, float)) and 0 <= value <= 600_000
        }
    row["status"] = "aligned" if is_aligned_result(summary) else "invalid"
    return row


def main() -> None:
    parser = argparse.ArgumentParser(description="Run bounded offline cases through the real pinned CTC engine")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--engine", type=Path, default=Path(__file__).with_name("engine.py"))
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--deadline-ms", type=int, default=60_000)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.deadline_ms <= 180_000 or not 1 <= args.threads <= 4:
        raise SystemExit("benchmark_bounds_invalid")
    rows = json.loads(args.manifest.read_text())
    if not isinstance(rows, list) or not rows:
        raise SystemExit("benchmark_manifest_invalid")
    args.cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence = [run_case(row, runtime_executable(args.python), args.engine.resolve(strict=True),
                         args.deadline_ms, args.threads, args.cache_dir) for row in rows]
    report = {
        "version": VERSION,
        "modelRevision": REVISION,
        "deadlineMs": args.deadline_ms,
        "threads": args.threads,
        "qualification": "NOT_QUALIFIED: synthetic speech and machine-known boundaries are operational evidence, not Thai human timing acceptance",
        "cases": evidence,
    }
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({"cases": len(evidence), "statuses": [row["status"] for row in evidence]}))


if __name__ == "__main__":
    main()
