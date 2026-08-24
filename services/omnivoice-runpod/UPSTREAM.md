# Upstream provenance

This module replaces the original HERO AI OmniVoice RunPod worker with the completed
Hero-Voice-Ai implementation from:

- Repository: `https://github.com/Aoacademy2025/Hero-Voice-Ai.git`
- Imported commit: `565d0e62e1d4269099a4c3fba8a2ecef9167eeea`
- Imported on: 2026-08-24

The FastAPI engine, language splitting, voice cloning, similarity selection, voice
library, stock catalog, and 48 reference WAV files originate from that commit. The
RunPod contract, pinned container build, privacy-safe logging, payload limits, and
application adapter are maintained in this repository because HERO AI Creator Studio
owns authentication, quotas, durable jobs, cancellation, billing, and media retention.
