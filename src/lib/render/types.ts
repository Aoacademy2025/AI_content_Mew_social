export type RenderJobType = "RENDER" | "BURN";
export type RenderJobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** Everything run-render needs to produce an MP4 — copied from the legacy render route's POST body. */
export type RenderPayload = {
  shortVideoConfig: unknown;          // the Remotion input props (existing config shape)
  fps?: number;
  jpegQuality?: number;
  subtitleOverlayConfig?: unknown;    // present for BURN jobs
};

export type RenderResult = { videoUrl: string };
