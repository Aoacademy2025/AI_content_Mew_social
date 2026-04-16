import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// POST /api/videos/generate-image-prompts
// Body: { scenes: [{ scene: number; title: string; mapping: string }], imageModel: string }
// Returns: { prompts: [{ scene: number; prompt: string }] }

function getModelStyle(imageModel: string): string {
  const styles: Record<string, string> = {
    nanobanana: "anime/illustration style, vibrant colors, 2D art, clean lines, expressive characters",
    seedream:   "photorealistic, cinematic, high detail, real photography, natural lighting",
    imagen:     "complex composition, studio quality, precise detail, balanced framing",
    grok:       "creative abstract, surreal, experimental, artistic interpretation",
    "grok-imagine": "imaginative, dreamlike, bold colors, unique perspective",
    flux:       "ultra high quality, sharp detail, professional photography or art",
    midjourney: "cinematic, artistic, dramatic lighting, highly detailed, masterpiece",
  };
  return styles[imageModel] ?? "high quality, professional, cinematic";
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { scenes, imageModel } = await req.json();
    if (!scenes?.length) {
      return NextResponse.json({ error: "scenes required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true, openaiKey: true },
    });

    let openaiApiKey: string | null = null;
    if (user?.plan === "FREE") {
      openaiApiKey = process.env.SERVER_OPENAI_API_KEY || null;
      if (!openaiApiKey) return NextResponse.json({ error: "Server API key not configured" }, { status: 500 });
    } else {
      if (!user?.openaiKey) return NextResponse.json({ error: "Please add your OpenAI API key in Settings", missingKey: "openai" }, { status: 400 });
      openaiApiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8");
    }

    const modelStyle = getModelStyle(imageModel ?? "flux");

    const systemPrompt = `You are a professional image prompt engineer specializing in AI image generation.
Your task: Create highly optimized image prompts for the "${imageModel}" model.
Style target: ${modelStyle}

Rules:
- Each prompt must be ONE line only, no line breaks
- Write in English only
- Include: subject/action, environment/setting, mood/lighting, color tone, camera angle, visual style
- Optimized specifically for ${imageModel} generator
- Short-form vertical video (9:16) aesthetic
- No explanations, no labels, output JSON only`;

    const userMessage = `Generate image prompts for these ${scenes.length} scenes.

${scenes.map((s: { scene: number; title: string; mapping: string }) =>
  `Scene ${s.scene}: "${s.title}" — context: "${s.mapping}"`
).join("\n")}

Return JSON:
{
  "prompts": [
    { "scene": 1, "prompt": "..." },
    ...
  ]
}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return NextResponse.json({ error: err.error?.message || "AI failed" }, { status: 500 });
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0]?.message?.content ?? "{}");

    return NextResponse.json({ prompts: result.prompts ?? [] });
  } catch (error) {
    return apiError({ route: "videos/generate-image-prompts", error });
  }
}
