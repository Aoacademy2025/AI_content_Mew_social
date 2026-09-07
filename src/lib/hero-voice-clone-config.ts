export const HERO_VOICE_CLONE_CONFIG_KEYS = [
  "RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID",
  "RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST",
  "RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION",
  "RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256",
  "RUNPOD_API_KEY",
] as const;
export const HERO_VOICE_CLONE_SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb" as const;

export type HeroVoiceCloneConfigInput = {
  RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID: string | undefined;
  RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST: string | undefined;
  RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION: string | undefined;
  RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256: string | undefined;
  RUNPOD_API_KEY: string | undefined;
};

export type HeroVoiceCloneConfig = {
  backend: "runpod";
  endpointId: string;
  apiKey: string;
  contractVersion: 3;
  workerKind: "clone-only";
  workerVersion: "hero-voice-clone-contract-v3-internal-eval-2";
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  experimentProfile: "combined-quality-v1";
  numStep: 32;
  maxChunkChars: 800;
  requestBudgetMs: 540_000;
};

export class HeroVoiceCloneConfigError extends Error {
  readonly code = "CLONE_CONFIG_UNAVAILABLE";

  constructor() {
    super("Hero Voice clone configuration is unavailable");
    this.name = "HeroVoiceCloneConfigError";
  }
}

const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_REVISION = /^[0-9a-f]{40}$/;

/** Pure five-input resolver. Do not add a fallback endpoint, legacy variable,
 * profile override, or mutable tag here: those would make accepted jobs move
 * when process configuration changes. */
export function resolveHeroVoiceCloneConfig(input: HeroVoiceCloneConfigInput): HeroVoiceCloneConfig {
  const endpointId = (input.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID ?? "").trim();
  const imageDigest = (input.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST ?? "").trim();
  const sourceRevision = (input.RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION ?? "").trim();
  const modelManifestSha256 = (input.RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256 ?? "").trim();
  const apiKey = (input.RUNPOD_API_KEY ?? "").trim();

  if (!ENDPOINT_ID.test(endpointId)
    || !imageDigest.startsWith("sha256:")
    || !SHA256.test(imageDigest.slice(7))
    || !SOURCE_REVISION.test(sourceRevision)
    || sourceRevision !== HERO_VOICE_CLONE_SOURCE_REVISION
    || !SHA256.test(modelManifestSha256)
    || !apiKey) {
    throw new HeroVoiceCloneConfigError();
  }

  return {
    backend: "runpod",
    endpointId,
    apiKey,
    contractVersion: 3,
    workerKind: "clone-only",
    workerVersion: "hero-voice-clone-contract-v3-internal-eval-2",
    imageDigest,
    sourceRevision,
    modelManifestSha256,
    experimentProfile: "combined-quality-v1",
    numStep: 32,
    maxChunkChars: 800,
    requestBudgetMs: 540_000,
  };
}

export type HeroVoiceCloneHumanDataGate =
  | Readonly<{ kind: "task6-human-data-gate"; evidenceSha256: string }>
  /** ADR 0061: the data subject (the allowlisted owner account) accepted sending
   * their own reference recording to the pinned RunPod worker. Opened per
   * deployment by `HERO_VOICE_CLONE_PRODUCTION=1`; rollback = unset it. */
  | Readonly<{ kind: "owner-consent-production-gate"; adr: "0061" }>;

export const HERO_VOICE_CLONE_GATE_KINDS: ReadonlySet<HeroVoiceCloneHumanDataGate["kind"]> = new Set([
  "task6-human-data-gate",
  "owner-consent-production-gate",
]);

/** The application transport remains inert unless exactly one of two explicit
 * decisions is present: (a) the isolated canary — Task 6 evidence digest plus the
 * local canary execution mode, never in production (ADR 0060); or (b) the
 * owner-consent production opt-in (ADR 0061), which never combines with the
 * canary execution mode. Without either, every environment fails closed. This
 * gate is deliberately separate from the exact five-input endpoint resolver. */
export function resolveHeroVoiceCloneHumanDataGate(input: {
  nodeEnv: string | undefined;
  executionMode: string | undefined;
  task6GateSha256: string | undefined;
  productionOptIn?: string | undefined;
}): HeroVoiceCloneHumanDataGate {
  if (input.productionOptIn === "1") {
    if (input.executionMode !== undefined || input.task6GateSha256 !== undefined) {
      throw new HeroVoiceCloneConfigError();
    }
    return Object.freeze({ kind: "owner-consent-production-gate", adr: "0061" });
  }
  const evidenceSha256 = (input.task6GateSha256 ?? "").trim();
  if (input.nodeEnv === "production" || input.executionMode !== "1" || !SHA256.test(evidenceSha256)) {
    throw new HeroVoiceCloneConfigError();
  }
  return Object.freeze({ kind: "task6-human-data-gate", evidenceSha256 });
}
