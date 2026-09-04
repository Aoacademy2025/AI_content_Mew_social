from __future__ import annotations

import json
from typing import Any


class CanonicalJsonError(ValueError):
    pass


def _reject_constant(_value: str) -> None:
    raise CanonicalJsonError("non-finite JSON number")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in pairs:
        if key in output:
            raise CanonicalJsonError("duplicate JSON key")
        output[key] = value
    return output


def loads_strict(data: bytes) -> Any:
    try:
        text = data.decode("utf-8", errors="strict")
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_reject_constant)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CanonicalJsonError("invalid JSON") from exc


def dumps_jcs(value: Any) -> bytes:
    # All evaluator schemas use integers/strings/booleans/arrays/objects only,
    # avoiding cross-language float serialization at the evidence boundary.
    def validate(item: Any) -> None:
        if item is None or isinstance(item, (str, bool)):
            return
        if isinstance(item, int) and not isinstance(item, bool):
            if abs(item) > 9_007_199_254_740_991:
                raise CanonicalJsonError("integer outside interoperable range")
            return
        if isinstance(item, list):
            for child in item:
                validate(child)
            return
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            for child in item.values():
                validate(child)
            return
        raise CanonicalJsonError("unsupported canonical value")

    validate(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def loads_exact_jcs(data: bytes) -> Any:
    value = loads_strict(data)
    if dumps_jcs(value) != data:
        raise CanonicalJsonError("JSON is not exact canonical bytes")
    return value
