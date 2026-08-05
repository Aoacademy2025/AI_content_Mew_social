import { SERVICE_SECRET_HEADER, SERVICE_ACTAS_HEADER } from "@/lib/mcp/service-actor";
import { Agent, fetch as undiciFetch } from "undici";

const BASE = process.env.MCP_INTERNAL_BASE_URL || "http://127.0.0.1:3000";

// Pipeline endpoints can legitimately run for minutes. /api/videos/fetch-stock caps at
// 10 minutes, while /api/heygen/composite allows up to 60 minutes and may run several
// bounded ffmpeg steps. The client timeout must sit ABOVE the longest route cap; otherwise
// a slow-but-healthy request is abandoned while the server keeps working, and a retry can
// start the same expensive work again. Use one dispatcher that waits for the route result.
// (Agent + fetch come from the SAME undici import so the dispatcher is actually honored —
// handing a node_modules Agent to Node's built-in global fetch is not reliable.)
export const DEFAULT_PIPELINE_TIMEOUT_MS = 65 * 60 * 1000;

const PIPELINE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MCP_PIPELINE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : DEFAULT_PIPELINE_TIMEOUT_MS;
})();
const pipelineDispatcher = new Agent({
  headersTimeout: PIPELINE_TIMEOUT_MS,
  bodyTimeout: PIPELINE_TIMEOUT_MS,
  connectTimeout: 30_000,
});

export interface PipelineCaller {
  /** opts.retries=0 for calls that SPEND scarce external/platform capacity (Kie,
   *  OmniVoice synthesis) —
   *  a transport-timeout retry there means paying for the whole batch again. */
  post<T>(path: string, body: unknown, opts?: { retries?: number }): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

export class PipelineHttpError extends Error {
  constructor(
    public readonly method: "POST" | "GET" | "PATCH",
    public readonly path: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const detail = typeof body === "string" ? body : (JSON.stringify(body) ?? String(body));
    super(`${method} ${path} → ${status}: ${detail.slice(0, 300)}`);
    this.name = "PipelineHttpError";
  }
}

export class PipelineResponseParseError extends Error {
  constructor(
    public readonly method: "POST" | "GET" | "PATCH",
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`${method} ${path} → ${status}: invalid JSON response`);
    this.name = "PipelineResponseParseError";
  }
}

export type PipelineFailureDetails = {
  message: string;
  code?: string;
  provider?: string;
};

/** Preserve structured endpoint failures when a background pipeline job becomes terminal. */
export function pipelineFailureDetails(error: unknown): PipelineFailureDetails | null {
  if (!(error instanceof PipelineHttpError)) return null;

  const body = error.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const nestedError = record.error;
  const message = typeof nestedError === "string"
    ? nestedError
    : nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)
      ? (nestedError as Record<string, unknown>).message
      : undefined;
  const nestedCode = nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)
    ? (nestedError as Record<string, unknown>).code
    : undefined;
  const code = typeof record.reason === "string"
    ? record.reason
    : typeof record.code === "string"
      ? record.code
      : typeof nestedCode === "string"
        ? nestedCode
        : undefined;
  const provider = typeof record.provider === "string" ? record.provider : undefined;

  if (typeof message !== "string" || message.trim().length === 0) return null;
  return { message: message.trim(), ...(code ? { code } : {}), ...(provider ? { provider } : {}) };
}

/** Decode the JSON contract shared by every internal pipeline endpoint. */
export function decodePipelineResponse<T>(
  method: "POST" | "GET" | "PATCH",
  path: string,
  status: number,
  text: string,
): T {
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (status >= 200 && status < 300) {
        // A 2xx HTML/text body is normally a transient proxy/upstream corruption, not a
        // valid pipeline result. Throw a transport-like error so withRetry can recover.
        throw new PipelineResponseParseError(method, path, status);
      }
      parsed = text;
    }
  }
  if (status < 200 || status >= 300) throw new PipelineHttpError(method, path, status, parsed);
  return parsed as T;
}

function statusFromPipelineError(error: unknown): number | null {
  if (error instanceof PipelineHttpError) return error.status;
  if (error instanceof PipelineResponseParseError) return null;
  // Compatibility with callers/tests that predate PipelineHttpError and throw the old
  // formatted Error. Without this, a deterministic 4xx was misclassified as transport
  // and executed three times after the typed-error migration.
  if (error instanceof Error) {
    const match = error.message.match(/^(?:POST|GET|PATCH)\s+\S+\s+→\s+(\d{3})(?::|\s|$)/);
    if (match) return Number(match[1]);
  }
  return null;
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
      const status = statusFromPipelineError(e);
      const retriable = status === null || status >= 500; // transport error (no status) or 5xx
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
  async function req<T>(method: "POST" | "GET" | "PATCH", path: string, body?: unknown, opts?: { retries?: number }): Promise<T> {
    return withRetry(async () => {
      const res = await undiciFetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, dispatcher: pipelineDispatcher });
      const text = await res.text();
      return decodePipelineResponse<T>(method, path, res.status, text);
    }, { retries: opts?.retries });
  }
  return {
    post: (path, body, opts) => req("POST", path, body, opts),
    patch: (path, body) => req("PATCH", path, body),
    get: (path) => req("GET", path),
  };
}

/** Poll /api/videos/render-progress until done/error or timeout. Returns the final videoUrl. */
export async function pollRender(
  caller: PipelineCaller,
  jobId: string,
  onProgress?: (pct: number, stage: string | null) => void,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; checkCanceled?: () => Promise<void> } = {},
): Promise<string> {
  const interval = opts.intervalMs ?? 2000;
  // The render worker allows one job up to 45 minutes, and a job may wait behind both
  // worker slots before it starts. Keep polling beyond that wall-clock budget; genuine
  // failures and user cancellation are still observed on every poll.
  const timeout = opts.timeoutMs ?? 60 * 60 * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - start < timeout) {
    // Cooperative cancel from the owning VideoJob — the hook throws to abort the poll.
    // OUTSIDE the try below so it can never be swallowed as a transient poll error.
    await opts.checkCanceled?.();
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
