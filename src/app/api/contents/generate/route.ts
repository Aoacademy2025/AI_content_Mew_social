import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildContentGenerationPrompt } from "@/lib/prompts/content-generator";
import { apiError } from "@/lib/api-error";
import axios from "axios";

// POST /api/contents/generate - Generate AI content
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sourceText, sourceUrl, styleId, language, imageModel, videoDuration } =
      await req.json();

    if (!sourceText && !sourceUrl) {
      return NextResponse.json(
        { error: "Either source text or URL is required" },
        { status: 400 }
      );
    }

    // Get user to check plan
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true, openaiKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Determine which API key to use
    let openaiApiKey: string | null = null;

    if (user.plan === "FREE") {
      // Free users use server API key
      openaiApiKey = process.env.SERVER_OPENAI_API_KEY || null;
      if (!openaiApiKey) {
        return NextResponse.json(
          { error: "Server API key not configured" },
          { status: 500 }
        );
      }
    } else if (user.plan === "PRO") {
      // Pro users use their own API key
      if (!user.openaiKey) {
        return NextResponse.json({ error: "Please add your OpenAI API key in Settings to use this feature", missingKey: "openai" }, { status: 400 });
      }
      // Decrypt user's API key
      openaiApiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8");
    }

    // Get style if provided
    let style = null;
    if (styleId) {
      style = await prisma.style.findFirst({
        where: {
          id: styleId,
          userId: session.user.id,
        },
      });
    }

    // Get text content from URL if provided
    let textContent = sourceText;
    if (sourceUrl && !sourceText) {
      try {
        const urlResponse = await axios.get(sourceUrl, { timeout: 10000 });
        // Simple text extraction (you may want to use cheerio for better parsing)
        textContent = urlResponse.data;
      } catch (error) {
        return NextResponse.json(
          { error: "Failed to fetch content from URL" },
          { status: 400 }
        );
      }
    }

    if (!textContent || textContent.trim().length < 10) {
      return NextResponse.json(
        { error: "Content is too short to generate from" },
        { status: 400 }
      );
    }

    // Build enhanced prompt
    const prompt = buildContentGenerationPrompt({
      instructionPrompt: style?.instructionPrompt,
      language: language || "TH",
      imageModel: imageModel || "nanobanana",
      videoDuration: videoDuration || 60,
      selectedStyle: style?.name || "Not specified",
      inputText: textContent.substring(0, 4000), // Limit input size
    });

    // Call OpenAI API
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are an expert content creator. Return only valid JSON without markdown formatting.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.7,
          max_tokens: 2000,
        },
        {
          headers: {
            "Authorization": `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      const aiResponse = response.data.choices[0]?.message?.content;
      if (!aiResponse) {
        throw new Error("No response from OpenAI");
      }

      // Parse JSON response
      let generatedContent;
      try {
        // Remove markdown code blocks if present
        const cleanResponse = aiResponse
          .replace(/```json\n?/g, "")
          .replace(/```\n?/g, "")
          .trim();
        generatedContent = JSON.parse(cleanResponse);
      } catch (parseError) {
        return apiError({ route: "contents/generate", error: parseError });
      }

      // Return generated content without saving (user can edit first)
      return NextResponse.json({
        headline: generatedContent.headline,
        subheadline: generatedContent.subHeadline,
        body: generatedContent.content,
        hashtags: generatedContent.hashtags,
        imagePrompt: generatedContent.imagePrompt,
        visualNotes: generatedContent.visualNotes,
        // Also return the input parameters
        sourceText,
        sourceUrl,
        styleId,
        language: language || "TH",
        imageModel: imageModel || "nanobanana",
        videoDuration,
      }, { status: 200 });
    } catch (openaiError: any) {
      const status = openaiError.response?.status;
      if (status === 401) {
        return NextResponse.json({ error: "API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings" }, { status: 401 });
      }
      if (status === 429) {
        return NextResponse.json({ error: "ระบบ AI ถูกใช้งานหนักเกินไป กรุณาลองใหม่ในอีกสักครู่" }, { status: 429 });
      }
      return apiError({ route: "POST /api/contents/generate (OpenAI)", error: openaiError, context: { status } });
    }
  } catch (error) {
    return apiError({ route: "POST /api/contents/generate", error });
  }
}
