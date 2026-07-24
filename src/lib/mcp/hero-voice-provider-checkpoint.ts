export const HERO_VOICE_PROVIDER_CHECKPOINT_VERSION = 1 as const;

export interface HeroVoiceProviderCheckpointV1 {
  version: typeof HERO_VOICE_PROVIDER_CHECKPOINT_VERSION;
  provider: "omnivoice";
  aiGenerationJobId: string;
  providerStartedAt: string;
  providerDeadlineAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHeroVoiceProviderCheckpoint(
  raw: string | null | undefined,
): HeroVoiceProviderCheckpointV1 | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.version !== HERO_VOICE_PROVIDER_CHECKPOINT_VERSION
    || value.provider !== "omnivoice"
    || typeof value.aiGenerationJobId !== "string"
    || value.aiGenerationJobId.length === 0
    || typeof value.providerStartedAt !== "string"
    || !Number.isFinite(Date.parse(value.providerStartedAt))
    || typeof value.providerDeadlineAt !== "string"
    || !Number.isFinite(Date.parse(value.providerDeadlineAt))
    || Date.parse(value.providerDeadlineAt) <= Date.parse(value.providerStartedAt)) {
    return null;
  }
  return value as unknown as HeroVoiceProviderCheckpointV1;
}

export function serializeHeroVoiceProviderCheckpoint(
  checkpoint: HeroVoiceProviderCheckpointV1,
): string {
  return JSON.stringify(checkpoint);
}
