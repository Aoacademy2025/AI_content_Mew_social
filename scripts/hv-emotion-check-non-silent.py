#!/usr/bin/env python3
"""T6 (hv-emotion) — non-silence + existence check for WAV files, stdlib only
(no uv/numpy needed — this is a cheap sanity gate, not the CER/expressiveness
harness). Reads file paths one per line from stdin, prints one JSON line per
file to stdout: {"file", "exists", "ok", "peak", "rms", "duration_s", "reason"}.

A file is "non-silent" if it exists, decodes as mono 16-bit PCM WAV, has
duration > 0.05s, and peak abs sample amplitude >= SILENCE_PEAK_THRESHOLD.

Usage:
  find artifacts/.../fidelity -name '*.wav' | python3 scripts/hv-emotion-check-non-silent.py
  python3 scripts/hv-emotion-check-non-silent.py < filelist.txt > results.jsonl
"""
import sys
import json
import wave
import array

SILENCE_PEAK_THRESHOLD = 200  # out of +-32768 for 16-bit PCM


def check_file(path: str) -> dict:
    result = {"file": path, "exists": False, "ok": False, "peak": None, "rms": None, "duration_s": None, "reason": None}
    try:
        with wave.open(path, "rb") as wf:
            result["exists"] = True
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            n_frames = wf.getnframes()
            duration = n_frames / framerate if framerate else 0.0
            result["duration_s"] = round(duration, 3)
            if sampwidth != 2:
                result["reason"] = f"unsupported sample width {sampwidth}"
                return result
            raw = wf.readframes(n_frames)
            samples = array.array("h")
            samples.frombytes(raw)
            if n_channels > 1:
                samples = samples[::n_channels]
            if len(samples) == 0:
                result["reason"] = "zero samples"
                return result
            peak = max(abs(s) for s in samples)
            rms = (sum(s * s for s in samples) / len(samples)) ** 0.5
            result["peak"] = peak
            result["rms"] = round(rms, 2)
            if duration <= 0.05:
                result["reason"] = "too short"
            elif peak < SILENCE_PEAK_THRESHOLD:
                result["reason"] = "silent"
            else:
                result["ok"] = True
    except FileNotFoundError:
        result["reason"] = "missing"
    except Exception as error:  # noqa: BLE001 - report, don't crash the batch
        result["reason"] = f"error: {error}"
    return result


def main() -> int:
    any_bad = False
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        row = check_file(path)
        if not row["ok"]:
            any_bad = True
        print(json.dumps(row))
    return 1 if any_bad else 0


if __name__ == "__main__":
    sys.exit(main())
