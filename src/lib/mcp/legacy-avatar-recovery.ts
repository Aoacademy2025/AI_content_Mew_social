import { statSync } from "node:fs";

import { mediaRootPaths, parseCanonicalMediaRef } from "@/lib/media-cleanup";
import { prisma } from "@/lib/prisma";
import {
  parseAvatarProviderCheckpoint,
  serializeAvatarProviderCheckpoint,
  videoJobInputFingerprint,
  type AvatarProviderCheckpointV1,
} from "@/lib/mcp/avatar-provider-checkpoint";
import type { AvatarProviderPollResult } from "@/lib/mcp/avatar-provider-resume";

export const LEGACY_AVATAR_TIMEOUT_ERROR = "avatar generation timed out";

export type LegacyAvatarRecoveryInput = {
  jobId: string;
  heygenVideoId: string;
};

export type LegacyAvatarRecoveryDeps = {
  workspaceRoot?: string;
  now?: () => Date;
  pollProvider: (userId: string, providerVideoId: string) => Promise<AvatarProviderPollResult>;
};

type RecoveryGuard = {
  userId: string;
  projectId: string;
  jobCreatedAt: Date;
  inputFingerprint: string;
  errorMessage: string;
  checkpointJson: string;
};

type PublicInspection = {
  status: "recoverable" | "pending" | "superseded" | "rejected";
  jobId: string;
  heygenVideoId: string;
  reason: string;
  supersedingJobId?: string;
};

export type LegacyAvatarRecoveryInspection = PublicInspection;

const recoverySecrets = new WeakMap<
  LegacyAvatarRecoveryInspection,
  { checkpoint: AvatarProviderCheckpointV1; guard: RecoveryGuard }
>();

function rejected(input: LegacyAvatarRecoveryInput, reason: string): LegacyAvatarRecoveryInspection {
  return { status: "rejected", jobId: input.jobId, heygenVideoId: input.heygenVideoId, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function localMediaExists(raw: string, workspaceRoot: string): boolean {
  const parsed = parseCanonicalMediaRef(raw, mediaRootPaths(workspaceRoot));
  if (parsed.kind !== "reference") return false;
  try {
    return statSync(parsed.ref.absolutePath).isFile();
  } catch {
    return false;
  }
}

function parseCaptions(value: unknown): AvatarProviderCheckpointV1["captions"] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const captions: AvatarProviderCheckpointV1["captions"] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) return null;
    const startMs = Number(item.startMs);
    const endMs = Number(item.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) return null;
    const tag = item.tag === "hook" || item.tag === "body" || item.tag === "cta" ? item.tag : undefined;
    captions.push({ text: item.text, startMs, endMs, ...(tag ? { tag } : {}) });
  }
  return captions;
}

