---
status: accepted
---

# Story Film narration provider is explicit

Faceless Hero Story Film projects store an explicit narration provider instead of inferring it from a voice ID. The internal pilot supports `hero_voice` and account-owned `elevenlabs`; ElevenLabs work is pinned server-side to `eleven_v3`, resolves Mew's saved cloned voice when the controller omits a voice ID, and keeps the API key inside Hero. Studio and the private MCP send the same provider-neutral project command, while only the system worker calls the selected voice adapter. An ElevenLabs request with an uncertain result is never submitted automatically a second time, because avoiding an accidental duplicate quota charge is more important than unattended retry. This seam lets a future public Credits-backed provider replace the internal account adapter without changing Story Film stages or the `mewshort` conversation.
