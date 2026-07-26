#!/usr/bin/env python3
"""Screen and globally select non-duplicate Hero AI Voice redesign candidates."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav
from speechbrain.inference.speaker import EncoderClassifier
import whisper


ROOT = Path(__file__).resolve().parents[1]
VOICE_ROOT = ROOT / "services" / "omnivoice-runpod" / "assets" / "voices"
PLAN_PATH = VOICE_ROOT / "redesign-plan.json"
AUDIT_SCRIPT = ROOT / "scripts" / "audit-hero-voice-catalog.py"
MAX_FINAL_SIMILARITY = 0.90
MAX_FINAL_ECAPA_SIMILARITY = 0.75


def load_audit_module():
    spec = importlib.util.spec_from_file_location("hero_voice_catalog_audit", AUDIT_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load catalog audit module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", type=Path, required=True)
    parser.add_argument("--asr-model", default="large-v3-turbo")
    parser.add_argument("--json-out", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    candidate_root = args.candidate_dir.resolve()
    if not candidate_root.is_dir():
        raise RuntimeError(f"candidate directory does not exist: {candidate_root}")

    audit = load_audit_module()
    manifest = json.loads((VOICE_ROOT / "voices.json").read_text(encoding="utf-8"))
    manifest_by_id = {voice["id"]: voice for voice in manifest}
    plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    target_ids = {item["id"] for item in plan}

    encoder = VoiceEncoder()
    ecapa = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="/tmp/hero-voice-ecapa",
    )

    def ecapa_embedding(path: Path) -> np.ndarray:
        signal = ecapa.load_audio(str(path))
        tensor = ecapa.encode_batch(signal.unsqueeze(0)).squeeze().detach()
        tensor = tensor / tensor.norm()
        return tensor.cpu().numpy()

    fixed_voices = [voice for voice in manifest if voice["id"] not in target_ids]
    fixed_paths = [VOICE_ROOT / voice["ref_audio"] for voice in fixed_voices]
    fixed_embeddings = np.stack([
        encoder.embed_utterance(preprocess_wav(path)) for path in fixed_paths
    ])
    fixed_ecapa_embeddings = np.stack([ecapa_embedding(path) for path in fixed_paths])

    fixed_ecapa_similarity = fixed_ecapa_embeddings @ fixed_ecapa_embeddings.T
    np.fill_diagonal(fixed_ecapa_similarity, -1)
    fixed_ecapa_max_index = np.unravel_index(np.argmax(fixed_ecapa_similarity), fixed_ecapa_similarity.shape)
    fixed_ecapa_max = float(fixed_ecapa_similarity[fixed_ecapa_max_index])
    if fixed_ecapa_max >= MAX_FINAL_ECAPA_SIMILARITY:
        left, right = fixed_ecapa_max_index
        raise RuntimeError(
            f"fixed voices {fixed_voices[left]['id']} and {fixed_voices[right]['id']} "
            f"still violate the ECAPA diversity gate ({fixed_ecapa_max:.4f})"
        )

    candidate_rows: list[dict] = []
    for item in plan:
        for audio_path in sorted((candidate_root / item["id"]).glob("seed-*.wav")):
            metadata_path = audio_path.with_suffix(".json")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("instruct") != item["instruct"]:
                continue
            _, metrics = audit.load_wav(audio_path)
            embedding = encoder.embed_utterance(preprocess_wav(audio_path))
            ecapa_voice_embedding = ecapa_embedding(audio_path)
            fixed_scores = fixed_embeddings @ embedding
            fixed_ecapa_scores = fixed_ecapa_embeddings @ ecapa_voice_embedding
            closest_index = int(np.argmax(fixed_scores))
            closest_ecapa_index = int(np.argmax(fixed_ecapa_scores))
            candidate_rows.append({
                "voice_id": item["id"],
                "instruct": item["instruct"],
                "reason": item["reason"],
                "seed": metadata["seed"],
                "path": str(audio_path),
                "metadata_path": str(metadata_path),
                "metrics": asdict(metrics),
                "embedding": embedding,
                "ecapa_embedding": ecapa_voice_embedding,
                "closest_fixed_voice": fixed_voices[closest_index]["id"],
                "closest_fixed_similarity": float(fixed_scores[closest_index]),
                "closest_fixed_ecapa_voice": fixed_voices[closest_ecapa_index]["id"],
                "closest_fixed_ecapa_similarity": float(fixed_ecapa_scores[closest_ecapa_index]),
            })

    missing_candidate_files = [
        item["id"] for item in plan
        if not any(row["voice_id"] == item["id"] for row in candidate_rows)
    ]
    if missing_candidate_files:
        raise RuntimeError(f"no candidates matching the current prompt for: {', '.join(missing_candidate_files)}")

    model = whisper.load_model(args.asr_model)
    for index, row in enumerate(candidate_rows, start=1):
        expected_text = json.loads(Path(row["metadata_path"]).read_text(encoding="utf-8"))["text"]
        metrics = audit.AudioMetrics(**row["metrics"])
        cache_path = Path(row["path"]).with_suffix(".screen.json")
        cached = None
        if cache_path.is_file():
            candidate_cache = json.loads(cache_path.read_text(encoding="utf-8"))
            if (
                candidate_cache.get("sha256") == metrics.sha256
                and candidate_cache.get("asr_model") == args.asr_model
                and candidate_cache.get("instruct") == row["instruct"]
                and candidate_cache.get("expected_text") == expected_text
            ):
                cached = candidate_cache
        if cached:
            row.update({
                "transcript": cached["transcript"],
                "cer": cached["cer"],
                "profile_problem": cached["profile_problem"],
                "structural_problem": cached["structural_problem"],
                "eligible": cached["eligible"],
            })
        else:
            result = model.transcribe(
                row["path"],
                language="th",
                verbose=False,
                condition_on_previous_text=False,
                temperature=0,
                fp16=False,
            )
            transcript = str(result.get("text", "")).strip()
            cer = audit.character_error_rate(expected_text, transcript)
            profile_problem = audit.expected_pitch_problem(row["instruct"], metrics)
            structural_problem = None
            if metrics.sample_rate != 24_000 or metrics.channels != 1 or metrics.sample_width_bytes != 2:
                structural_problem = "WAV structure mismatch"
            elif not 2 <= metrics.duration_seconds <= 10:
                structural_problem = "duration outside 2-10 seconds"
            elif metrics.clipping_ratio > 0.001:
                structural_problem = "clipping above 0.1%"
            row.update({
                "transcript": transcript,
                "cer": cer,
                "profile_problem": profile_problem,
                "structural_problem": structural_problem,
                "eligible": cer <= 0.10 and profile_problem is None and structural_problem is None,
            })
            cache_path.write_text(json.dumps({
                "sha256": metrics.sha256,
                "asr_model": args.asr_model,
                "instruct": row["instruct"],
                "expected_text": expected_text,
                "transcript": row["transcript"],
                "cer": row["cer"],
                "profile_problem": row["profile_problem"],
                "structural_problem": row["structural_problem"],
                "eligible": row["eligible"],
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(
            f"screen={index}/{len(candidate_rows)} voice={row['voice_id']} seed={row['seed']} "
            f"cer={row['cer']:.2%} fixed_similarity={row['closest_fixed_similarity']:.4f} "
            f"eligible={row['eligible']} cached={cached is not None}",
            file=sys.stderr,
            flush=True,
        )

    candidates_by_voice = {
        item["id"]: [
            row for row in candidate_rows
            if row["voice_id"] == item["id"]
            and row["eligible"]
            and ("whisper" in item["instruct"] or row["cer"] == 0)
            and row["closest_fixed_similarity"] < MAX_FINAL_SIMILARITY
            and row["closest_fixed_ecapa_similarity"] < MAX_FINAL_ECAPA_SIMILARITY
        ]
        for item in plan
    }
    missing = [voice_id for voice_id, rows in candidates_by_voice.items() if not rows]
    if missing:
        print(json.dumps({"status": "no-eligible-candidate", "voices": missing}, ensure_ascii=False))
        return 1

    def pair_score(left: dict, right: dict) -> float:
        return float(left["embedding"] @ right["embedding"])

    def ecapa_pair_score(left: dict, right: dict) -> float:
        return float(left["ecapa_embedding"] @ right["ecapa_embedding"])

    # Exact constraint search with dynamic minimum-remaining-values ordering.
    # This proves a whole-catalog assignment exists instead of allowing a beam
    # heuristic to discard the only viable combination for a constrained voice.
    visited_nodes = 0

    def find_solution(threshold: float, ecapa_threshold: float) -> tuple[list[dict] | None, list[str]]:
        nonlocal visited_nodes
        visited_nodes = 0
        eligible = {
            voice_id: [
                row for row in rows
                if row["closest_fixed_similarity"] < threshold
                and row["closest_fixed_ecapa_similarity"] < ecapa_threshold
            ]
            for voice_id, rows in candidates_by_voice.items()
        }
        if any(not rows for rows in eligible.values()):
            return None, []

        selected: dict[str, dict] = {}
        chosen_order: list[str] = []

        def compatible(candidate: dict) -> bool:
            return all(
                pair_score(candidate, previous) < threshold
                and ecapa_pair_score(candidate, previous) < ecapa_threshold
                for previous in selected.values()
            )

        def search() -> bool:
            nonlocal visited_nodes
            visited_nodes += 1
            if len(selected) == len(eligible):
                return True

            remaining = [voice_id for voice_id in eligible if voice_id not in selected]
            possible_by_voice = {
                voice_id: [candidate for candidate in eligible[voice_id] if compatible(candidate)]
                for voice_id in remaining
            }
            voice_id = min(
                remaining,
                key=lambda item: (
                    len(possible_by_voice[item]),
                    min((row["closest_fixed_similarity"] for row in possible_by_voice[item]), default=1.0),
                ),
            )
            possible = possible_by_voice[voice_id]
            if not possible:
                return False
            possible.sort(key=lambda candidate: (
                max(
                    [candidate["closest_fixed_similarity"], *[
                        pair_score(candidate, previous) for previous in selected.values()
                    ]]
                ),
                candidate["cer"],
            ))
            for candidate in possible:
                selected[voice_id] = candidate
                chosen_order.append(voice_id)
                # Forward-check every remaining voice before descending.
                future_counts = {
                    future_voice: sum(
                        all(pair_score(option, previous) < threshold for previous in selected.values())
                        and all(ecapa_pair_score(option, previous) < ecapa_threshold for previous in selected.values())
                        for option in eligible[future_voice]
                    )
                    for future_voice in remaining
                    if future_voice != voice_id
                }
                future_ok = all(count > 0 for count in future_counts.values())
                if future_ok and search():
                    return True
                chosen_order.pop()
                del selected[voice_id]
            return False

        if search():
            return list(selected.values()), chosen_order.copy()
        return None, []

    selected = None
    order: list[str] = []
    selected_threshold = MAX_FINAL_SIMILARITY
    selected_ecapa_threshold = MAX_FINAL_ECAPA_SIMILARITY
    for threshold, ecapa_threshold in (
        (0.86, 0.70),
        (0.87, 0.71),
        (0.88, 0.72),
        (0.89, 0.74),
        (MAX_FINAL_SIMILARITY, MAX_FINAL_ECAPA_SIMILARITY),
    ):
        selected, order = find_solution(threshold, ecapa_threshold)
        if selected is not None:
            selected_threshold = threshold
            selected_ecapa_threshold = ecapa_threshold
            break
    if selected is None:
        print(json.dumps({
            "status": "no-global-solution",
            "hard_similarity_threshold": MAX_FINAL_SIMILARITY,
            "hard_ecapa_similarity_threshold": MAX_FINAL_ECAPA_SIMILARITY,
            "visited_nodes": visited_nodes,
        }, ensure_ascii=False))
        return 1

    selected_pair_scores = [
        pair_score(selected[left], selected[right])
        for left in range(len(selected))
        for right in range(left + 1, len(selected))
    ]
    selected_ecapa_pair_scores = [
        ecapa_pair_score(selected[left], selected[right])
        for left in range(len(selected))
        for right in range(left + 1, len(selected))
    ]
    best_max = max([
        *[row["closest_fixed_similarity"] for row in selected],
        *selected_pair_scores,
    ])
    best_sum = sum(row["closest_fixed_similarity"] + row["cer"] for row in selected) + sum(selected_pair_scores)
    best_ecapa_max = max([
        *[row["closest_fixed_ecapa_similarity"] for row in selected],
        *selected_ecapa_pair_scores,
    ])
    selected_by_id = {row["voice_id"]: row for row in selected}
    output_rows = []
    for item in plan:
        row = selected_by_id[item["id"]]
        output_rows.append({
            key: value
            for key, value in row.items()
            if key not in {"embedding", "ecapa_embedding"}
        })

    all_candidate_output = []
    for row in candidate_rows:
        all_candidate_output.append({
            key: value
            for key, value in row.items()
            if key not in {"embedding", "ecapa_embedding"}
        })
    report = {
        "status": "selected",
        "hard_similarity_threshold": MAX_FINAL_SIMILARITY,
        "hard_ecapa_similarity_threshold": MAX_FINAL_ECAPA_SIMILARITY,
        "selected_search_threshold": selected_threshold,
        "selected_ecapa_search_threshold": selected_ecapa_threshold,
        "selected_global_max_similarity": best_max,
        "selected_global_max_ecapa_similarity": best_ecapa_max,
        "selected_objective_sum": best_sum,
        "selection_order": order,
        "selected": output_rows,
        "candidates": all_candidate_output,
    }
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "selected_global_max_similarity": round(best_max, 6),
        "selected_global_max_ecapa_similarity": round(best_ecapa_max, 6),
        "selected": [
            {
                "voice_id": row["voice_id"],
                "seed": row["seed"],
                "cer": round(row["cer"], 6),
                "closest_fixed_voice": row["closest_fixed_voice"],
                "closest_fixed_similarity": round(row["closest_fixed_similarity"], 6),
                "median_f0_hz": row["metrics"]["median_f0_hz"],
            }
            for row in output_rows
        ],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
