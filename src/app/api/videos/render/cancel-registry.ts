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
}

export const cancelByJobId: Map<string, () => void> =
  (global.__renderCancelByJobId ??= new Map());

export const activeRenderCancel: Map<string, () => void> =
  (global.__renderCancelByUserId ??= new Map());

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
