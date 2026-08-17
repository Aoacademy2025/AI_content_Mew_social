import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-error";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { VISUAL_FORMAT_IDS } from "@/lib/brand-visual-system";
import { geminiGenerateText } from "@/lib/gemini";
import { KeyRequiredError, resolveGeminiKey } from "@/lib/gemini-key";
import { recordTelemetryEvent } from "@/lib/telemetry";

const suggestionSchema = z.object({
  primaryVisualFormatId: z.enum(VISUAL_FORMAT_IDS),
  palette: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
  personality: z.string().trim().min(1).max(500),
  peopleAndSetting: z.string().trim().max(500),
  memorableCues: z.array(z.string().trim().min(1).max(160)).max(6),
  visualNotes: z.string().trim().max(800),
  rationale: z.string().trim().min(1).max(600),
});

export async function POST(req: Request) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const niche = typeof body?.niche === "string" ? body.niche.trim().slice(0, 300) : "";
    const audience = typeof body?.audience === "string" ? body.audience.trim().slice(0, 500) : "";
    const sample = typeof body?.sample === "string" ? body.sample.trim().slice(0, 4_000) : "";
    if (!niche || !audience) {
      return NextResponse.json({ error: "กรุณาระบุนิชและกลุ่มเป้าหมาย" }, { status: 400 });
    }
    let key: string;
    let mode: "managed" | "byok";
    try {
      ({ key, mode } = resolveGeminiKey(auth.user));
    } catch (error) {
      if (error instanceof KeyRequiredError) {
        return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
      }
      throw error;
    }
    const quota = await reserveAiTextCall(auth.user.id, { enforce: mode === "managed" });
    if (!quota.allowed) {
      return NextResponse.json({ code: "QUOTA_AI_TEXT", message: quota.message }, { status: 429 });
    }
    const raw = await geminiGenerateText(key, [
      "Propose one Brand Visual Language for a Thai short-video creator.",
      "Return JSON only. This is a proposal: never claim it has been applied and never include an image prompt.",
      `primaryVisualFormatId must be one of ${VISUAL_FORMAT_IDS.join(", ")}.`,
      "Schema: {primaryVisualFormatId,palette:string[1..6],personality,peopleAndSetting,memorableCues:string[0..6],visualNotes,rationale}",
      `Niche: ${niche}`,
      `Audience: ${audience}`,
      sample ? `Creator sample: ${sample}` : "",
    ].filter(Boolean).join("\n"), 2_500, 0.4);
    let proposal: z.infer<typeof suggestionSchema>;
    try {
      proposal = suggestionSchema.parse(JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim()));
    } catch {
      return NextResponse.json({ code: "INVALID_AI_PROPOSAL", error: "AI ส่งคำแนะนำไม่ครบ กรุณาลองใหม่" }, { status: 502 });
    }
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_visual_helper_proposed",
      source: "server",
      status: "proposal_only",
      properties: { visualFormatId: proposal.primaryVisualFormatId, cohort: auth.access.cohort },
    }).catch(() => {});
    return NextResponse.json({ proposal, applied: false, imageAllowanceUsed: 0, creditsUsed: 0 });
  } catch (error) {
    return apiError({ route: "POST /api/brand-library/suggest-visual", error });
  }
}
