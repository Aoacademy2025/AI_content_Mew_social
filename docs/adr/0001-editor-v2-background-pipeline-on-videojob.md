# ADR 0001: Editor v2 background render builds on the VideoJob orchestrator, not RENDER_VIA_QUEUE

Date: 2026-07-02
Status: Accepted

## Context

The Video Editor v2 redesign requires "background render": the user clicks Render, the whole
generation pipeline (TTS → transcribe → keywords/b-roll → base render, optionally avatar)
runs server-side, the tab can be closed, and the editor later resumes at the subtitle-editing
phase. Today the web editor orchestrates the pipeline **from the browser** (closing the tab
stops it, and a beacon actively cancels the render job), so this is a real architectural change.

Two existing systems could host it:

1. **VideoJob + mcp-video-worker** — the MCP path's server-side pipeline. Already runs every
   stage (TTS, captions, keywords, stock, config, base render, avatar, burn) as a durable
   background job with progress/stage reporting and safe-stage recovery on worker restart.
   Missing piece: it always burns subtitles and only persists `{videoUrl, videoId}` — no
   captions/config handoff for post-render editing.
2. **RenderJob + RENDER_VIA_QUEUE** — the web render queue. Covers only the Remotion
   render/burn steps; extending it to the full pipeline means redesigning its schema, breaking
   the orchestrator into queue-step functions, parent/child job linkage, and it is gated on
   fixing a known cross-process supersede/quota-leak race first.

A read-only spike (2026-07-02) compared both: option 1 ≈ 3–4 person-weeks of mostly small
items; option 2 ≈ 5–7 person-weeks with three large items plus the blocking quota-leak fix.

## Decision

Editor v2's background pipeline extends **VideoJob/orchestrator** with a **preview mode**:

- The job stops after the base render (and avatar composite when avatar is enabled) and does
  **not** burn subtitles.
- `outputJson` is extended (and **versioned** — readers must accept both the old
  `{videoUrl, videoId}` shape and the new one) to carry captions, config, voiceUrl and
  duration so the web editor can resume into the Post phase.
- The web editor submits render work as a VideoJob and resumes by jobId; Burn remains a
  separate final step.
- Durable export jobs carry a versioned native editor snapshot (latest captions, subtitle
  config, card grouping, and per-card overrides) in their input/output. "Edit subtitles"
  after export restores that snapshot; export rows created before this field existed fall
  back to their source preview.
- Interactive avatar-position adjustment stays a Post-phase action using the existing free
  re-composite (no HeyGen re-generation).

## Consequences

- Web and MCP share one generation pipeline long-term — quality parity fixes (e.g. PR #122)
  no longer need porting between two paths.
- The MCP path is touched: preview mode must be a strictly additive branch; existing MCP
  clients keep getting fully burned videos.
- The RENDER_VIA_QUEUE quota-leak fix is no longer a prerequisite for v2 (deferred).
- mcp-video-worker gains web traffic: concurrency/fairness tuning (and possibly a heartbeat
  watchdog like render-worker's) becomes necessary; the server upgrade to 8 vCPU/32 GB happens
  **before** v2 is enabled for all users.
