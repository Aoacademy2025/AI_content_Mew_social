---
status: accepted
---

# Public HeroAI MCP jobs run as a Preview Mode render followed by a server-chained Export

Until 2026-10, `create_video_job` ran the orchestrator straight through to a burned video with no Editor project and no preview data. Every MCP clip was therefore a dead end: the web editor's export and B-roll re-render paths refuse a source without `projectId` and `preview` (`api/videos/jobs/route.ts`). The 60-day audit (2026-10-01) found about 18% of MCP jobs re-created the same script, which looks like editing by regeneration and spends paying creators' quota.

We decided that, behind `MCP_EDITOR_PROJECT`, an MCP create now builds an Agent-created Project and runs a Preview Mode job exactly as the web editor does. When that job finishes, the server enqueues the existing `mode: "export"` job with a server-built subtitle overlay. The agent still receives one finished video, plus a link to keep editing in the web editor. `get_video_status` reports the pair as a single status.

## Considered Options

- **One job that persists preview data and also burns.** Rejected. No such path exists: the preview branch returns before the burn, so this would need a new orchestrator branch and a second, unproven settlement path for the burn charge.
- **Stop at preview and let the agent call export.** Deferred to P2. Without editing tools an agent has nothing to do between preview and export, and a creator who wants no edits must still get a finished clip in one request.

## Consequences

- MCP and web clips have identical structure, and the once-per-video charge stays on the proven `isBurnAlreadyPaid` path.
- Delivery takes slightly longer because the export is a second queued job.
- Cancelling or failing either half must be reported against the original `jobId`.
