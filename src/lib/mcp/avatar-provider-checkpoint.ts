import { createHash } from "node:crypto";

import type { OrchCaption } from "@/lib/mcp/orchestrator-steps";
import type { SubtitleTimingSource } from "@/lib/mcp/subtitle-quality";
import {
  parseSubtitleSpeechCoverage,
  type SubtitleSpeechCoverage,
} from "@/lib/subtitle-speech-coverage";

export const AVATAR_PROVIDER_CHECKPOINT_VERSION = 1 as const;

export type AvatarProviderPhase =
  | "intro_generate"
  | "intro_wait"
  | "tail_generate"
  | "tail_wait"
  | "composite";

type CheckpointCaption = Pick<OrchCaption, "text" | "startMs" | "endMs"> & {
  tag?: OrchCaption["tag"];
};

export interface AvatarProviderCheckpointV1 {
  version: typeof AVATAR_PROVIDER_CHECKPOINT_VERSION;
  provider: "heygen";
  phase: AvatarProviderPhase;
  providerStartedAt: string;
  providerDeadlineAt: string;
  /** Number of local composite executions already started. Optional for v1 checkpoints. */
  compositeAttempts?: number;
  baseUrl: string;
  voiceUrl: string;
  audioDurationMs: number;
  captions: CheckpointCaption[];
  words: unknown[];
  fullText: string;
  /** Origin of the timing that was quality-gated before the provider wait. */
  subtitleTimingSource?: SubtitleTimingSource;
  speechCoverage?: SubtitleSpeechCoverage;
  baseConfig: Record<string, unknown>;
  avatar: {
    mode: "full" | "bookend" | "bookend-both";
    id: string;
    introSecs: number;
    tailSecs: number;
    layout: { scale: number; offsetX: number; offsetY: number };
    introAudioUrl?: string;
    tailAudioUrl?: string;
    introVideoId?: string;
    tailVideoId?: string;
    introVideoUrl?: string;
    tailVideoUrl?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalSubtitleTimingSource(value: unknown): value is SubtitleTimingSource | undefined {
  return value === undefined
    || value === "provider_alignment"
    || value === "tts_segment_timing"
    || value === "forced_alignment"
    || value === "upload_transcription";
}

function isOptionalSubtitleSpeechCoverage(value: unknown): value is SubtitleSpeechCoverage | undefined {
  return value === undefined || parseSubtitleSpeechCoverage(value) !== null;
}

function isCaption(value: unknown): value is CheckpointCaption {
  if (!isRecord(value)) return false;
  if (typeof value.text !== "string" || !isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) return false;
  if (value.startMs < 0 || value.endMs < value.startMs) return false;
  return value.tag === undefined || value.tag === "hook" || value.tag === "body" || value.tag === "cta";
}

function isLayout(value: unknown): value is AvatarProviderCheckpointV1["avatar"]["layout"] {
  return isRecord(value)
    && isFiniteNumber(value.scale)
    && isFiniteNumber(value.offsetX)
    && isFiniteNumber(value.offsetY);
}

function isAvatar(value: unknown): value is AvatarProviderCheckpointV1["avatar"] {
  if (!isRecord(value)) return false;
  if (value.mode !== "full" && value.mode !== "bookend" && value.mode !== "bookend-both") return false;
  return isNonEmptyString(value.id)
    && isFiniteNumber(value.introSecs)
    && value.introSecs > 0
    && isFiniteNumber(value.tailSecs)
    && value.tailSecs > 0
    && isLayout(value.layout)
    && isOptionalString(value.introAudioUrl)
    && isOptionalString(value.tailAudioUrl)
    && isOptionalString(value.introVideoId)
    && isOptionalString(value.tailVideoId)
    && isOptionalString(value.introVideoUrl)
    && isOptionalString(value.tailVideoUrl);
}

function phaseRequirementsHold(checkpoint: AvatarProviderCheckpointV1): boolean {
  const { avatar, phase } = checkpoint;
  if (phase === "intro_wait") return !!avatar.introVideoId;
  if (phase === "tail_generate") return avatar.mode === "bookend-both" && !!avatar.introVideoUrl;
  if (phase === "tail_wait") return avatar.mode === "bookend-both" && !!avatar.introVideoUrl && !!avatar.tailVideoId;
  if (phase === "composite") {
    return !!avatar.introVideoUrl && (avatar.mode !== "bookend-both" || !!avatar.tailVideoUrl);
  }
  return phase === "intro_generate";
}

export function parseAvatarProviderCheckpoint(raw: string | null | undefined): AvatarProviderCheckpointV1 | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const phases: readonly AvatarProviderPhase[] = ["intro_generate", "intro_wait", "tail_generate", "tail_wait", "composite"];
  if (value.version !== AVATAR_PROVIDER_CHECKPOINT_VERSION
    || value.provider !== "heygen"
    || !phases.includes(value.phase as AvatarProviderPhase)
    || !isIsoDate(value.providerStartedAt)
    || !isIsoDate(value.providerDeadlineAt)
    || (value.compositeAttempts !== undefined
      && (!Number.isInteger(value.compositeAttempts) || Number(value.compositeAttempts) < 0))
    || !isNonEmptyString(value.baseUrl)
    || !isNonEmptyString(value.voiceUrl)
    || !isFiniteNumber(value.audioDurationMs)
    || value.audioDurationMs < 0
    || !Array.isArray(value.captions)
    || !value.captions.every(isCaption)
    || !Array.isArray(value.words)
    || typeof value.fullText !== "string"
    || !isOptionalSubtitleTimingSource(value.subtitleTimingSource)
    || !isOptionalSubtitleSpeechCoverage(value.speechCoverage)
    || !isRecord(value.baseConfig)
    || !isAvatar(value.avatar)) {
    return null;
  }

  const checkpoint = value as unknown as AvatarProviderCheckpointV1;
  if (Date.parse(checkpoint.providerDeadlineAt) <= Date.parse(checkpoint.providerStartedAt)) return null;
  return phaseRequirementsHold(checkpoint) ? checkpoint : null;
}

export function serializeAvatarProviderCheckpoint(value: AvatarProviderCheckpointV1): string {
  return JSON.stringify(value);
}

export function providerPollDelayMs(startedAtMs: number, nowMs: number, retryAfterSec?: number): number {
  const age = Math.max(0, nowMs - startedAtMs);
  const scheduled = age < 10 * 60_000 ? 15_000 : age < 30 * 60_000 ? 30_000 : 60_000;
  const retry = Number.isFinite(retryAfterSec) && Number(retryAfterSec) > 0
    ? Math.min(120_000, Math.round(Number(retryAfterSec) * 1000))
    : 0;
  return Math.max(scheduled, retry);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}

export function videoJobInputFingerprint(inputJson: string): string {
  let normalized: string;
  try {
    normalized = `json:${JSON.stringify(canonicalize(JSON.parse(inputJson)))}`;
  } catch {
    normalized = `raw:${inputJson}`;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Fingerprint only the authored script. Recovery uses this narrower identity because
 * a normal retry may change layout/search settings while still superseding the same
 * failed deliverable in the same editor project.
 */
export function videoJobScriptFingerprint(inputJson: string): string | null {
  try {
    const value = JSON.parse(inputJson) as unknown;
    if (!isRecord(value) || typeof value.script !== "string" || value.script.length === 0) return null;
    return createHash("sha256").update(`script:${value.script}`).digest("hex");
  } catch {
    return null;
  }
}
