"""Thread-safe, lazy voice-clone prompt cache for the OmniVoice worker."""

from collections.abc import Callable, Mapping
from threading import Lock
from typing import Any


VoiceMetadata = Mapping[str, Any]
PromptFactory = Callable[[str, VoiceMetadata], Any]


class VoicePromptCache:
    """Create each supported voice prompt once, on its first request."""

    def __init__(self, manifest: Mapping[str, VoiceMetadata], factory: PromptFactory):
        self._manifest = dict(manifest)
        self._factory = factory
        self._prompts: dict[str, Any] = {}
        self._lock = Lock()

    def get(self, voice_id: str) -> Any:
        metadata = self._manifest.get(voice_id)
        if metadata is None:
            raise KeyError(voice_id)

        with self._lock:
            prompt = self._prompts.get(voice_id)
            if prompt is None:
                prompt = self._factory(voice_id, metadata)
                self._prompts[voice_id] = prompt
            return prompt