async function findBaseRender(job: {
  id: string;
  userId: string;
  startedAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  const exact = await prisma.renderJob.findMany({
    where: { parentJobId: job.id, userId: job.userId, type: "RENDER", status: "DONE", videoUrl: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (exact.length === 1) return { kind: "found" as const, render: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous" as const };

  const candidates = await prisma.renderJob.findMany({
    where: {
      userId: job.userId,
      type: "RENDER",
      status: "DONE",
      videoUrl: { not: null },
      createdAt: {
        gte: job.startedAt ?? job.createdAt,
        lte: job.finishedAt ?? new Date(),
      },
    },
    orderBy: { createdAt: "desc" },
  });
  if (candidates.length === 1) return { kind: "found" as const, render: candidates[0] };
  return { kind: candidates.length > 1 ? "ambiguous" as const : "missing" as const };
}

export async function inspectLegacyAvatarRecovery(
  input: LegacyAvatarRecoveryInput,
  deps: LegacyAvatarRecoveryDeps,
): Promise<LegacyAvatarRecoveryInspection> {
  if (!input.jobId || !/^[\w-]{3,200}$/.test(input.heygenVideoId)) return rejected(input, "invalid_arguments");

  const job = await prisma.videoJob.findUnique({ where: { id: input.jobId } });
  if (!job) return rejected(input, "job_not_found");
  if (job.status !== "failed" || job.currentStep !== "avatar" || job.providerCheckpointJson !== null) {
    return rejected(input, "invalid_job_state");
  }
  if (job.errorMessage !== LEGACY_AVATAR_TIMEOUT_ERROR) return rejected(input, "timeout_error_not_approved");
  if (!job.projectId) return rejected(input, "project_required");
  const project = await prisma.editorProject.findUnique({ where: { id: job.projectId }, select: { userId: true } });
  if (!project || project.userId !== job.userId) return rejected(input, "project_owner_mismatch");

  const fingerprint = videoJobInputFingerprint(job.inputJson);
  const newerDone = await prisma.videoJob.findMany({
    where: {
      projectId: job.projectId,
      userId: job.userId,
      status: "done",
      createdAt: { gt: job.createdAt },
    },
    select: { id: true, inputJson: true },
    orderBy: { createdAt: "desc" },
  });
  const superseding = newerDone.find((candidate) => videoJobInputFingerprint(candidate.inputJson) === fingerprint);
  if (superseding) {
    return {
      status: "superseded",
      jobId: job.id,
      heygenVideoId: input.heygenVideoId,
      reason: "newer_successful_retry",
      supersedingJobId: superseding.id,
    };
  }

  let parsedInput: Record<string, unknown>;
  try {
    const value = JSON.parse(job.inputJson) as unknown;
    if (!isRecord(value)) return rejected(input, "invalid_input_json");
    parsedInput = value;
  } catch {
    return rejected(input, "invalid_input_json");
  }
  const avatarMode = parsedInput.avatarMode;
  if (avatarMode !== "full" && avatarMode !== "bookend") return rejected(input, "unsupported_avatar_mode");
  if (typeof parsedInput.avatarId !== "string" || !parsedInput.avatarId) return rejected(input, "avatar_id_missing");

  const renderResult = await findBaseRender(job);
  if (renderResult.kind !== "found") return rejected(input, renderResult.kind === "ambiguous" ? "base_render_ambiguous" : "base_render_not_found");
  const render = renderResult.render;
  const baseUrl = render.videoUrl!;
  const workspaceRoot = deps.workspaceRoot ?? process.cwd();
  if (!localMediaExists(baseUrl, workspaceRoot)) return rejected(input, "base_media_missing");

  let payload: Record<string, unknown>;
  try {
    const value = JSON.parse(render.payload) as unknown;
    if (!isRecord(value)) return rejected(input, "render_payload_invalid");
    payload = value;
  } catch {
    return rejected(input, "render_payload_invalid");
  }
  if (!isRecord(payload.resolvedShortConfig)) return rejected(input, "render_config_missing");
  const baseConfig = payload.resolvedShortConfig;
  const captions = parseCaptions(payload.captionsData);
  if (!captions) return rejected(input, "captions_missing");
  const voiceUrl = typeof baseConfig.voiceFile === "string" ? baseConfig.voiceFile : "";
  if (!voiceUrl || !localMediaExists(voiceUrl, workspaceRoot)) return rejected(input, "voice_media_missing");

  const poll = await deps.pollProvider(job.userId, input.heygenVideoId);
  if (poll.status === "failed") return rejected(input, "provider_not_recoverable");
  const completed = poll.status === "completed" && typeof poll.videoUrl === "string" && poll.videoUrl.length > 0;
  const pending = !completed && (poll.status === "processing" || poll.status === "pending" || poll.status === "queued");
  if (!completed && !pending) return rejected(input, "provider_status_invalid");

  const fps = Math.max(1, finite(payload.fps, 30));
  const frames = finite(baseConfig.durationInFrames, 0);
  const captionDurationMs = captions.reduce((max, caption) => Math.max(max, caption.endMs), 0);
  const audioDurationMs = Math.max(1, Math.round(frames > 0 ? frames / fps * 1000 : captionDurationMs));
  const now = deps.now?.() ?? new Date();
  const checkpoint: AvatarProviderCheckpointV1 = {
    version: 1,
    provider: "heygen",
    phase: completed ? "composite" : "intro_wait",
    providerStartedAt: (job.startedAt ?? job.createdAt).toISOString(),
    providerDeadlineAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
    baseUrl,
    voiceUrl,
    audioDurationMs,
    captions,
    words: [],
    fullText: captions.map((caption) => caption.text).join(""),
    baseConfig,
    avatar: {
      mode: avatarMode,
      id: parsedInput.avatarId,
      introSecs: Math.max(1, Math.min(30, Math.round(finite(parsedInput.avatarIntroSecs, 5)))),
      tailSecs: Math.max(1, Math.min(30, Math.round(finite(parsedInput.avatarTailSecs, 5)))),
      layout: {
        scale: finite(parsedInput.avatarScale, 1),
        offsetX: finite(parsedInput.avatarOffsetX, 0),
        offsetY: finite(parsedInput.avatarOffsetY, 0),
      },
      introVideoId: input.heygenVideoId,
      ...(completed ? { introVideoUrl: poll.videoUrl! } : {}),
    },
  };
  const checkpointJson = serializeAvatarProviderCheckpoint(checkpoint);
  const validatedCheckpoint = parseAvatarProviderCheckpoint(checkpointJson);
  if (!validatedCheckpoint) return rejected(input, "checkpoint_reconstruction_invalid");
  const inspection: LegacyAvatarRecoveryInspection = {
    status: completed ? "recoverable" : "pending",
    jobId: job.id,
    heygenVideoId: input.heygenVideoId,
    reason: completed ? "provider_completed" : "provider_pending",
  };
  recoverySecrets.set(inspection, {
    checkpoint: validatedCheckpoint,
    guard: {
      userId: job.userId,
      projectId: job.projectId,
      jobCreatedAt: job.createdAt,
      inputFingerprint: fingerprint,
      errorMessage: job.errorMessage,
      checkpointJson,
    },
  });
  return inspection;
}

export async function applyLegacyAvatarRecovery(
  inspection: LegacyAvatarRecoveryInspection,
): Promise<{ applied: boolean; idempotent: boolean; jobId: string }> {
  const secret = recoverySecrets.get(inspection);
  if ((inspection.status !== "recoverable" && inspection.status !== "pending") || !secret) {
    throw new Error("legacy_recovery_not_applicable");
  }
  return prisma.$transaction(async (tx) => {
    // Re-check the superseded invariant at the write boundary. A normal retry may
    // finish after inspection's provider call; recovery must never overtake it.
    const newerDone = await tx.videoJob.findMany({
      where: {
        projectId: secret.guard.projectId,
        userId: secret.guard.userId,
        status: "done",
        createdAt: { gt: secret.guard.jobCreatedAt },
      },
      select: { inputJson: true },
    });
    if (newerDone.some((candidate) => videoJobInputFingerprint(candidate.inputJson) === secret.guard.inputFingerprint)) {
      return { applied: false, idempotent: false, jobId: inspection.jobId };
    }

    const updated = await tx.videoJob.updateMany({
      where: {
        id: inspection.jobId,
        userId: secret.guard.userId,
        status: "failed",
        currentStep: "avatar",
        errorMessage: secret.guard.errorMessage,
        providerCheckpointJson: null,
      },
      data: {
        status: "waiting_provider",
        currentStep: "avatar",
        progress: 84,
        finishedAt: null,
        providerCheckpointJson: secret.guard.checkpointJson,
        providerNextPollAt: new Date(),
      },
    });
    if (updated.count === 1) return { applied: true, idempotent: false, jobId: inspection.jobId };

    const current = await tx.videoJob.findUnique({
      where: { id: inspection.jobId },
      select: { status: true, providerCheckpointJson: true },
    });
    const idempotent = current?.status === "waiting_provider" && current.providerCheckpointJson === secret.guard.checkpointJson;
    return { applied: false, idempotent, jobId: inspection.jobId };
  });
}

export function formatLegacyAvatarRecoveryResult(inspection: LegacyAvatarRecoveryInspection): string {
  const safe: PublicInspection = {
    status: inspection.status,
    jobId: inspection.jobId,
    heygenVideoId: inspection.heygenVideoId,
    reason: inspection.reason,
    ...(inspection.supersedingJobId ? { supersedingJobId: inspection.supersedingJobId } : {}),
  };
  return JSON.stringify(safe);
}
