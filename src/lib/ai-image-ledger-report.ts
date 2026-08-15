/**
 * Pure reporting helpers for AI-image credit-ledger rows.
 *
 * New durable image reservations use namespaced actions (`ai-image:<jobId>`),
 * while the older managed-KIE path wrote the exact legacy action (`ai-image`).
 * Admin reporting must include both and, when a durable job exists, prefer its
 * real model over inferring the provider from a shared credit delta.
 */

export type AiImageCostBucket = "hero1k" | "flux1k" | "gpt1k" | "nano1k" | "gpt2k" | "nano2k";

export type AiImageCounts = Record<AiImageCostBucket, number>;

export function emptyAiImageCounts(): AiImageCounts {
  return { hero1k: 0, flux1k: 0, gpt1k: 0, nano1k: 0, gpt2k: 0, nano2k: 0 };
}

export function aiImageLedgerActionWhere(kind: "spend" | "refund") {
  const base = kind === "spend" ? "ai-image" : "ai-image-refund";
  return { OR: [{ action: base }, { action: { startsWith: `${base}:` } }] };
}

export function aiImageJobIdFromAction(action: string | null | undefined): string | null {
  if (typeof action !== "string") return null;
  for (const prefix of ["ai-image:", "ai-image-refund:"] as const) {
    if (action.startsWith(prefix)) {
      const jobId = action.slice(prefix.length).trim();
      return jobId || null;
    }
  }
  return null;
}

export function aiImageCostBucket(input: {
  model?: string | null;
  delta: number;
}): AiImageCostBucket | null {
  const model = input.model?.trim().toLowerCase() ?? "";
  if (model === "z-image-turbo") return "hero1k";
  if (model === "flux2-klein-4b" || model === "flux-2/pro-text-to-image") return "flux1k";
  if (model === "gpt-image-2" || model === "gpt-image-2-text-to-image") return "gpt1k";
  if (model === "nano-banana-2") return "nano1k";

  // Legacy rows predate durable AiGenerationJob linkage. Keep their historical
  // credit-delta attribution as a fallback rather than dropping the spend.
  const absDelta = Math.abs(input.delta);
  if (absDelta === 2) return "flux1k";
  if (absDelta === 3) return "gpt1k";
  if (absDelta === 4) return "nano1k";
  if (absDelta === 5) return "gpt2k";
  if (absDelta === 6) return "nano2k";
  return null;
}
