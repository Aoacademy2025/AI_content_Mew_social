import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import * as cheerio from "cheerio";
import axios from "axios";

// POST /api/extract - Extract text content from URL
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { url } = await req.json();

    if (!url) {
      return NextResponse.json(
        { error: "URL is required" },
        { status: 400 }
      );
    }

    // Validate URL format
    let validUrl: URL;
    try {
      validUrl = new URL(url);
    } catch {
      return NextResponse.json(
        { error: "Invalid URL format" },
        { status: 400 }
      );
    }

    // Detect URL type and extract content
    let extractedText = "";
    let contentType = "web";

    // Check if YouTube URL
    if (
      validUrl.hostname.includes("youtube.com") ||
      validUrl.hostname.includes("youtu.be")
    ) {
      contentType = "youtube";
      extractedText = await extractYouTubeTranscript(url);
    }
    // Check if PDF URL
    else if (url.toLowerCase().endsWith(".pdf")) {
      contentType = "pdf";
      extractedText = await extractPDFContent(url);
    }
    // Default to web scraping
    else {
      contentType = "web";
      extractedText = await extractWebContent(url);
    }

    if (!extractedText || extractedText.trim().length < 50) {
      return NextResponse.json(
        {
          error: "Could not extract sufficient content from URL",
          contentType,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      text: extractedText,
      contentType,
      url: url,
    });
  } catch (error: any) {
    return apiError({ route: "POST /api/extract", error, userMessage: "ไม่สามารถดึงเนื้อหาจาก URL ได้ กรุณาลองใหม่หรือวางข้อความเอง" });
  }
}

// Extract content from web pages using Cheerio
async function extractWebContent(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);

    // Remove unwanted elements
    $("script, style, nav, header, footer, iframe, noscript").remove();

    // Try to find main content
    let content = "";

    // Try common content containers
    const contentSelectors = [
      "article",
      "main",
      '[role="main"]',
      ".content",
      ".post-content",
      ".article-content",
      "#content",
      ".entry-content",
    ];

    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        content = element.text();
        break;
      }
    }

    // Fallback to body if no content found
    if (!content) {
      content = $("body").text();
    }

    // Clean up the text
    content = content
      .replace(/\s+/g, " ") // Replace multiple spaces with single space
      .replace(/\n+/g, "\n") // Replace multiple newlines with single newline
      .trim();

    return content;
  } catch (error: any) {
    throw new Error(`Failed to scrape web content: ${error.message}`);
  }
}

// Extract YouTube transcript
async function extractYouTubeTranscript(url: string): Promise<string> {
  try {
    // Extract video ID from URL
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL");
    }

    // Note: youtube-transcript library doesn't work in Edge Runtime
    // For now, return a placeholder message
    // In production, you should use a server-side solution or API
    throw new Error(
      "YouTube transcript extraction requires additional setup. Please use the video description or manual transcript."
    );

    // TODO: Implement youtube-transcript in a Node.js API route
    // const { YoutubeTranscript } = require('youtube-transcript');
    // const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    // return transcript.map(t => t.text).join(' ');
  } catch (error: any) {
    throw new Error(`YouTube extraction failed: ${error.message}`);
  }
}

// Extract video ID from YouTube URL
function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

// Extract content from PDF
async function extractPDFContent(url: string): Promise<string> {
  try {
    // Fetch PDF file
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });

    // Note: pdf-parse doesn't work well in Edge Runtime
    // For now, return a placeholder message
    throw new Error(
      "PDF extraction requires additional setup. Please copy and paste the PDF content manually."
    );

    // TODO: Implement pdf-parse in a Node.js API route
    // const pdfParse = require('pdf-parse');
    // const data = await pdfParse(response.data);
    // return data.text;
  } catch (error: any) {
    throw new Error(`PDF extraction failed: ${error.message}`);
  }
}
