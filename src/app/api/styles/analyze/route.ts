import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import * as cheerio from "cheerio";
import axios from "axios";
import { apiError } from "@/lib/api-error";
import { geminiGenerateText } from "@/lib/gemini";

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let { sourceText, sourceUrl } = await req.json();

    if (!sourceText && !sourceUrl) {
      return NextResponse.json({ error: "Either source text or URL is required" }, { status: 400 });
    }

    if (sourceUrl && !sourceText) {
      try {
        sourceText = await extractContentFromUrl(sourceUrl);
        if (!sourceText || sourceText.trim().length < 50) {
          return NextResponse.json({ error: "Could not extract sufficient content from URL" }, { status: 400 });
        }
      } catch (error: any) {
        return NextResponse.json({ error: "Failed to extract content from URL", details: error.message }, { status: 400 });
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (!user.geminiKey) return NextResponse.json({ error: "กรุณาเพิ่ม Gemini API key ใน Settings", missingKey: "gemini" }, { status: 400 });
    const apiKey = Buffer.from(user.geminiKey, "base64").toString("utf-8");

    try {
      const prompt = buildStyleAnalysisPrompt(sourceText.substring(0, 6000));
      const instructionPrompt = await geminiGenerateText(apiKey, prompt, 1500);
      if (!instructionPrompt) throw new Error("No response from Gemini");
      return NextResponse.json({ instructionPrompt: instructionPrompt.trim() }, { status: 200 });
    } catch (err: any) {
      if (err?.status === 401 || err?.message?.includes("401")) {
        return NextResponse.json({ error: "Invalid Gemini API key. Please check your settings." }, { status: 401 });
      }
      if (err?.status === 429 || err?.message?.includes("429")) {
        return NextResponse.json({ error: "Gemini rate limit reached. Please try again later." }, { status: 429 });
      }
      return NextResponse.json({ error: "Failed to analyze style with AI. Please try again." }, { status: 500 });
    }
  } catch (error) {
    return apiError({ route: "styles/analyze", error });
  }
}

function buildStyleAnalysisPrompt(sampleText: string): string {
  const isThai = /[฀-๿]/.test(sampleText);
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

async function extractContentFromUrl(url: string): Promise<string> {
  try {
    new URL(url);
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 10000,
      maxContentLength: 5 * 1024 * 1024,
    });
    const $ = cheerio.load(response.data);
    $("script, style, nav, header, footer, iframe, noscript, aside").remove();
    let content = "";
    const selectors = ["article", "main", '[role="main"]', ".content", ".post-content", ".article-content", "#content", ".entry-content", ".post-body", ".article-body"];
    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0 && el.text().trim().length > 100) { content = el.text(); break; }
    }
    if (!content || content.trim().length < 100) content = $("body").text();
    content = content.replace(/\s+/g, " ").replace(/\n+/g, "\n").trim();
    if (content.length > 10000) content = content.substring(0, 10000) + "...";
    return content;
  } catch (error: any) {
    if (error.code === "ENOTFOUND") throw new Error("URL not found or unreachable");
    if (error.code === "ETIMEDOUT") throw new Error("URL request timed out");
    throw new Error(`Failed to extract content: ${error.message}`);
  }
}
