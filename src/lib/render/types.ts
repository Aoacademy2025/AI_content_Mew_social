import type { ResolvedRenderInput } from "@/lib/render/run-render";

export type RenderJobType = "RENDER" | "BURN";
export type RenderJobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/**
 * The persisted render payload = the JSON-serializable subset of ResolvedRenderInput.
 * The legacy route fully resolves a ResolvedRenderInput (req-bound asset resolution,
 * baseUrl, absolute URLs, duration/size overrides, bundle entry point) BEFORE enqueue;
 * everything in that shape is plain data/URLs/numbers and JSON-serializable EXCEPT
 * `bundleCache` — a process-level object passed by reference (it has methods) that
 * cannot cross to a separate worker process. So the payload stores every field except
 * `bundleCache`; the worker (next task) reconstructs the full input by adding its OWN
 * process-level bundleCache before calling runRender.
 */
export type RenderPayload = Omit<ResolvedRenderInput, "bundleCache">;

export type RenderResult = { videoUrl: string };
