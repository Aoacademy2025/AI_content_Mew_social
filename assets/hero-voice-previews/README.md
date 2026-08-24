# Hero AI Voice v2 previews

Authenticated static previews for the 48 stock voices imported from Hero-Voice-Ai
commit `565d0e62e1d4269099a4c3fba8a2ecef9167eeea` on 2026-08-24.

The same WAV files are used as the worker's reference voices. They are committed in
both locations deliberately: this directory is packaged with the Next.js application,
while `services/omnivoice-runpod/assets/voices/` is the isolated Docker build context.
Keeping the canonical filenames and transcripts in
`services/omnivoice-runpod/assets/voices/voices.json` prevents the UI and worker catalogs
from drifting without cold-starting a GPU for preview playback.
