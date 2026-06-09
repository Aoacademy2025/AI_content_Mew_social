import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";

const MIN_VALID_FILE_BYTES = 1_500;

export type ProcessingReconcileAction = "complete" | "fail" | "keep";

export type ProcessingReconcileItem = {
  id: string;
  userId: string;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
  ageMinutes: number;
  videoUrl: string | null;
  avatarVideoUrl: string | null;
  hasOutputUrl: boolean;
  outputExists: boolean;
  outputIsRemote: boolean;
  outputSizeMb: number | null;
  action: ProcessingReconcileAction;
  reason: string;
};

export type ProcessingReconcileSummary = {
  total: number;
  completeCandidates: number;
  failCandidates: number;
  keepCandidates: number;
  withOutputUrl: number;
  existingOutput: number;
  missingOutput: number;
  oldestAgeMinutes: number | null;
};

export type ProcessingReconcilePlan = {
  options: {
    staleAfterMinutes: number;
    failAfterHours: number;
    limit: number;
  };
  summary: ProcessingReconcileSummary;
  items: ProcessingReconcileItem[];
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function localMediaPathFromUrl(rawUrl: string): string | null {
  let url = rawUrl;
  const isAbsoluteUrl = /^https?:\/\//i.test(rawUrl);
  if (isAbsoluteUrl) {
    try {
      url = new URL(rawUrl).pathname;
    } catch {
      return null;
    }
  }

  const publicDir = path.join(process.cwd(), "public");
  if (url.startsWith("/api/renders/")) return path.join(publicDir, "renders", url.slice("/api/renders/".length));
  if (url.startsWith("/renders/")) return path.join(publicDir, "renders", url.slice("/renders/".length));
  if (url.startsWith("/api/stocks/")) return path.join(process.cwd(), "stocks", url.slice("/api/stocks/".length));
  if (url.startsWith("/stocks/")) return path.join(process.cwd(), "stocks", url.slice("/stocks/".length));
  if (isAbsoluteUrl) return null;
  if (url.startsWith("/")) return path.join(publicDir, url);
  return null;
}

function inspectOutputUrl(rawUrl: string | null): { exists: boolean; remote: boolean; sizeMb: number | null; reason: string } {
  if (!rawUrl) return { exists: false, remote: false, sizeMb: null, reason: "no output URL" };

  const localPath = localMediaPathFromUrl(rawUrl);
  if (!localPath) {
    return /^https?:\/\//i.test(rawUrl)
      ? { exists: true, remote: true, sizeMb: null, reason: "has remote output URL" }
      : { exists: false, remote: false, sizeMb: null, reason: "output URL is not a known local media path" };
  }

  try {
    const stat = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
    if (stat?.isFile() && stat.size > MIN_VALID_FILE_BYTES) {
      return {
        exists: true,
        remote: false,
        sizeMb: Number((stat.size / (1024 * 1024)).toFixed(1)),
        reason: "local output file exists",
      };
    }
  } catch {}

  return { exists: false, remote: false, sizeMb: null, reason: "local output file missing or too small" };
}

function inspectVideoOutputs(videoUrl: string | null, avatarVideoUrl: string | null) {
  const primary = inspectOutputUrl(videoUrl);
  if (primary.exists) return primary;
  const avatar = inspectOutputUrl(avatarVideoUrl);
  if (avatar.exists) return avatar;
  return videoUrl ? primary : avatar;
}

export async function getProcessingReconcilePlan(options: {
  staleAfterMinutes?: unknown;
  failAfterHours?: unknown;
  limit?: unknown;
} = {}): Promise<ProcessingReconcilePlan> {
  const staleAfterMinutes = clampInt(options.staleAfterMinutes, 20, 5, 24 * 60);
  const failAfterHours = clampInt(options.failAfterHours, 3, 1, 72);
  const limit = clampInt(options.limit, 100, 1, 500);
  const now = Date.now();
  const staleCutoff = new Date(now - staleAfterMinutes * 60 * 1000);
  const failCutoffMs = now - failAfterHours * 60 * 60 * 1000;

  const videos = await prisma.video.findMany({
    where: { status: "PROCESSING", createdAt: { lte: staleCutoff } },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      updatedAt: true,
      videoUrl: true,
      avatarVideoUrl: true,
      user: { select: { email: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const items: ProcessingReconcileItem[] = videos.map((video) => {
    const ageMinutes = Math.max(0, Math.round((now - video.createdAt.getTime()) / 60_000));
    const output = inspectVideoOutputs(video.videoUrl, video.avatarVideoUrl);
    const hasOutputUrl = Boolean(video.videoUrl || video.avatarVideoUrl);
    const shouldFail = video.createdAt.getTime() <= failCutoffMs;
    const action: ProcessingReconcileAction = output.exists
      ? "complete"
      : shouldFail
        ? "fail"
        : "keep";
    const reason = output.exists
      ? output.reason
      : shouldFail
        ? `${output.reason}; older than ${failAfterHours}h`
        : `${output.reason}; waiting until ${failAfterHours}h`;

    return {
      id: video.id,
      userId: video.userId,
      userEmail: video.user?.email ?? null,
      createdAt: video.createdAt.toISOString(),
      updatedAt: video.updatedAt.toISOString(),
      ageMinutes,
      videoUrl: video.videoUrl,
      avatarVideoUrl: video.avatarVideoUrl,
      hasOutputUrl,
      outputExists: output.exists,
      outputIsRemote: output.remote,
      outputSizeMb: output.sizeMb,
      action,
      reason,
    };
  });

  const summary: ProcessingReconcileSummary = {
    total: items.length,
    completeCandidates: items.filter((item) => item.action === "complete").length,
    failCandidates: items.filter((item) => item.action === "fail").length,
    keepCandidates: items.filter((item) => item.action === "keep").length,
    withOutputUrl: items.filter((item) => item.hasOutputUrl).length,
    existingOutput: items.filter((item) => item.outputExists).length,
    missingOutput: items.filter((item) => item.hasOutputUrl && !item.outputExists).length,
    oldestAgeMinutes: items.length ? Math.max(...items.map((item) => item.ageMinutes)) : null,
  };

  return {
    options: { staleAfterMinutes, failAfterHours, limit },
    summary,
    items,
  };
}

export async function applyProcessingReconcile(
  plan: ProcessingReconcilePlan,
  options: { failMissingOutput?: boolean } = {},
) {
  const failMissingOutput = options.failMissingOutput ?? true;
  const completeIds = plan.items.filter((item) => item.action === "complete").map((item) => item.id);
  const failIds = failMissingOutput
    ? plan.items.filter((item) => item.action === "fail").map((item) => item.id)
    : [];

  const [completed, failed] = await Promise.all([
    completeIds.length
      ? prisma.video.updateMany({ where: { id: { in: completeIds }, status: "PROCESSING" }, data: { status: "COMPLETED" } })
      : Promise.resolve({ count: 0 }),
    failIds.length
      ? prisma.video.updateMany({ where: { id: { in: failIds }, status: "PROCESSING" }, data: { status: "FAILED" } })
      : Promise.resolve({ count: 0 }),
  ]);

  return {
    completed: completed.count,
    failed: failed.count,
    skipped: plan.items.length - completed.count - failed.count,
  };
}
