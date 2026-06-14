import { SERVICE_SECRET_HEADER, SERVICE_ACTAS_HEADER } from "@/lib/mcp/service-actor";

const BASE = process.env.MCP_INTERNAL_BASE_URL || "http://127.0.0.1:3000";

export interface PipelineCaller {
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

/** Retry transport errors + 5xx (NOT 4xx). 4xx are in-band errors (missing_key/quota) — never retry. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.match(/→ (\d{3}):/)?.[1];
      const retriable = !status || Number(status) >= 500; // transport error (no status) or 5xx
      if (!retriable || attempt === retries) throw e;
      await sleep(1000 * Math.pow(3, attempt)); // 1s, 3s
    }
  }
  throw lastErr;
}

/** A caller that authenticates every request as `userId` via the service seam. */
export function pipelineCaller(userId: string): PipelineCaller {
  const headers = {
    "Content-Type": "application/json",
    [SERVICE_SECRET_HEADER]: process.env.MCP_SERVICE_SECRET ?? "",
    [SERVICE_ACTAS_HEADER]: userId,
  };
  async function req<T>(method: "POST" | "GET" | "PATCH", path: string, body?: unknown): Promise<T> {
    return withRetry(async () => {
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      return (text ? JSON.parse(text) : {}) as T;
    });
  }
  return {
    post: (path, body) => req("POST", path, body),
    patch: (path, body) => req("PATCH", path, body),
    get: (path) => req("GET", path),
  };
}

/** Poll /api/videos/render-progress until done/error or timeout. Returns the final videoUrl. */
export async function pollRender(
  caller: PipelineCaller,
  jobId: string,
  onProgress?: (pct: number, stage: string | null) => void,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - start < timeout) {
    try {
      const p = await caller.get<{ progress: number; videoUrl: string | null; error: string | null; stage: string | null }>(
        `/api/videos/render-progress?jobId=${encodeURIComponent(jobId)}`,
      );
      consecutiveErrors = 0;
      onProgress?.(Number.isFinite(p.progress) ? p.progress : 0, p.stage);
      if (p.stage === "done" && p.videoUrl) return p.videoUrl;
      if (p.stage === "error" || (p.error && p.progress < 0)) throw new Error(`render failed: ${p.error ?? "unknown"}`);
    } catch (e) {
      // A genuine "render failed" must propagate; transient poll blips (server restart, one
      // 5xx) are tolerated for a few rounds so a 90%-done render isn't killed by a hiccup.
      if (e instanceof Error && e.message.startsWith("render failed")) throw e;
      if (++consecutiveErrors > 5) throw new Error(`render poll failed repeatedly: ${e instanceof Error ? e.message : "unknown"}`);
    }
    await sleep(interval);
  }
  throw new Error("render timed out");
}
