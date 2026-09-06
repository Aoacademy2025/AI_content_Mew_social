"""Audited v13-compatible Thai/English segmentation; no text rewriting.

`split_thai_dominant` adds one policy on top of the v13 split: inside Thai text,
short English runs stay in the Thai segment so the model reads them with the
cloned Thai voice instead of switching to a separate English generation.
"""

from __future__ import annotations


def split_by_language(text: str) -> list[tuple[str, str]]:
    def script_of(character: str) -> str | None:
        codepoint = ord(character)
        if 0x0E00 <= codepoint <= 0x0E7F:
            return "Thai"
        if "a" <= character.lower() <= "z":
            return "English"
        return None

    segments: list[list[str]] = []
    for character in text:
        script = script_of(character)
        if not segments:
            segments.append([character, script or "Thai"])
            continue
        current = segments[-1]
        if script is None or script == current[1]:
            current[0] += character
        else:
            segments.append([character, script])

    result: list[tuple[str, str]] = []
    for segment, language in segments:
        if segment.strip() and any(script_of(character) for character in segment):
            result.append((segment, language))
        elif result:
            result[-1] = (result[-1][0] + segment, result[-1][1])
        elif segment.strip():
            result.append((segment, language))
    return result or [(text, "Thai")]


THAI_DOMINANT_MAX_ENGLISH_WORDS = 4


def _is_thai(character: str) -> bool:
    return 0x0E00 <= ord(character) <= 0x0E7F


def _english_word_count(segment: str) -> int:
    return sum(
        1
        for token in segment.split()
        if any(character.isascii() and character.isalpha() for character in token)
    )


def split_thai_dominant(text: str) -> list[tuple[str, str]]:
    """v13 split, then merge English runs of at most four words into Thai.

    Text without any Thai character is returned exactly as `split_by_language`
    would, so English-only scripts keep their English generation path.
    """
    segments = split_by_language(text)
    if not any(_is_thai(character) for character in text):
        return segments
    merged: list[tuple[str, str]] = []
    for segment, language in segments:
        if language == "English" and _english_word_count(segment) <= THAI_DOMINANT_MAX_ENGLISH_WORDS:
            language = "Thai"
        if merged and merged[-1][1] == language:
            merged[-1] = (merged[-1][0] + segment, language)
        else:
            merged.append((segment, language))
    return merged
