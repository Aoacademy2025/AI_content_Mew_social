"""Thai CTC acoustic clock. Original text never leaves this process.

Model attribution: VISTEC/AIResearch, airesearch/wav2vec2-large-xlsr-53-th,
CC-BY-SA-4.0, https://huggingface.co/airesearch/wav2vec2-large-xlsr-53-th.
Weights are not redistributed here. See README.md for qualification limits.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np

MODEL = "airesearch/wav2vec2-large-xlsr-53-th"
REVISION = "3155938c549b23eee16b1d4b55dcb161b7fe4bcf"
VERSION = "thai-ctc-v1"
MAX_DURATION = 360
MAX_CHARACTERS = 12_000
MAX_CELLS = 250_000_000


def source_tokens(text: str, vocab: dict[str, int]):
    """Map acoustic labels back to exact JS UTF-16 offsets; never normalize display text."""
    tokens, spans = [], []
    offset = 0
    for char in text:
        size = len(char.encode("utf-16-le")) // 2
        if (unicodedata.category(char)[0] in "LMN" and char in vocab
                and char not in "ฯๆ"):
            tokens.append(vocab[char])
            spans.append((offset, offset + size))
        offset += size
    return tokens, spans


def viterbi(log_probs: np.ndarray, tokens: list[int], blank: int, delimiter: int):
    """CTC path with blank-separated repeats. Return frames per original label."""
    if not tokens or log_probs.ndim != 2:
        raise ValueError("empty_alignment")
    labels = np.full(2 * len(tokens) + 1, blank, dtype=np.int32)
    labels[1::2] = tokens
    states = len(labels)
    if len(log_probs) * states > MAX_CELLS:
        raise ValueError("alignment_size_limit")
    prior = np.full(states, -np.inf, dtype=np.float32)
    prior[0] = 0
    decisions = np.zeros((len(log_probs), states), dtype=np.uint8)
    jumps = np.zeros(states, dtype=bool)
    jumps[2:] = (labels[2:] != blank) & (labels[2:] != labels[:-2])
    acoustic = log_probs.copy()
    # Word delimiters carry no source character: either delimiter or blank may
    # separate Thai letters. They must never become a guessed word boundary.
    acoustic[:, blank] = np.logaddexp(acoustic[:, blank], acoustic[:, delimiter])
    for index, frame in enumerate(acoustic):
        one = np.concatenate(([-np.inf], prior[:-1]))
        two = np.concatenate(([-np.inf, -np.inf], prior[:-2]))
        two[~jumps] = -np.inf
        scores = np.stack((prior, one, two))
        decisions[index] = np.argmax(scores, axis=0)
        prior = np.max(scores, axis=0) + frame[labels]
    state = states - 1 if prior[-1] > prior[-2] else states - 2
    if not np.isfinite(prior[state]):
        raise ValueError("unreachable_alignment")
    frames = [[] for _ in tokens]
    for index in range(len(acoustic) - 1, -1, -1):
        if state % 2:
            frames[(state - 1) // 2].append(index)
        state -= int(decisions[index, state])
    if any(not item for item in frames):
        raise ValueError("incomplete_alignment")
    return [list(reversed(item)) for item in frames]


class Aligner:
    def __init__(self, threads: int = 2, download: bool = False):
        import torch
        from transformers import AutoModelForCTC, AutoProcessor
        torch.set_num_threads(max(1, min(4, threads)))
        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(
            MODEL, revision=REVISION, local_files_only=not download)
        self.model = AutoModelForCTC.from_pretrained(
            MODEL, revision=REVISION, local_files_only=not download).eval()
        self.vocab = self.processor.tokenizer.get_vocab()

    def emissions(self, audio: np.ndarray):
        clocks, emissions = [], []
        # Twenty-second interiors, two seconds of context each side. Exact
        # convolution stride/receptive-field geometry avoids cumulative offsets.
        stride = int(np.prod(self.model.config.conv_stride))
        receptive, accumulated_stride = 1, 1
        for kernel, step in zip(self.model.config.conv_kernel, self.model.config.conv_stride):
            receptive += (kernel - 1) * accumulated_stride
            accumulated_stride *= step
        with self.torch.inference_mode():
            for start in range(0, len(audio), 20 * 16_000):
                low, high = max(0, start - 32_000), min(len(audio), start + 22 * 16_000)
                inputs = self.processor(audio[low:high], sampling_rate=16_000, return_tensors="pt")
                log = self.model(**inputs).logits[0].log_softmax(-1).numpy()
                centres = low + np.arange(len(log)) * stride + receptive / 2
                selected = (centres >= start) & (centres < min(len(audio), start + 20 * 16_000))
                clocks.append(centres[selected] / 16_000)
                emissions.append(log[selected])
        return np.concatenate(clocks), np.concatenate(emissions)

    def align(self, audio: np.ndarray, text: str):
        if not 0.1 <= len(audio) / 16_000 <= MAX_DURATION or not np.isfinite(audio).all():
            raise ValueError("audio_duration_invalid")
        if not text or len(text) > MAX_CHARACTERS:
            raise ValueError("text_size_invalid")
        tokens, spans = source_tokens(text, self.vocab)
        if not tokens:
            raise ValueError("unsupported_text")
        times, log = self.emissions(audio)
        frames = viterbi(log, tokens, self.model.config.pad_token_id, self.vocab["|"])
        characters = []
        for index, item in enumerate(frames):
            characters.append({
                "startChar": spans[index][0], "endChar": spans[index][1],
                "startMs": max(0, int((round(times[item[0]] * 16000) - 160 + 8) // 16)),
                "endMs": min(round(len(audio) / 16), int((round(times[item[-1]] * 16000) + 160 + 8) // 16)),
                "confidence": round(float(np.exp(np.max(log[item, tokens[index]]))), 6),
            })
        return {"version": VERSION, "modelRevision": REVISION,
                "audioDurationMs": round(len(audio) / 16), "characters": characters}


def read_audio(data: bytes):
    import soundfile as sf
    from scipy.signal import resample_poly
    from math import gcd
    audio, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    if not 8000 <= rate <= 96000 or audio.shape[1] > 2 or len(audio) / rate > MAX_DURATION:
        raise ValueError("audio_format_invalid")
    audio = audio.mean(axis=1)
    if rate != 16000:
        divisor = gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
    return audio


def main():
    if sys.argv[1:] == ["--download-model"]:
        Aligner(download=True)
        print(json.dumps({"status": "ready", "modelRevision": REVISION}))
        return
    started = time.monotonic()
    raw = sys.stdin.buffer.read(100_001)
    if len(raw) > 100_000:
        raise ValueError("request_size_limit")
    request = json.loads(raw)
    audio_path = Path(request["audioPath"])
    if audio_path.suffix.lower() != ".wav" or audio_path.stat().st_size > 40_000_000:
        raise ValueError("audio_format_invalid")
    data = audio_path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != request["audioHash"]:
        raise ValueError("audio_changed")
    text = request["text"]
    # Cross-process lock BEFORE loading weights bounds RSS and CPU when several
    # orchestrations arrive together. Parent wall-clock timeout also covers wait.
    import fcntl
    lock_root = Path(os.environ.get("SUBTITLE_ACOUSTIC_CACHE_DIR", "/tmp/heroai-subtitle-alignment"))
    lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (lock_root / "worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            os.nice(10)
        except (AttributeError, OSError):
            pass
        aligner = Aligner(threads=int(os.environ.get("SUBTITLE_ACOUSTIC_THREADS", "2")))
        result = aligner.align(read_audio(data), text)
    result.update(audioHash=digest, textHash=hashlib.sha256(text.encode()).hexdigest(),
                  durationMs=round((time.monotonic() - started) * 1000))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Neither input, filename, provider output nor library exception is safe
        # for telemetry. The parent records a fixed failure code and completes.
        print(json.dumps({"error": "acoustic_alignment_unavailable"}))
        sys.exit(1)
