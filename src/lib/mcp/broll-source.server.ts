import "server-only";

import type { User } from "@prisma/client";
import { AI_IMAGE_MODELS } from "@/lib/ai-image-policy";
import { describeImageOffer } from "@/lib/image-generation-provider.server";
import { isHeroRunpodRoute, usesCustomRunpodEndpoint } from "@/lib/hero-image-route-policy";
import { resolveHeroAiImageAccess } from "@/lib/internal-ai-access";
import { getRunpodImageCostSnapshot } from "@/lib/runpod-image-cost.server";
import { mcpBrollUsesHeroImages, mcpHeroVisualRefusal, type McpBrollSource } from "@/lib/mcp/broll-source";

/** Same Hero rollout and cost guard the web create path runs, before an MCP job is queued. */
export async function mcpBrollCreateRefusal(user: User, source: McpBrollSource) {
  if (!mcpBrollUsesHeroImages(source)) return null;
  const access = await resolveHeroAiImageAccess(user);
  const denied = mcpHeroVisualRefusal(access, source);
  if (denied) return denied;

  const model = AI_IMAGE_MODELS.find((item) => item.id === "z-image-turbo");
  if (!model) {
    return { error: "hero_image_unavailable", message: "Hero AI Image ยังไม่พร้อมใช้งานในขณะนี้" };
  }
  const offer = describeImageOffer(model);
  if (!offer.available || !isHeroRunpodRoute(offer.providerRoute)) {
    return { error: "hero_image_unavailable", message: "Hero AI Image ยังไม่พร้อมใช้งานในขณะนี้" };
  }
  if (usesCustomRunpodEndpoint(offer.providerRoute)) {
    const runpodCost = await getRunpodImageCostSnapshot({ endpointId: offer.providerEndpoint });
    if (!runpodCost.admitted) {
      return {
        error: "hero_image_cost_guard",
        message: runpodCost.status === "stale"
          ? "ระบบตรวจสอบต้นทุน Hero AI Image ขาดข้อมูลล่าสุด จึงยังไม่รับงานใหม่"
          : "ต้นทุน Hero AI Image สูงกว่าเพดาน ฿1.08/รูป จึงยังไม่รับงานใหม่",
        retryable: true,
      };
    }
  }
  return null;
}
