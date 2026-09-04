"""Audited v13-compatible Thai/English segmentation; no text rewriting."""

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
