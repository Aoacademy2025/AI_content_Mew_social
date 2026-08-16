import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { buildContentGenerationPrompt } from "@/lib/prompts/content-generator";
import {
  generateContentWithRelevanceRetry,
  normalizeContentInputMode,
} from "@/lib/content-generation-quality";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";
import axios from "axios";
import * as cheerio from "cheerio";
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

function extractReadableContent(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  if (!/<[a-z][\s\S]*>/i.test(raw)) return raw.replace(/\s+/g, " ").trim();
  const $ = cheerio.load(raw);
  $("script, style, nav, header, footer, iframe, noscript, aside").remove();
  const selectors = [
    "article", "main", '[role="main"]', ".content", ".post-content",
    ".article-content", "#content", ".entry-content", ".post-body", ".article-body",
  ];
  let content = "";
  for (const selector of selectors) {
    const candidate = $(selector).first().text().replace(/\s+/g, " ").trim();
    if (candidate.length >= 100) {
      content = candidate;
      break;
    }
  }
  return (content || $("body").text()).replace(/\s+/g, " ").trim();
}

class ContentRetryQuotaError extends Error {
  readonly code = "QUOTA_AI_TEXT";
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { sourceText, sourceUrl, styleId, language, imageModel, videoDuration, inputMode: requestedInputMode } = await req.json();

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
        const urlResponse = await safeAxiosGet(sourceUrl, {
          timeout: 10000,
          maxContentLength: 5 * 1024 * 1024,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; HERO-AI-Content/1.0)" },
        });
        textContent = extractReadableContent(urlResponse.data);
      } catch {
        return NextResponse.json({ error: "Failed to fetch content from URL" }, { status: 400 });
      }
    }

    if (!textContent || textContent.trim().length < 10) {
      return NextResponse.json({ error: "Content is too short to generate from" }, { status: 400 });
    }

    const inputMode = normalizeContentInputMode(
      requestedInputMode,
      textContent,
      Boolean(sourceUrl && !sourceText),
    );

    const prompt = buildContentGenerationPrompt({
      instructionPrompt: style?.instructionPrompt,
      language: language || "TH",
      imageModel: imageModel || "nanobanana",
      videoDuration: videoDuration || 60,
      selectedStyle: style?.name || "Not specified",
      inputText: textContent.substring(0, 4000),
      inputMode,
    });

    const systemPrompt = "You are an expert content creator. Return only valid JSON without markdown formatting.\n\n" + prompt;

    try {
      const generation = await generateContentWithRelevanceRetry({
        basePrompt: systemPrompt,
        inputText: textContent.substring(0, 4000),
        inputMode,
        generate: async (requestPrompt, attempt) => {
          if (attempt > 1) {
            const retryReserve = await reserveAiTextCall(authUser.id, { enforce: geminiMode === "managed" });
            if (!retryReserve.allowed) {
              throw new ContentRetryQuotaError(retryReserve.message ?? "ใช้ AI ช่วยประมวลผลข้อความครบเพดานรอบนี้แล้ว");
            }
          }
          const response = await geminiGenerateText(apiKey, requestPrompt, 2000);
          if (!response) throw new Error("No response from Gemini");
          return response;
        },
      });
      if (!generation.ok) {
        return NextResponse.json({
          code: generation.reason === "content_off_topic" ? "CONTENT_OFF_TOPIC" : "INVALID_AI_OUTPUT",
          error: generation.reason === "content_off_topic"
            ? "เนื้อหาที่ AI สร้างยังไม่ตรงหัวข้อ กรุณาระบุหัวข้อให้ชัดขึ้นหรือลองใหม่"
            : "AI ส่งผลลัพธ์มาไม่ครบ กรุณาลองใหม่อีกครั้ง",
          retryable: true,
        }, { status: 422 });
      }
      const generatedContent = generation.content;

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
        inputMode,
        qualityRetried: generation.attempts > 1,
      }, { status: 200 });
    } catch (err: any) {
      if (err instanceof ContentRetryQuotaError) {
        return NextResponse.json({ code: err.code, message: err.message }, { status: 429 });
      }
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
