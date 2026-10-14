import { PRESET_PROVIDERS, PRESET_WEIGHTS } from "@/app/(dashboard)/video-editor/_v2/mix-presets";
import {
  HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE,
  HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE,
  type HeroAiImageAccessDecision,
} from "@/lib/internal-ai-access";

/** Public MCP names. The worker still receives the editor's stockSource values. */
export const MCP_BROLL_SOURCES = ["stock", "hero-ai-image", "automix", "external"] as const;
export type McpBrollSource = (typeof MCP_BROLL_SOURCES)[number];

export function mcpBrollSource(value: unknown): McpBrollSource {
  return value === "external" || value === "hero-ai-image" || value === "automix" ? value : "stock";
}

export function mcpBrollUsesHeroImages(source: McpBrollSource): boolean {
  return source === "hero-ai-image" || source === "automix";
}

/** Fields stored on the video job. Stock stays absent so the worker keeps its default. */
export function mcpBrollJobFields(source: McpBrollSource): {
  stockSource?: "kie-image" | "auto-mix" | "none";
  imageEngine?: "runpod";
  imageModel?: "z-image-turbo";
  autoMixProviders?: string[];
  autoMixWeights?: { video: number; photo: number; ai: number };
} {
  if (source === "external") return { stockSource: "none" };
  if (source === "hero-ai-image") {
    return { stockSource: "kie-image", imageEngine: "runpod", imageModel: "z-image-turbo" };
  }
  if (source === "automix") {
    return {
      stockSource: "auto-mix",
      autoMixProviders: [...(PRESET_PROVIDERS.recommended ?? [])],
      autoMixWeights: PRESET_WEIGHTS.recommended,
    };
  }
  return {};
}

/**
 * Pure decision behind the create_video_job stock-key gate (#defect 3, 2026-10-12
 * settings UX fix). Extracted so it is unit-testable without the MCP route's auth,
 * DB and preflight plumbing: a request only gets refused when it actually needs a
 * stock provider, has no key of its own, AND managed stock would not serve it
 * either (flag off, no managed key, suspended, or already BYOK-served elsewhere).
 */
export function mcpStockKeyRefusal(input: {
  needsStockKey: boolean;
  hasOwnStockKey: boolean;
  managedStockEligible: boolean;
}): boolean {
  return input.needsStockKey && !input.hasOwnStockKey && !input.managedStockEligible;
}

export function mcpHeroVisualRefusal(
  access: Pick<HeroAiImageAccessDecision, "canUse" | "reason">,
  source: McpBrollSource,
): { error: string; message: string; upgradeUrl?: string; remainingImages?: number } | null {
  if (!mcpBrollUsesHeroImages(source) || access.canUse) return null;
  if (access.reason === "allowance_exhausted") return HERO_AI_IMAGE_ALLOWANCE_EXHAUSTED_RESPONSE.body;
  if (process.env.HERO_AI_IMAGE_PUBLIC === "1") return HERO_AI_IMAGE_PLAN_REQUIRED_RESPONSE.body;
  return {
    error: "beta_only",
    message: source === "automix"
      ? "ภาพ AI / AutoMix ยังเปิดเฉพาะทีมงาน (Beta)"
      : "Hero AI Image ยังเปิดเฉพาะทีมงาน (Beta)",
  };
}
