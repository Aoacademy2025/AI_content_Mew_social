#!/usr/bin/env python3
"""
Local Whisper transcription helper.
Usage: python3 whisper_transcribe.py <audio_path> [model_name]
Output: JSON to stdout with keys: words, segments, text
"""
import sys
import json
import os
import io

# Force UTF-8 stdout/stderr on Windows (cp1252 default can't encode Thai)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: whisper_transcribe.py <audio_path> [model]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "large-v3-turbo"

    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"File not found: {audio_path}"}))
        sys.exit(1)

    try:
        import whisper
    except ImportError:
        print(json.dumps({"error": "openai-whisper not installed. Run: pip install openai-whisper"}))
        sys.exit(1)

    # Load model (cached after first run)
    model = whisper.load_model(model_name)

    # Transcribe with word-level timestamps
    result = model.transcribe(
        audio_path,
        language="th",
        word_timestamps=True,
        verbose=False,
        condition_on_previous_text=False,
        temperature=0,
    )

    # Build word-level output
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({
                "word": w["word"].strip(),
                "start": round(w["start"], 3),
                "end": round(w["end"], 3),
            })

    # Segment-level output
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "text": seg["text"].strip(),
            "start": round(seg["start"], 3),
            "end": round(seg["end"], 3),
        })

    output = {
        "text": result.get("text", "").strip(),
        "words": words,
        "segments": segments,
        "language": result.get("language", "th"),
    }

    print(json.dumps(output, ensure_ascii=False))

if __name__ == "__main__":
    main()
