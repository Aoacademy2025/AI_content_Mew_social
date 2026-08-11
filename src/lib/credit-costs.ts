/**
 * Pure credit cost tables + helpers — NO prisma import, so client bundles (Editor v2
 * Render Receipt) can derive per-image / per-minute prices from the SAME source the
 * server charges from. Re-exported by credits.ts for the server call sites.
 */

// ── Cost table ────────────────────────────────────────────────────────────────

/**
 * Cost in credits per action. Extend this map as new AI-gen features launch.
 * Unknown actions → 0 (safe default; callers should validate before spending).
 */
export const CREDIT_COST: Record<string, number> = {
  // Per-minute usage
  minute: 2,
  // Image generation
  "image-flux-1k": 2,
  "image-gpt-1k": 3,
  "image-nano-1k": 4,
  "image-gpt-2k": 5,
  "image-nano-2k": 6,
  "image-nano-4k": 8,
  "image-nano-8k": 12,
  // Runpod open-weight image tiers (AI Studio)
  "image-open-fast-1k": 2,
  "image-open-custom-1k": 2,
  "image-open-quality-1k": 4,
  // Video generation
  "video-seedance-5s": 10,
  "video-seedance-10s": 18,
  "video-seedance-15s": 25,
};

export function creditCostFor(action: string): number {
  return CREDIT_COST[action] ?? 0;
}

/** Hero Video normally uses the isolated custom Z-Image endpoint. Its approved
 * public incident route is deliberately price-matched; the route-policy test
 * fails if these two RunPod offers drift apart. */
export const HERO_AI_IMAGE_CREDIT_COST_KEY = "image-open-custom-1k";
export const HERO_AI_IMAGE_CREDITS = CREDIT_COST[HERO_AI_IMAGE_CREDIT_COST_KEY];

// ── kie.ai image model → credit cost-key mapping (managed-kie money path) ─────

/**
 * Map a kie.ai text-to-image model id to its credit CREDIT_COST key, or `null`
 * when the model is admin-only / not priced (→ no credit charge; only reachable
 * by admins running BYOK/free generation).
 *
 * Only these three models are priced for (and shown to) non-admin paid users:
 *   flux-2/pro-text-to-image  → image-flux-1k (2 credits)
 *   gpt-image-2-text-to-image → image-gpt-1k  (3 credits, default)
 *   nano-banana-2             → image-nano-1k (4 credits)
 * Every other model (incl. nano-banana-pro, seedream/*, grok, qwen2) → null.
 *
 * Keep in sync with CREDIT_COST above and the delta→bucket map in
 * src/app/api/admin/costs/route.ts (imageModelBucket).
 */
export function costKeyForKieModel(modelId: string): string | null {
  switch (modelId) {
    case "flux-2/pro-text-to-image":
      return "image-flux-1k";
    case "gpt-image-2-text-to-image":
      return "image-gpt-1k";
    case "nano-banana-2":
      return "image-nano-1k";
    default:
      return null;
  }
}
