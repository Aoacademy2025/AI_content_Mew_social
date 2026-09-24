"""Create noncustomer Thai speech fixtures with exact repeated-text boundaries.

This uses an already-installed macOS Thai voice and ffmpeg. It performs no
network request and keeps generated media outside the repository.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import wave
from pathlib import Path


DEFAULT_PHRASE = "วันนี้เรากำลังทดสอบการจับเวลาเสียงภาษาไทย เพื่อให้คำบรรยายตรงกับเสียงจริง"


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def repeat_wave(source: Path, output: Path, phrase: str, target_seconds: float, identifier: str) -> dict:
    with wave.open(str(source), "rb") as input_wave:
        params = input_wave.getparams()
        frames = input_wave.readframes(params.nframes)
    unit_seconds = params.nframes / params.framerate
    repeats = max(1, round(target_seconds / unit_seconds)) if target_seconds > 0 else 1
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with wave.open(str(output), "wb") as output_wave:
        output_wave.setparams(params)
        for _ in range(repeats):
            output_wave.writeframes(frames)
    boundaries = []
    prefix = ""
    for index in range(repeats):
        if prefix:
            prefix += " "
        boundaries.append({"startChar": _utf16_length(prefix), "referenceMs": round(index * unit_seconds * 1000)})
        prefix += phrase
    return {
        "id": identifier,
        "audioPath": str(output.resolve()),
        "text": prefix,
        "expectedDurationMs": round(repeats * unit_seconds * 1000),
        "boundaries": boundaries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate repeated Thai OS-speech fixtures")
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--voice", default="Kanya")
    parser.add_argument("--rate", default=220, type=int)
    parser.add_argument("--phrase", default=DEFAULT_PHRASE)
    args = parser.parse_args()
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    aiff = args.output_dir / "unit.aiff"
    unit = args.output_dir / "unit.wav"
    subprocess.run(["/usr/bin/say", "-v", args.voice, "-r", str(args.rate), "-o", str(aiff), args.phrase], check=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(aiff),
        "-af", "apad=pad_dur=0.4", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(unit),
    ], check=True)
    rows = [repeat_wave(unit, args.output_dir / "short-known.wav", args.phrase, 0, "short-known")]
    rows.extend(
        repeat_wave(unit, args.output_dir / f"long-{seconds}.wav", args.phrase, seconds, f"long-{seconds}")
        for seconds in (120, 200, 270, 300)
    )
    manifest = args.output_dir / "manifest.json"
    manifest.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    manifest.chmod(0o600)
    print(json.dumps({"manifest": str(manifest), "durationsMs": [row["expectedDurationMs"] for row in rows]}))


if __name__ == "__main__":
    main()
