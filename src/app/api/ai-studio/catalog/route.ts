import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { AI_IMAGE_MODELS } from "@/lib/ai-image-policy";
import { ensureMonthlyGrant, getBalance } from "@/lib/credits";
import { durationCapSecFor } from "@/lib/plan-limits";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";
import { describeImageOffer } from "@/lib/image-generation-provider.server";
import { apiError } from "@/lib/api-error";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const user = await getCurrentUser();
    const access = heroVoiceCloneCanaryAccessDecision(user);
    if (!access.allowed) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized" : "Not found" },
        { status: access.status, headers: PRIVATE_NO_STORE },
      );
    }
    if (!user) throw new Error("clone canary access decision admitted a missing actor");
    await ensureMonthlyGrant(user.id);
    const balance = await getBalance(user.id);
    return NextResponse.json({
      imageModels: AI_IMAGE_MODELS.map((model) => {
        const offer = describeImageOffer(model);
        return {
          id: model.id,
          label: model.label,
          description: model.description,
          credits: offer.quote.credits,
          available: offer.available,
          engine: model.engine,
          provider: offer.provider,
          providerModel: offer.providerModel,
          providerRoute: offer.providerRoute,
          unavailableCode: offer.unavailableCode ?? null,
        };
      }),
      voice: {
        // AI Studio exposes only the account-owned clone canary. Stock Hero
        // Voice remains on its existing non-Studio surfaces.
        cloning: true,
        maxDurationSec: durationCapSecFor(user.plan),
        maxScriptChars: omnivoiceScriptCharCapForPlan(user.plan),
      },
      plan: user.plan,
      balance,
    }, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return apiError({ route: "ai-studio/catalog", error });
  }
}
