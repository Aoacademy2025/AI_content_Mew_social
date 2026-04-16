import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { script } = await req.json();
    if (!script?.trim()) {
      return NextResponse.json({ error: "Script is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { openaiKey: true },
    });

    if (!user?.openaiKey) {
      return NextResponse.json({ error: "OpenAI API key not set", missingKey: "openai" }, { status: 400 });
    }

    const apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8");

    const systemPrompt = `You are a Midjourney prompt expert. Generate a single, highly detailed Midjourney image prompt based on the given video script.

Rules:
- Output ONLY the prompt string, nothing else
- Write in English
- Include: main subject, artistic style, lighting, mood, color palette, composition
- Add Midjourney quality keywords: ultra-detailed, cinematic, 8k, professional photography or artistic style
- The image should visually represent the overall theme/feel of the script
- Do NOT include --ar or --v flags (added automatically)
- Keep it under 200 words`;

    const userMsg = `Generate a Midjourney image prompt for this video script:\n\n${script.slice(0, 1000)}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return apiError({ route: "videos/generate-mj-prompt", error: new Error(err) });
    }

    const data = await res.json();
    const prompt = data.choices?.[0]?.message?.content?.trim() ?? "";

    return NextResponse.json({ prompt });
  } catch (error) {
    return apiError({ route: "videos/generate-mj-prompt", error });
  }
}
