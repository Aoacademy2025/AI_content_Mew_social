import crypto from "node:crypto";

export const BRAND_VISUAL_GATE_COMPILER_CONTRACT = "brand-visual-v1-provider-input-v2";

export type QualityGateEntry = {
  id: string;
  benchmark: "visual-format" | "brand-differentiation";
  sceneId: "hook" | "explain" | "close";
  variant: "neutral" | "mewsocial" | "control";
  visualFormatId: string;
  recipeVersion: string;
  seed: number;
  prompt: string;
  negativePrompt: string;
  caseHash: string;
  status: "pending" | "submitted" | "completed" | "failed";
  providerJobId?: string;
  providerStatus?: string;
  providerCostUsd?: number;
  delayTimeMs?: number;
  executionTimeMs?: number;
  imagePath?: string;
  sha256?: string;
  width?: number;
  height?: number;
  bytes?: number;
  error?: string;
  submittedAt?: string;
  completedAt?: string;
  reviewDecision?: "pass" | "fail";
  reviewCriteriaVersion?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
};

type CaseFingerprintInput = Pick<
  QualityGateEntry,
  | "id"
  | "benchmark"
  | "sceneId"
  | "variant"
  | "visualFormatId"
  | "recipeVersion"
  | "seed"
  | "prompt"
  | "negativePrompt"
> & {
  endpointId: string;
  model: string;
  width: number;
  height: number;
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function qualityGateCaseHash(input: CaseFingerprintInput): string {
  return sha256(JSON.stringify({
    contract: BRAND_VISUAL_GATE_COMPILER_CONTRACT,
    endpointId: input.endpointId,
    model: input.model,
    width: input.width,
    height: input.height,
    id: input.id,
    benchmark: input.benchmark,
    sceneId: input.sceneId,
    variant: input.variant,
    visualFormatId: input.visualFormatId,
    recipeVersion: input.recipeVersion,
    seed: input.seed,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
  }));
}

export function qualityGateCompilerHash(entries: readonly Pick<QualityGateEntry, "id" | "caseHash">[]): string {
  return sha256(JSON.stringify(
    [...entries]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => [entry.id, entry.caseHash]),
  ));
}

/** `--only` narrows provider work, never the persisted 21-case evidence set. */
export function qualityGateEntrySelected(entryId: string, only?: string): boolean {
  return !only || entryId.includes(only);
}

function legacyTupleMatches(current: QualityGateEntry, prior: QualityGateEntry): boolean {
  return current.id === prior.id
    && current.benchmark === prior.benchmark
    && current.sceneId === prior.sceneId
    && current.variant === prior.variant
    && current.visualFormatId === prior.visualFormatId
    && current.recipeVersion === prior.recipeVersion
    && current.seed === prior.seed
    && current.prompt === prior.prompt
    && current.negativePrompt === prior.negativePrompt;
}

/** Resume only provider work whose exact provider-input tuple is still current.
 * Every current compiler field wins; stale evidence/review is discarded rather
 * than being spread over the newly compiled entry. */
export function reconcileQualityGateEntry(input: {
  current: QualityGateEntry;
  prior?: QualityGateEntry;
  imageExists: (relativePath: string) => boolean;
}): QualityGateEntry {
  const { current, prior } = input;
  if (!prior) return current;
  const sameCase = prior.caseHash
    ? prior.caseHash === current.caseHash
    : legacyTupleMatches(current, prior);
  if (!sameCase) return current;

  if (prior.status === "completed" && prior.imagePath && input.imageExists(prior.imagePath)) {
    return {
      ...current,
      status: "completed",
      providerJobId: prior.providerJobId,
      providerStatus: prior.providerStatus,
      providerCostUsd: prior.providerCostUsd,
      delayTimeMs: prior.delayTimeMs,
      executionTimeMs: prior.executionTimeMs,
      imagePath: prior.imagePath,
      sha256: prior.sha256,
      width: prior.width,
      height: prior.height,
      bytes: prior.bytes,
      submittedAt: prior.submittedAt,
      completedAt: prior.completedAt,
      reviewDecision: prior.reviewDecision,
      reviewCriteriaVersion: prior.reviewCriteriaVersion,
      reviewedBy: prior.reviewedBy,
      reviewedAt: prior.reviewedAt,
      reviewNotes: prior.reviewNotes,
    };
  }
  if (prior.status === "submitted" && prior.providerJobId) {
    return {
      ...current,
      status: "submitted",
      providerJobId: prior.providerJobId,
      submittedAt: prior.submittedAt,
    };
  }
  return current;
}
