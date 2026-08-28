---
status: accepted
---

# Story Film reuses the Hero editorial engine behind an internal control plane

Hero Story Film keeps its dedicated internal MCP and durable gated project workflow, but its Final Cut does not own a second subtitle renderer. A provider-neutral editorial contract converts a canonical caption track, subtitle design, and Headline Hook into the existing `SubtitleOverlayComposition` used by Hero Studio. The Story Film renderer assembles and caches a clean story master, then applies that shared Remotion layer. Editorial-only revisions therefore reuse approved B-roll, narration, and music and never call Grok again.

Narration adapters persist timing with the Narration Master when available: ElevenLabs v3 character alignment and Hero Voice timing are converted to the same caption-track model. Presenter uploads queue a durable Gemini forced-alignment job beside Storyboard planning; transcript words must align back to the exact authored script before they become canonical captions. Provider failure or a text-quality mismatch falls back without blocking the film. The fallback is identified in render metadata and must not be described as word-accurate.

The public `create_video_job` tool is not invoked by Story Film: it would restart unrelated generation and billing steps. A future public Story Film product may expose the same control plane through API/RunPod generation and Credits settlement while retaining this shared editorial/render seam.
