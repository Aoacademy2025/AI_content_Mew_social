import fs from "fs";
import path from "path";

type RenderJob = {
  status: "running" | "done" | "error";
  videoUrl?: string;
  error?: string;
  startedAt: number;
  progress?: number;
};

// Use global to survive hot-reload re-imports within the same Node process.
// Both render/route.ts and render-cancel/route.ts share the same Maps this way.
declare global {
  // eslint-disable-next-line no-var
  var __renderCancelByJobId: Map<string, () => void> | undefined;
  // eslint-disable-next-line no-var
  var __renderCancelByUserId: Map<string, () => void> | undefined;
  // Promise that resolves when the in-flight render for a given render scope finishes (or is cancelled).
  // New jobs in the same scope wait on this before calling renderMedia.
  // eslint-disable-next-line no-var
  var __renderJobDoneByUserId: Map<string, Promise<void>> | undefined;
  // Global bundle lock — only one bundle() call runs at a time; others await the same promise.
  // eslint-disable-next-line no-var
  var __bundleInProgress: Promise<string> | null | undefined;
  // Total active render count across hot-reloads.
  // eslint-disable-next-line no-var
  var __activeRenderCount: number | undefined;
  // CPU-heavy renderMedia slot queue across hot-reloads.
  // eslint-disable-next-line no-var
  var __activeRenderSlots: number | undefined;
  // eslint-disable-next-line no-var
  var __renderSlotWaiters: (() => void)[] | undefined;
}

export const cancelByJobId: Map<string, () => void> =
  (global.__renderCancelByJobId ??= new Map());

export const activeRenderCancel: Map<string, () => void> =
  (global.__renderCancelByUserId ??= new Map());

// Per-scope promise: resolves when the current render job for that user+draft/session is finished.
export const renderJobDoneByUser: Map<string, Promise<void>> =
  (global.__renderJobDoneByUserId ??= new Map());

// Global bundle lock.
export function getBundleInProgress(): Promise<string> | null {
  return global.__bundleInProgress ?? null;
}
export function setBundleInProgress(p: Promise<string> | null) {
  global.__bundleInProgress = p;
}

export function getActiveRenderCount(): number {
  return global.__activeRenderCount ?? 0;
}
export function incrementActiveRenderCount() {
  global.__activeRenderCount = (global.__activeRenderCount ?? 0) + 1;
}
export function decrementActiveRenderCount() {
  global.__activeRenderCount = Math.max(0, (global.__activeRenderCount ?? 1) - 1);
}

export function getActiveRenderSlots(): number {
  return global.__activeRenderSlots ?? 0;
}

export function getRenderSlotQueueLength(): number {
  return (global.__renderSlotWaiters ?? []).length;
}

export async function withRenderSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  const safeLimit = Math.max(1, Math.floor(limit));
  global.__renderSlotWaiters ??= [];
  if ((global.__activeRenderSlots ?? 0) >= safeLimit) {
    await new Promise<void>((resolve) => global.__renderSlotWaiters!.push(resolve));
  } else {
    global.__activeRenderSlots = (global.__activeRenderSlots ?? 0) + 1;
  }

  try {
    return await fn();
  } finally {
    const next = global.__renderSlotWaiters.shift();
    if (next) {
      next();
    } else {
      global.__activeRenderSlots = Math.max(0, (global.__activeRenderSlots ?? 1) - 1);
    }
  }
}

function jobsDir(): string {
  const d = path.join(process.cwd(), ".tmp", "render-jobs");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

export function getRenderJob(jobId: string): RenderJob | undefined {
  try {
    const raw = fs.readFileSync(
      path.join(jobsDir(), `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
      "utf-8"
    );
    return JSON.parse(raw) as RenderJob;
  } catch { return undefined; }
}

export function setRenderJob(jobId: string, job: RenderJob) {
  try {
    fs.writeFileSync(
      path.join(jobsDir(), `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
      JSON.stringify(job)
    );
  } catch {}
}
