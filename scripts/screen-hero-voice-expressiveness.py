#!/usr/bin/env python3
"""Offline expressiveness screening harness for candidate Hero Voice WAVs.

Purpose: rank candidate TTS renders by expressiveness within a `group` (persona
or eval-script grouping key) while guarding Thai intelligibility, so hundreds of
generated clips can be triaged automatically before any human listens. This is
the T3 harness for the Hero Voice Thai emotion-quality project — see
`.superpowers/sdd/hv-emotion/task-3-brief.md` and
`docs/plans/2026-07-24-hero-voice-emotion-experiment.md`.

Reuses machinery/patterns from `scripts/audit-hero-voice-catalog.py`:
  - Thai CER via local Whisper + the same character-level normalization
    (`normalized_text` / `character_error_rate` below are byte-for-byte the
    same algorithm as the audit script, kept in sync deliberately).
  - F0 extraction via `librosa.pyin` with the same fmin/fmax/frame_length used
    by the audit script's pitch gate.
  - Voiced fraction = fraction of frames with a finite pYIN F0 estimate.

Silence/pause analysis and energy dynamic range are new for this harness.

Dependencies are provided the same way as `audit-hero-voice-catalog.py` — via
`uv run --with <pkg>`, NOT a committed venv or requirements.txt. This repo has
no Python venv/requirements file; Python deps for one-off audio-analysis
scripts are always resolved ad hoc through `uv run`. The `--python 3.11` pin
matters: the default system `python3` here is a much newer CPython that
`librosa`'s dependency tree (numba/llvmlite) does not yet support.

Run (screening, needs openai-whisper for the ASR pass):
  uv run --python 3.11 --with librosa --with numpy --with openai-whisper \
    --with 'setuptools<81' python3 scripts/screen-hero-voice-expressiveness.py \
    --input-dir DIR --out-json PATH --out-md PATH

`DIR` must contain the candidate WAVs plus a `manifest.json`:
  [{ "file": "x.wav", "transcript": "<expected Thai text>",
     "label": "<free-form config label>", "group": "<persona/script key>" }]

Run (unit tests, no Whisper needed — CER is tested at the string level):
  uv run --python 3.11 --with librosa --with numpy --with 'setuptools<81' \
    python3 -m unittest scripts/test_screen_hero_voice_expressiveness.py -v

Per-file failure isolation
---------------------------
One corrupt/unreadable WAV (Whisper's ffmpeg decode raising, librosa unable to
read the file, or a missing path) never aborts the batch. That file's entry is
instead recorded with disqualified=True, disqualification_reason=
"unreadable_audio", every metric field set to null, rank/score null — and the
run still writes full JSON+MD for every other file. See
`transcribe_paths_with_model` (per-file transcription isolation) and
`build_metrics_row_or_unreadable` (per-file decode/analysis isolation).

Ranking / expressiveness score
-------------------------------
Guard first: any file with Thai CER > 5% is DISQUALIFIED from ranking (still
listed in the output with its full metrics and a disqualification_reason) —
mirrors the audit script's ASR_FAIL_CER=0.10 gate philosophy but tighter
(5%) because this harness screens *candidates*, not shipped references.

Survivors (CER <= 5%) within a `group` are scored by a deterministic,
weighted composite of three raw metrics, each min-max normalized against the
*survivor* population of that group (so a disqualified outlier — e.g. a
silent/garbled render — cannot skew the normalization range for legitimate
candidates):

  score = 0.4 * norm(f0_iqr_hz)
        + 0.4 * norm(energy_dynamic_range_db)
        + 0.2 * norm(pause_count)

Rationale for the weights:
  - F0 IQR (pitch variability over voiced frames) and energy dynamic range
    (p95-p5 of frame RMS in dB) are the two most robust, well-established
    acoustic correlates of perceived prosodic expressiveness in TTS
    evaluation — a flat/monotone read has near-zero variation in both. They
    are weighted equally and highest (0.4 each).
  - Pause count (number of >250ms silence runs, excluding leading/trailing)
    is a weaker, noisier proxy — threshold-based silence detection has more
    false positives/negatives than pitch/energy statistics, and "more
    pauses" does not monotonically mean "more expressive" past some point.
    It is included (natural pausing is part of expressive delivery) but
    down-weighted to 0.2.

Normalization: for each raw metric, low/high = min/max of that metric across
the group's *survivors*. If a group has zero or one distinct value for a
metric among survivors (including the degenerate single-survivor group),
normalization cannot discriminate and the component is defined as 1.0 for all
survivors (they are equally the best available on that axis) — this keeps the
score defined and avoids a divide-by-zero rather than expressing a
preference. Ties in the final score are broken deterministically by filename
(ascending) so ranking never depends on dict/set iteration order or any
randomness — required per the task brief ("No randomness").
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import sys

import librosa
import numpy as np


CER_DISQUALIFY_THRESHOLD = 0.05
PAUSE_MIN_DURATION_SECONDS = 0.25
PAUSE_RELATIVE_DROP_DB = 30.0
F0_FMIN_HZ = 60.0
F0_FMAX_HZ = 600.0
F0_FRAME_LENGTH = 2048
ENERGY_FRAME_LENGTH = 1024
ENERGY_HOP_LENGTH = 256

SCORE_WEIGHTS = {
    "f0_iqr_hz": 0.4,
    "energy_dynamic_range_db": 0.4,
    "pause_count": 0.2,
}


# ---------------------------------------------------------------------------
# CER — kept byte-for-byte identical to scripts/audit-hero-voice-catalog.py so
# screening scores are comparable with the catalog audit's Thai ASR gate.
# ---------------------------------------------------------------------------

def normalized_text(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum())


def character_error_rate(expected: str, actual: str) -> float:
    left = normalized_text(expected)
    right = normalized_text(actual)
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_character != right_character),
            ))
        previous = current
    return previous[-1] / max(1, len(left))


# ---------------------------------------------------------------------------
# Pitch (F0) — reuses the audit script's librosa.pyin configuration.
# ---------------------------------------------------------------------------

def median_f0_and_iqr(audio: np.ndarray, sr: int) -> tuple[float | None, float, float]:
    """Return (median F0 Hz or None, F0 IQR Hz, voiced fraction) over voiced frames.

    Pure function: takes an audio array + sample rate, no I/O. F0 IQR is 0.0
    when fewer than two voiced frames are available (nothing to spread).
    """
    if audio.size == 0 or not sr:
        return None, 0.0, 0.0

    f0, _, _ = librosa.pyin(
        audio,
        fmin=F0_FMIN_HZ,
        fmax=F0_FMAX_HZ,
        sr=sr,
        frame_length=F0_FRAME_LENGTH,
    )
    finite_f0 = f0[np.isfinite(f0)]
    voiced_fraction = float(np.mean(np.isfinite(f0))) if f0.size else 0.0
    if finite_f0.size == 0:
        return None, 0.0, voiced_fraction
    median_f0 = float(np.median(finite_f0))
    if finite_f0.size < 2:
        return median_f0, 0.0, voiced_fraction
    q75, q25 = np.percentile(finite_f0, [75, 25])
    return median_f0, float(q75 - q25), voiced_fraction


# ---------------------------------------------------------------------------
# Energy dynamic range — new for this harness.
# ---------------------------------------------------------------------------

def frame_rms_dbfs(audio: np.ndarray, frame_length: int = ENERGY_FRAME_LENGTH,
                    hop_length: int = ENERGY_HOP_LENGTH) -> np.ndarray:
    """Per-frame RMS in dBFS. Pure function of the audio samples."""
    if audio.size == 0:
        return np.zeros(0, dtype=np.float64)
    rms = librosa.feature.rms(y=audio, frame_length=frame_length, hop_length=hop_length)[0]
    return 20.0 * np.log10(np.maximum(rms, 1e-12))


def energy_dynamic_range_db(frame_rms_db: np.ndarray) -> float:
    """p95 - p5 of frame RMS (dB). Pure function; 0.0 for empty/degenerate input."""
    if frame_rms_db.size == 0:
        return 0.0
    p95, p5 = np.percentile(frame_rms_db, [95, 5])
    return float(p95 - p5)


# ---------------------------------------------------------------------------
# Pause structure — new for this harness.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PauseRun:
    start_seconds: float
    duration_seconds: float


def frame_silence_mask(frame_rms_db: np.ndarray, relative_drop_db: float = PAUSE_RELATIVE_DROP_DB) -> np.ndarray:
    """Mark frames as silent when they sit `relative_drop_db` below the file's
    own 95th-percentile frame loudness. Relative (not an absolute dBFS floor)
    so it works whether a candidate render is loud or quiet overall — pure
    function of the frame RMS array.
    """
    if frame_rms_db.size == 0:
        return np.zeros(0, dtype=bool)
    reference_db = float(np.percentile(frame_rms_db, 95))
    threshold_db = reference_db - relative_drop_db
    return frame_rms_db < threshold_db


def detect_pause_runs(silence_mask: np.ndarray, hop_seconds: float,
                       min_duration_seconds: float = PAUSE_MIN_DURATION_SECONDS) -> list[PauseRun]:
    """Contiguous silent-frame runs long enough to count as a pause, excluding
    any run touching the first or last frame (leading/trailing silence is not
    a "pause" — it is lead-in/tail-out). Pure function of a boolean mask.
    """
    runs: list[PauseRun] = []
    if silence_mask.size == 0:
        return runs

    start_index: int | None = None
    for index, is_silent in enumerate(silence_mask):
        if is_silent and start_index is None:
            start_index = index
        elif not is_silent and start_index is not None:
            _maybe_add_run(runs, start_index, index - 1, silence_mask.size, hop_seconds, min_duration_seconds)
            start_index = None
    if start_index is not None:
        _maybe_add_run(runs, start_index, silence_mask.size - 1, silence_mask.size, hop_seconds, min_duration_seconds)
    return runs


def _maybe_add_run(runs: list[PauseRun], start_index: int, end_index: int, frame_count: int,
                    hop_seconds: float, min_duration_seconds: float) -> None:
    touches_boundary = start_index == 0 or end_index == frame_count - 1
    if touches_boundary:
        return
    duration_seconds = (end_index - start_index + 1) * hop_seconds
    if duration_seconds < min_duration_seconds:
        return
    runs.append(PauseRun(start_seconds=start_index * hop_seconds, duration_seconds=duration_seconds))


def compute_pause_structure(audio: np.ndarray, sr: int) -> tuple[int, float]:
    """Return (pause_count, total_pause_duration_seconds) for `audio`. Pure
    function composing frame_rms_dbfs -> frame_silence_mask -> detect_pause_runs.
    """
    if audio.size == 0 or not sr:
        return 0, 0.0
    frame_rms_db = frame_rms_dbfs(audio)
    if frame_rms_db.size == 0:
        return 0, 0.0
    hop_seconds = ENERGY_HOP_LENGTH / sr
    mask = frame_silence_mask(frame_rms_db)
    runs = detect_pause_runs(mask, hop_seconds)
    total_duration = sum(run.duration_seconds for run in runs)
    return len(runs), float(total_duration)


# ---------------------------------------------------------------------------
# Scoring / ranking — pure functions operating on metric dicts.
# ---------------------------------------------------------------------------

def _min_max_normalize(value: float, low: float, high: float) -> float:
    if high - low <= 1e-9:
        return 1.0
    return float(min(1.0, max(0.0, (value - low) / (high - low))))


def expressiveness_score(f0_iqr_hz: float, energy_dynamic_range_db_value: float, pause_count: int,
                          bounds: dict[str, tuple[float, float]]) -> float:
    """Deterministic weighted composite — see module docstring for the formula
    and weight rationale. `bounds` maps each raw metric name to (low, high)
    used for min-max normalization.
    """
    norm_f0 = _min_max_normalize(f0_iqr_hz, *bounds["f0_iqr_hz"])
    norm_energy = _min_max_normalize(energy_dynamic_range_db_value, *bounds["energy_dynamic_range_db"])
    norm_pause = _min_max_normalize(float(pause_count), *bounds["pause_count"])
    score = (
        SCORE_WEIGHTS["f0_iqr_hz"] * norm_f0
        + SCORE_WEIGHTS["energy_dynamic_range_db"] * norm_energy
        + SCORE_WEIGHTS["pause_count"] * norm_pause
    )
    return round(score, 6)


def rank_group(entries: list[dict]) -> list[dict]:
    """Apply the CER guard, then rank survivors by `expressiveness_score`.

    `entries` is a list of per-file metric dicts, each requiring at least:
    "file" (str, unique within the group), "cer" (float 0..1), "f0_iqr_hz",
    "energy_dynamic_range_db", "pause_count".

    Returns a NEW list of dicts (input entries are not mutated), each with
    "disqualified" (bool), "disqualification_reason" (str | None), "score"
    (float), and "rank" (int | None — None for disqualified entries).
    Deterministic: no randomness, ties broken by ascending filename.

    Raises ValueError if two entries share the same "file" within the group —
    ranking silently collides ranks/labels for duplicates otherwise, which is
    worse than failing loudly (a manifest bug, not a data condition to survive).
    """
    file_counts: dict[str, int] = {}
    for entry in entries:
        file_counts[entry["file"]] = file_counts.get(entry["file"], 0) + 1
    duplicate_files = sorted(name for name, count in file_counts.items() if count > 1)
    if duplicate_files:
        raise ValueError(
            f"rank_group received duplicate file name(s) within a group: {duplicate_files}"
        )

    survivors = [entry for entry in entries if entry["cer"] <= CER_DISQUALIFY_THRESHOLD]

    def bounds_for(metric: str) -> tuple[float, float]:
        if not survivors:
            return (0.0, 0.0)
        values = [float(entry[metric]) for entry in survivors]
        return (min(values), max(values))

    bounds = {
        "f0_iqr_hz": bounds_for("f0_iqr_hz"),
        "energy_dynamic_range_db": bounds_for("energy_dynamic_range_db"),
        "pause_count": bounds_for("pause_count"),
    }

    scored: list[dict] = []
    for entry in entries:
        disqualified = entry["cer"] > CER_DISQUALIFY_THRESHOLD
        score = expressiveness_score(
            entry["f0_iqr_hz"], entry["energy_dynamic_range_db"], entry["pause_count"], bounds,
        )
        reason = (
            f"CER {entry['cer']:.2%} exceeds {CER_DISQUALIFY_THRESHOLD:.0%} guard"
            if disqualified else None
        )
        scored.append({**entry, "disqualified": disqualified, "disqualification_reason": reason, "score": score})

    ranked_survivors = sorted(
        (row for row in scored if not row["disqualified"]),
        key=lambda row: (-row["score"], row["file"]),
    )
    rank_by_file = {row["file"]: index + 1 for index, row in enumerate(ranked_survivors)}
    for row in scored:
        row["rank"] = rank_by_file.get(row["file"])

    scored.sort(key=lambda row: (row["rank"] is None, row["rank"] if row["rank"] is not None else 0, row["file"]))
    return scored


# ---------------------------------------------------------------------------
# ASR (Whisper) — model loading/import only happen on the CLI path, never in
# unit tests. `transcribe_one`/`transcribe_paths_with_model` accept an
# already-loaded `model` object (duck-typed: needs `.transcribe(path, ...)`)
# so per-file failure isolation is unit-testable with a fake model — no
# Whisper import, no network, no real audio required.
# ---------------------------------------------------------------------------

def transcribe_one(model, path: Path) -> str:
    output = model.transcribe(
        str(path),
        language="th",
        verbose=False,
        condition_on_previous_text=False,
        temperature=0,
        fp16=False,
    )
    return str(output.get("text", "")).strip()


def transcribe_paths_with_model(model, paths: list[Path]) -> dict[Path, str | None]:
    """Transcribe each path with `model`, isolating per-file failures so one
    corrupt/unreadable WAV (e.g. Whisper's ffmpeg decode step raising) cannot
    abort the batch. A failed file maps to None instead of propagating the
    exception; every other file in `paths` is still attempted.
    """
    results: dict[Path, str | None] = {}
    for index, path in enumerate(paths, start=1):
        try:
            results[path] = transcribe_one(model, path)
        except Exception as error:  # noqa: BLE001 - deliberate: isolate one bad file from the batch
            print(f"ERROR transcription failed file={path.name}: {error}", file=sys.stderr)
            results[path] = None
        print(f"asr={index}/{len(paths)} file={path.name}", file=sys.stderr, flush=True)
    return results


def transcribe_all(paths: list[Path], model_name: str) -> dict[Path, str | None]:
    try:
        import whisper
    except ImportError as error:
        raise RuntimeError(
            "Whisper transcription requires openai-whisper "
            "(uv run --with openai-whisper ...)"
        ) from error

    model = whisper.load_model(model_name)
    return transcribe_paths_with_model(model, paths)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input-dir", type=Path, required=True, help="dir with candidate WAVs + manifest.json")
    parser.add_argument("--out-json", type=Path, required=True)
    parser.add_argument("--out-md", type=Path, required=True)
    parser.add_argument("--asr-model", default="large-v3-turbo", help="Whisper model name (default matches audit-hero-voice-catalog.py)")
    return parser.parse_args()


def load_manifest(input_dir: Path) -> list[dict]:
    manifest_path = input_dir / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"manifest.json not found in {input_dir}")
    try:
        entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"manifest.json at {manifest_path} is not valid JSON: {error}") from error
    for entry in entries:
        for required in ("file", "transcript"):
            if required not in entry:
                raise ValueError(f"manifest entry missing required field {required!r}: {entry!r}")
    return entries


def build_metrics_row(input_dir: Path, manifest_entry: dict, transcript_actual: str) -> dict:
    path = input_dir / manifest_entry["file"]
    audio, sr = librosa.load(str(path), sr=None, mono=True)
    duration_seconds = float(len(audio) / sr) if sr else 0.0

    f0_median_hz, f0_iqr_hz, voiced_fraction = median_f0_and_iqr(audio, sr)
    frame_rms_db = frame_rms_dbfs(audio)
    energy_dr_db = energy_dynamic_range_db(frame_rms_db)
    pause_count, pause_total_duration_seconds = compute_pause_structure(audio, sr)
    cer = character_error_rate(manifest_entry["transcript"], transcript_actual)

    return {
        "file": manifest_entry["file"],
        "label": manifest_entry.get("label", ""),
        "group": manifest_entry.get("group", "default"),
        "transcript_expected": manifest_entry["transcript"],
        "transcript_actual": transcript_actual,
        "cer": round(cer, 6),
        "duration_seconds": round(duration_seconds, 4),
        "f0_median_hz": None if f0_median_hz is None else round(f0_median_hz, 2),
        "f0_iqr_hz": round(f0_iqr_hz, 4),
        "voiced_fraction": round(voiced_fraction, 4),
        "energy_dynamic_range_db": round(energy_dr_db, 4),
        "pause_count": pause_count,
        "pause_total_duration_seconds": round(pause_total_duration_seconds, 4),
    }


def unreadable_row(manifest_entry: dict, reason: str = "unreadable_audio") -> dict:
    """Final-shaped row for a file that could not be transcribed or decoded.
    Metrics are all None; disqualified with `reason`; never ranked/scored.
    Same key set as a `rank_group`-processed row so JSON/MD output stays
    uniform whether or not a file failed.
    """
    return {
        "file": manifest_entry["file"],
        "label": manifest_entry.get("label", ""),
        "group": manifest_entry.get("group", "default"),
        "transcript_expected": manifest_entry.get("transcript"),
        "transcript_actual": None,
        "cer": None,
        "duration_seconds": None,
        "f0_median_hz": None,
        "f0_iqr_hz": None,
        "voiced_fraction": None,
        "energy_dynamic_range_db": None,
        "pause_count": None,
        "pause_total_duration_seconds": None,
        "disqualified": True,
        "disqualification_reason": reason,
        "score": None,
        "rank": None,
    }


def build_metrics_row_or_unreadable(input_dir: Path, manifest_entry: dict, transcript_actual: str | None) -> dict:
    """Compute the full metrics row for one file, isolating decode/analysis
    failures (librosa unable to read a file, or an upstream transcription
    failure already signalled via `transcript_actual is None`) into an
    "unreadable_audio" disqualified row instead of raising — so one bad file
    cannot abort the whole batch. Never raises.
    """
    if transcript_actual is None:
        return unreadable_row(manifest_entry)
    try:
        return build_metrics_row(input_dir, manifest_entry, transcript_actual)
    except Exception as error:  # noqa: BLE001 - deliberate: isolate one bad file from the batch
        print(f"ERROR metrics computation failed file={manifest_entry.get('file')}: {error}", file=sys.stderr)
        return unreadable_row(manifest_entry)


def _escape_md_cell(value) -> str:
    """Escape a value for safe embedding in a Markdown table cell — free-form
    manifest fields (file/label) could contain `|` or newlines and would
    otherwise break the table structure.
    """
    return str(value).replace("|", "\\|").replace("\n", " ")


def markdown_report(ranked_rows: list[dict]) -> str:
    lines = [
        "# Hero Voice expressiveness screening",
        "",
        "Guard: Thai CER > 5% -> DISQUALIFIED (listed with metrics, not ranked).",
        "Score (survivors only) = 0.4*norm(F0 IQR) + 0.4*norm(energy dynamic range) "
        "+ 0.2*norm(pause count), min-max normalized within each group's survivors. "
        "See module docstring in scripts/screen-hero-voice-expressiveness.py for the "
        "full rationale.",
        "",
    ]
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in ranked_rows:
        groups[row["group"]].append(row)

    for group in sorted(groups):
        rows = groups[group]
        survivors = sorted((r for r in rows if not r["disqualified"]), key=lambda r: r["rank"])
        disqualified = sorted((r for r in rows if r["disqualified"]), key=lambda r: r["file"])

        lines.append(f"## Group: {group}")
        lines.append("")
        lines.append("| Rank | File | Label | CER | Score | F0 IQR (Hz) | Energy DR (dB) | Pauses | Duration (s) |")
        lines.append("| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for row in survivors:
            marker = "**" if row["rank"] is not None and row["rank"] <= 3 else ""
            lines.append(
                f"| {marker}{row['rank']}{marker} | {_escape_md_cell(row['file'])} | "
                f"{_escape_md_cell(row['label'])} | "
                f"{row['cer']:.2%} | {row['score']:.4f} | {row['f0_iqr_hz']:.1f} | "
                f"{row['energy_dynamic_range_db']:.1f} | {row['pause_count']} | {row['duration_seconds']:.2f} |"
            )
        if survivors:
            lines.append("")
            lines.append(f"Top-3: {', '.join(_escape_md_cell(r['file']) for r in survivors[:3])}")
        if disqualified:
            lines.append("")
            lines.append("**Disqualified:**")
            lines.append("")
            lines.append("| File | Label | CER | Reason |")
            lines.append("| --- | --- | ---: | --- |")
            for row in disqualified:
                cer_display = "—" if row["cer"] is None else f"{row['cer']:.2%}"
                lines.append(
                    f"| {_escape_md_cell(row['file'])} | {_escape_md_cell(row['label'])} | "
                    f"{cer_display} | {_escape_md_cell(row['disqualification_reason'])} |"
                )
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    manifest = load_manifest(args.input_dir)

    paths = [args.input_dir / entry["file"] for entry in manifest]

    # A missing file is transcribed/decoded by nothing; route it straight to
    # "unreadable_audio" rather than pre-checking + aborting the whole run —
    # one missing file must not discard every other completed entry either.
    existing_paths = [path for path in paths if path.is_file()]
    for path in paths:
        if not path.is_file():
            print(f"ERROR missing file: {path}", file=sys.stderr)
    transcripts = transcribe_all(existing_paths, args.asr_model)

    rows_by_group: dict[str, list[dict]] = defaultdict(list)
    unreadable_by_group: dict[str, list[dict]] = defaultdict(list)
    for entry, path in zip(manifest, paths):
        transcript_actual = transcripts.get(path)  # None for missing paths (not in the dict) or failed ASR
        row = build_metrics_row_or_unreadable(args.input_dir, entry, transcript_actual)
        if row.get("disqualification_reason") == "unreadable_audio":
            unreadable_by_group[row["group"]].append(row)
        else:
            rows_by_group[row["group"]].append(row)

    ranked_rows: list[dict] = []
    all_groups = sorted(set(rows_by_group) | set(unreadable_by_group))
    for group in all_groups:
        ranked_rows.extend(rank_group(rows_by_group.get(group, [])))
        ranked_rows.extend(unreadable_by_group.get(group, []))

    unreadable_count = sum(1 for group_rows in unreadable_by_group.values() for _ in group_rows)
    report = {
        "summary": {
            "files": len(ranked_rows),
            "groups": all_groups,
            "cer_disqualify_threshold": CER_DISQUALIFY_THRESHOLD,
            "score_weights": SCORE_WEIGHTS,
            "disqualified": sum(1 for row in ranked_rows if row["disqualified"]),
            "unreadable": unreadable_count,
        },
        "voices": ranked_rows,
    }

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.out_md.parent.mkdir(parents=True, exist_ok=True)
    args.out_md.write_text(markdown_report(ranked_rows), encoding="utf-8")

    print(json.dumps(report["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
