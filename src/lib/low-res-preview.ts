import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { recordTelemetryEvent } from "@/lib/telemetry";
import {
  existingLowResPreviewUrlForVideoUrl,
  lowResPreviewInfoForVideoUrl,
  type LowResPreviewInfo,
} from "@/lib/low-res-preview-paths";

type PreviewQueueStatus = "ready" | "queued" | "skipped";

type PreviewQueueResult = {
  status: PreviewQueueStatus;
  previewVideoUrl: string | null;
  reason?: string;
};

type PreviewJob = {
  info: LowResPreviewInfo;
  userId: string | null;
  videoId: string | null;
  reason: string;
};

const MAX_QUEUED_PREVIEWS = 3;
const activePreviewFiles = new Set<string>();
const queuedPreviews = new Map<string, PreviewJob>();
let previewWorkerRunning = false;

function previewEncodeProfile(width: number) {
  if (width >= 720) {
    return { crf: "25", maxrate: "2500k", bufsize: "5000k", audioBitrate: "128k" };
  }
  return { crf: "30", maxrate: "1200k", bufsize: "2400k", audioBitrate: "96k" };
}

function mb(filePath: string) {
  try {
    return Number((fs.statSync(filePath).size / (1024 * 1024)).toFixed(1));
  } catch {
    return null;
  }
}

function emitPreviewTelemetry(
  userId: string | null,
  name: string,
  status: "started" | "done" | "error" | "skip",
  job: PreviewJob,
  startedAt: number,
  extra: Record<string, unknown> = {},
) {
  void recordTelemetryEvent(userId, {
    name,
    category: "performance",
    source: "server",
    step: "preview",
    status,
    durationMs: Date.now() - startedAt,
    properties: {
      videoId: job.videoId,
      reason: job.reason,
      previewWidth: job.info.previewWidth,
      sourceFilename: job.info.sourceFilename,
      previewFilename: job.info.previewFilename,
      sourceMb: mb(job.info.sourceFilePath),
      previewMb: mb(job.info.previewFilePath),
      queueLength: queuedPreviews.size,
      ...extra,
    },
  }).catch(() => {});
}

function runFfmpegPreview(job: PreviewJob): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const tmpPath = `${job.info.previewFilePath}.tmp-${process.pid}-${Date.now()}.mp4`;
  const profile = previewEncodeProfile(job.info.previewWidth);

  fs.mkdirSync(path.dirname(job.info.previewFilePath), { recursive: true });
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {}

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      "-y",
      "-i", job.info.sourceFilePath,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-vf", `scale=${job.info.previewWidth}:-2`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", profile.crf,
      "-maxrate", profile.maxrate,
      "-bufsize", profile.bufsize,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", profile.audioBitrate,
      "-ac", "2",
      "-movflags", "+faststart",
      "-threads", "1",
      tmpPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    proc.on("error", (error) => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      reject(error);
    });
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(tmpPath)) {
        fs.renameSync(tmpPath, job.info.previewFilePath);
        resolve();
        return;
      }

      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      reject(new Error(`ffmpeg preview exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

async function drainPreviewQueue() {
  if (previewWorkerRunning) return;
  previewWorkerRunning = true;

  try {
    while (queuedPreviews.size > 0) {
      const next = queuedPreviews.entries().next().value as [string, PreviewJob] | undefined;
      if (!next) break;

      const [key, job] = next;
      queuedPreviews.delete(key);

      if (fs.existsSync(job.info.previewFilePath)) continue;
      if (!fs.existsSync(job.info.sourceFilePath)) continue;

      const startedAt = Date.now();
      activePreviewFiles.add(key);
      emitPreviewTelemetry(job.userId, "low_res_preview_started", "started", job, startedAt);

      try {
        await runFfmpegPreview(job);
        emitPreviewTelemetry(job.userId, "low_res_preview_done", "done", job, startedAt);
      } catch (error) {
        console.error("[low-res-preview] generation failed:", error);
        emitPreviewTelemetry(job.userId, "low_res_preview_error", "error", job, startedAt, {
          message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
        });
      } finally {
        activePreviewFiles.delete(key);
      }
    }
  } finally {
    previewWorkerRunning = false;
  }
}

export function enqueueLowResPreview(
  videoUrl: string | null | undefined,
  options: { userId?: string | null; videoId?: string | null; reason?: string } = {},
): PreviewQueueResult {
  const readyUrl = existingLowResPreviewUrlForVideoUrl(videoUrl);
  if (readyUrl) return { status: "ready", previewVideoUrl: readyUrl };

  const info = lowResPreviewInfoForVideoUrl(videoUrl);
  if (!info?.sourceExists) {
    return { status: "skipped", previewVideoUrl: null, reason: "source_not_local_or_missing" };
  }

  const key = info.previewFilePath;
  if (activePreviewFiles.has(key) || queuedPreviews.has(key)) {
    return { status: "queued", previewVideoUrl: null, reason: "already_queued" };
  }

  if (queuedPreviews.size >= MAX_QUEUED_PREVIEWS) {
    return { status: "skipped", previewVideoUrl: null, reason: "queue_full" };
  }

  queuedPreviews.set(key, {
    info,
    userId: options.userId ?? null,
    videoId: options.videoId ?? null,
    reason: options.reason ?? "unspecified",
  });
  void drainPreviewQueue();

  return { status: "queued", previewVideoUrl: null };
}
