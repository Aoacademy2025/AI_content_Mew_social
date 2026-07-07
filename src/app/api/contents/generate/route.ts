import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { buildContentGenerationPrompt } from "@/lib/prompts/content-generator";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";
import axios from "axios";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";

// SSRF-safe axios GET of a user-supplied URL: validate the host, then follow redirects
// MANUALLY re-validating each hop (axios auto-follow is disabled), so a safe initial URL
// can't 3xx into a private/internal target. Bounded to maxHops.
async function safeAxiosGet(url: string, config: Parameters<typeof axios.get>[1] = {}, maxHops = 3) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertSafeFetchUrl(current);
    const res = await axios.get(current, { ...config, maxRedirects: 0, validateStatus: (s: number) => s < 400 });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.location as string | undefined;
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { sourceText, sourceUrl, styleId, language, imageModel, videoDuration } = await req.json();

    if (!sourceText && !sourceUrl) {
      return NextResponse.json({ error: "Either source text or URL is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, plan: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    let apiKey: string;
    let geminiMode: "managed" | "byok";
    try {
      const resolved = resolveGeminiKey(user);
      apiKey = resolved.key;
      geminiMode = resolved.mode;
    } catch (e) {
      if (e instanceof KeyRequiredError) {
        return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
      }
      throw e;
    }

    // H1: bound managed-key text-LLM call frequency (BYOK → no-op, byte-identical).
    const textReserve = await reserveAiTextCall(authUser.id, { enforce: geminiMode === "managed" });
    if (!textReserve.allowed) {
      return NextResponse.json({ code: "QUOTA_AI_TEXT", message: textReserve.message }, { status: 429 });
    }

    let style = null;
    if (styleId) {
      style = await prisma.style.findFirst({ where: { id: styleId, userId: authUser.id } });
    }

    let textContent = sourceText;
    if (sourceUrl && !sourceText) {
      try {
        // SSRF guard (host + per-redirect-hop re-validation) lives in safeAxiosGet.
        const urlResponse = await safeAxiosGet(sourceUrl, { timeout: 10000 });
        textContent = urlResponse.data;
      } catch {
        return NextResponse.json({ error: "Failed to fetch content from URL" }, { status: 400 });
      }
    }

    if (!textContent || textContent.trim().length < 10) {
      return NextResponse.json({ error: "Content is too short to generate from" }, { status: 400 });
    }

    const prompt = buildContentGenerationPrompt({
      instructionPrompt: style?.instructionPrompt,
      language: language || "TH",
      imageModel: imageModel || "nanobanana",
      videoDuration: videoDuration || 60,
      selectedStyle: style?.name || "Not specified",
      inputText: textContent.substring(0, 4000),
    });

    const systemPrompt = "You are an expert content creator. Return only valid JSON without markdown formatting.\n\n" + prompt;

    try {
      const aiResponse = await geminiGenerateText(apiKey, systemPrompt, 2000);
      if (!aiResponse) throw new Error("No response from Gemini");

      let generatedContent;
      try {
        const cleanResponse = aiResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        generatedContent = JSON.parse(cleanResponse);
      } catch (parseError) {
        return apiError({ route: "contents/generate", error: parseError });
      }

      return NextResponse.json({
        headline: generatedContent.headline,
        subheadline: generatedContent.subHeadline,
        body: generatedContent.content,
        hashtags: generatedContent.hashtags,
        imagePrompt: generatedContent.imagePrompt,
        visualNotes: generatedContent.visualNotes,
        sourceText,
        sourceUrl,
        styleId,
        language: language || "TH",
        imageModel: imageModel || "nanobanana",
        videoDuration,
      }, { status: 200 });
    } catch (err: any) {
      if (err?.status === 401 || err?.message?.includes("401")) {
        return NextResponse.json({ error: "API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings" }, { status: 401 });
      }
      if (err?.status === 429 || err?.message?.includes("429")) {
        return NextResponse.json({ error: "ระบบ AI ถูกใช้งานหนักเกินไป กรุณาลองใหม่ในอีกสักครู่" }, { status: 429 });
      }
      return apiError({ route: "POST /api/contents/generate", error: err });
    }
  } catch (error) {
    return apiError({ route: "POST /api/contents/generate", error });
  }
}
