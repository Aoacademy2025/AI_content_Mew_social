import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { AI_IMAGE_MODELS } from "@/lib/ai-image-policy";
import { ensureMonthlyGrant, getBalance } from "@/lib/credits";
import { durationCapSecFor } from "@/lib/plan-limits";
import { omnivoiceScriptCharCapForPlan } from "@/lib/omnivoice-limits";
import { isOmniVoiceUserAllowed } from "@/lib/omnivoice-policy";
import { omnivoiceBackendName } from "@/lib/omnivoice";
import { isJaiTtsEnabled } from "@/lib/jaitts";
import { describeImageOffer } from "@/lib/image-generation-provider.server";
import { apiError } from "@/lib/api-error";
import { isInternalAiTester } from "@/lib/internal-ai-access";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
        available: isOmniVoiceUserAllowed(user),
        // hostinger/local backend has no durable queue — the studio client
        // must call the synchronous tts-omnivoice route instead.
        backend: omnivoiceBackendName(),
        // Hero Cloning (JaiTTS) — experimental second clone engine, admin-only.
        cloning: user.role === "ADMIN" && isJaiTtsEnabled(),
        maxDurationSec: durationCapSecFor(user.plan),
        maxScriptChars: omnivoiceScriptCharCapForPlan(user.plan),
      },
      plan: user.plan,
      balance,
    });
  } catch (error) {
    return apiError({ route: "ai-studio/catalog", error });
  }
}
