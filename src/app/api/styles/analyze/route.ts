import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import * as cheerio from "cheerio";
import axios from "axios";
import { apiError } from "@/lib/api-error";

// POST /api/styles/analyze - Analyze writing style from text or URL
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let { sourceText, sourceUrl } = await req.json();

    if (!sourceText && !sourceUrl) {
      return NextResponse.json(
        { error: "Either source text or URL is required" },
        { status: 400 }
      );
    }

    // If URL is provided, extract content from it
    if (sourceUrl && !sourceText) {
      try {
        sourceText = await extractContentFromUrl(sourceUrl);
        if (!sourceText || sourceText.trim().length < 50) {
          return NextResponse.json(
            { error: "Could not extract sufficient content from URL" },
            { status: 400 }
          );
        }
      } catch (error: any) {
        return NextResponse.json(
          {
            error: "Failed to extract content from URL",
            details: error.message,
          },
          { status: 400 }
        );
      }
    }

    // Get user to check plan and API key
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
        return NextResponse.json({ error: "Please add your OpenAI API key in Settings", missingKey: "openai" }, { status: 400 });
      }
      // Decrypt user's API key
      openaiApiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8");
    }

    // Call OpenAI API to analyze writing style
    try {
      const prompt = buildStyleAnalysisPrompt(sourceText.substring(0, 6000));

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are an expert writing style analyst. Analyze the provided text and create detailed writing instructions that capture the unique style, tone, and structure.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.8, // Higher temperature for varied re-analysis
          max_tokens: 1500,
        },
        {
          headers: {
            "Authorization": `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      const instructionPrompt = response.data.choices[0]?.message?.content;

      if (!instructionPrompt) {
        throw new Error("No response from OpenAI");
      }

      return NextResponse.json({ instructionPrompt: instructionPrompt.trim() }, { status: 200 });
    } catch (openaiError: any) {
      console.error("OpenAI API error:", openaiError.response?.data || openaiError.message);

      // Return user-friendly error
      if (openaiError.response?.status === 401) {
        return NextResponse.json(
          { error: "Invalid OpenAI API key. Please check your settings." },
          { status: 401 }
        );
      } else if (openaiError.response?.status === 429) {
        return NextResponse.json(
          { error: "OpenAI rate limit reached. Please try again later." },
          { status: 429 }
        );
      }

      return NextResponse.json(
        { error: "Failed to analyze style with AI. Please try again." },
        { status: 500 }
      );
    }
  } catch (error) {
    return apiError({ route: "styles/analyze", error });
  }
}

// Build prompt for style analysis
function buildStyleAnalysisPrompt(sampleText: string): string {
  const isThai = /[\u0E00-\u0E7F]/.test(sampleText);

  return `Analyze the following text sample and create comprehensive writing style instructions that capture its unique characteristics.

====================
TEXT SAMPLE TO ANALYZE
====================
"""
${sampleText}
"""

====================
ANALYSIS TASK
====================

Carefully analyze the text above and create detailed writing instructions covering these aspects:

${isThai ? `
1. **ตัวตนและเป้าหมาย (Persona & Goal)**
   - กลุ่มเป้าหมาย (Target Audience)
   - วัตถุประสงค์ในการเขียน (Writing Purpose)
   - Brand Voice / บุคลิกของแบรนด์

2. **น้ำเสียงและสไตล์การเขียน (Tone & Style)**
   - น้ำเสียงโดยรวม (Overall Tone)
   - ระดับภาษา (Language Level: ง่าย/ปานกลาง/ซับซ้อน)
   - คุณภาพทางอารมณ์ (Emotional Quality)
   - วลีหรือรูปแบบการใช้ภาษาเด่นๆ

3. **โครงสร้างการเขียนที่เป็นเอกลักษณ์ (Unique Writing Structure)**
   - การเปิดเรื่อง (Hook): ใช้เทคนิคอะไร
   - การอธิบายเนื้อหา (Main Content): โครงสร้างอย่างไร
   - การจัดรูปแบบ (Formatting): emoji, line breaks, bold text, bullets
   - การสร้างความน่าเชื่อถือ (Credibility): ใช้หลักฐาน/ตัวเลข/ประสบการณ์จริง
   - การปิดท้าย (CTA & Engagement): แบบใด

ให้คำแนะนำที่ละเอียด ชัดเจน และครอบคลุม เพื่อให้ AI สามารถเขียนในสไตล์เดียวกันได้
` : `
1. **Persona & Goal**
   - Target Audience
   - Writing Purpose
   - Brand Voice

2. **Tone & Style**
   - Overall Tone
   - Language Level (Simple/Moderate/Complex)
   - Emotional Quality
   - Notable phrases or language patterns

3. **Unique Writing Structure**
   - Hook: What technique is used
   - Main Content: How is it structured
   - Formatting: emoji usage, line breaks, bold text, bullet points
   - Credibility: Use of evidence/numbers/real experiences
   - CTA & Engagement: What style

Provide detailed, clear, and comprehensive instructions so AI can write in the same style.
`}

====================
OUTPUT FORMAT
====================

Return the analysis as markdown-formatted writing instructions (NOT JSON). Use clear sections with headers and bullet points.

Focus on ACTIONABLE instructions that AI can follow to replicate this exact writing style.`;
}

// Extract content from URL using web scraping
async function extractContentFromUrl(url: string): Promise<string> {
  try {
    // Validate URL
    const validUrl = new URL(url);

    // Fetch the web page
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
      maxContentLength: 5 * 1024 * 1024, // 5MB limit
    });

    // Load HTML into Cheerio
    const $ = cheerio.load(response.data);

    // Remove unwanted elements
    $("script, style, nav, header, footer, iframe, noscript, aside").remove();

    // Try to find main content using common selectors
    let content = "";
    const contentSelectors = [
      "article",
      "main",
      '[role="main"]',
      ".content",
      ".post-content",
      ".article-content",
      "#content",
      ".entry-content",
      ".post-body",
      ".article-body",
    ];

    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0 && element.text().trim().length > 100) {
        content = element.text();
        break;
      }
    }

    // Fallback to body if no content found
    if (!content || content.trim().length < 100) {
      content = $("body").text();
    }

    // Clean up the text
    content = content
      .replace(/\s+/g, " ") // Replace multiple spaces with single space
      .replace(/\n+/g, "\n") // Replace multiple newlines with single
      .trim();

    // Limit content length (max 10,000 characters)
    if (content.length > 10000) {
      content = content.substring(0, 10000) + "...";
    }

    return content;
  } catch (error: any) {
    if (error.code === "ENOTFOUND") {
      throw new Error("URL not found or unreachable");
    } else if (error.code === "ETIMEDOUT") {
      throw new Error("URL request timed out");
    } else {
      throw new Error(`Failed to extract content: ${error.message}`);
    }
  }
}
