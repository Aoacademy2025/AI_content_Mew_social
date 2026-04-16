import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export const maxDuration = 300; // allow up to 5 min (MJ is slower)

interface ModelConfig {
  endpoint: string;
  buildBody: (prompt: string) => object;
  pollEndpoint?: (taskId: string) => string;
  parseResult?: (data: any) => string | null;
  parseTaskId?: (data: any) => string | null;
}

const MODEL_CONFIG: Record<string, ModelConfig> = {
  nanobanana: {
    endpoint: "https://api.kie.ai/api/v1/jobs/createTask",
    buildBody: (prompt) => ({
      model: "google/nano-banana",
      input: { prompt, guidance_scale: 2.5, enable_safety_checker: true, image_size: "9:16" },
    }),
  },
  seedream: {
    endpoint: "https://api.kie.ai/api/v1/jobs/createTask",
    buildBody: (prompt) => ({
      model: "bytedance/seedream-3",
      input: { prompt, guidance_scale: 2.5, enable_safety_checker: true, image_size: "9:16" },
    }),
  },
  imagen: {
    endpoint: "https://api.kie.ai/api/v1/jobs/createTask",
    buildBody: (prompt) => ({
      model: "google/imagen-4",
      input: { prompt, guidance_scale: 2.5, enable_safety_checker: true, image_size: "9:16" },
    }),
  },
  grok: {
    endpoint: "https://api.kie.ai/api/v1/jobs/createTask",
    buildBody: (prompt) => ({
      model: "xai/grok-2-aurora",
      input: { prompt, guidance_scale: 2.5, enable_safety_checker: true, image_size: "9:16" },
    }),
  },
  flux: {
    endpoint: "https://api.kie.ai/api/v1/jobs/createTask",
    buildBody: (prompt) => ({
      model: "flux-2/flex-text-to-image",
      input: { prompt, aspect_ratio: "9:16", resolution: "1K" },
    }),
  },
  "grok-imagine": {
    endpoint: "https://api.kie.ai/api/v1/jobs/createTask",
    buildBody: (prompt) => ({
      model: "grok-imagine/text-to-image",
      input: { prompt, aspect_ratio: "9:16" },
    }),
  },
  midjourney: {
    endpoint: "https://api.kie.ai/api/v1/mj/generate",
    buildBody: (prompt) => ({
      taskType: "mj_txt2img",
      speed: "relaxed",
      prompt,
      aspectRatio: "9:16",
      version: "7",
    }),
    parseTaskId: (data) =>
      data?.data?.taskId ?? data?.taskId ?? null,
    pollEndpoint: (taskId) =>
      `https://api.kie.ai/api/v1/mj/queryTask?taskId=${taskId}`,
    parseResult: (data) => {
      const item = data?.data;
      if (!item) return null;
      // MJ returns imageUrls array (4 images per run) — pick first
      if (Array.isArray(item.imageUrls) && item.imageUrls[0]) return item.imageUrls[0];
      if (typeof item.imageUrl === "string" && item.imageUrl.startsWith("http")) return item.imageUrl;
      return null;
    },
  },
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createTask(
  prompt: string,
  model: string,
  apiKey: string
): Promise<string | null> {
  const config = MODEL_CONFIG[model] ?? MODEL_CONFIG["nanobanana"];

  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config.buildBody(prompt)),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[createTask] ${model} failed ${res.status}:`, errText);
    return null;
  }
  const data = await res.json();
  // Use model-specific taskId parser if provided, otherwise default
  if (config.parseTaskId) return config.parseTaskId(data);
  return data?.data?.taskId ?? null;
}

// Returns all image URLs from a single MJ task (up to 4)
async function pollMidjourneyAll(taskId: string, apiKey: string): Promise<string[]> {
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const res = await fetch(
      `https://api.kie.ai/api/v1/mj/queryTask?taskId=${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) continue;
    const data = await res.json();
    const item = data?.data;
    if (!item) continue;
    const status = (item.status ?? item.state ?? "").toLowerCase();
    if (status === "finished" || status === "success") {
      if (Array.isArray(item.imageUrls) && item.imageUrls.length > 0) return item.imageUrls;
      if (typeof item.imageUrl === "string" && item.imageUrl.startsWith("http")) return [item.imageUrl];
      return [];
    }
    if (status === "failed" || status === "error") return [];
  }
  return [];
}

async function pollTask(taskId: string, apiKey: string, model: string): Promise<string | null> {
  const config = MODEL_CONFIG[model] ?? MODEL_CONFIG["nanobanana"];
  // Poll every 5s up to 36 times (3 minutes total for slower MJ)
  const maxAttempts = model === "midjourney" ? 36 : 24;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);

    // Use model-specific poll endpoint if provided
    const pollUrl = config.pollEndpoint
      ? config.pollEndpoint(taskId)
      : `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`;

    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) continue;
    const data = await res.json();

    // Midjourney: use custom result parser
    if (config.parseResult) {
      const status = data?.data?.status ?? data?.data?.state ?? "";
      if (status === "finished" || status === "success" || status === "FINISHED" || status === "SUCCESS") {
        return config.parseResult(data);
      }
      if (status === "failed" || status === "FAILED" || status === "error") return null;
      continue;
    }

    // Default: standard Kie.ai jobs polling
    const state = data?.data?.state;
    if (state === "success") {
      const result = JSON.parse(data.data.resultJson || "{}");
      return result?.resultUrls?.[0] ?? null;
    }
    if (state === "failed") return null;
  }

  return null; // timeout
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { prompts, model } = await req.json();

    if (!Array.isArray(prompts) || prompts.length === 0) {
      return NextResponse.json({ error: "Prompts array is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { openaiKey: true },
    });

    if (!user?.openaiKey) {
      return NextResponse.json({ error: "Please add your OpenAI API key in Settings", missingKey: "openai" }, { status: 400 });
    }

    const apiKey = Buffer.from(user.openaiKey, "base64").toString("utf-8");

    const selectedModel = model ?? "nanobanana";

    if (selectedModel === "midjourney") {
      // MJ: 1 call → 4 images. Use the first prompt only.
      const sceneList = prompts as { scene: number; prompt: string }[];
      const firstPrompt = sceneList[0]?.prompt ?? "";
      const taskId = await createTask(firstPrompt, "midjourney", apiKey);
      if (!taskId) {
        const images = sceneList.map(({ scene }) => ({ scene, url: null, error: "Task creation failed" }));
        return NextResponse.json({ images });
      }
      const allUrls = await pollMidjourneyAll(taskId, apiKey);
      const images = sceneList.map(({ scene }, i) => ({
        scene,
        url: allUrls[i] ?? null,
        error: allUrls[i] ? null : "No image returned for this scene",
      }));
      return NextResponse.json({ images });
    }

    // Non-MJ: create tasks sequentially (avoid rate limiting), then poll in parallel
    const taskIds: { scene: number; taskId: string | null }[] = [];
    for (const item of prompts as { scene: number; prompt: string }[]) {
      const taskId = await createTask(item.prompt, selectedModel, apiKey);
      taskIds.push({ scene: item.scene, taskId });
      if (taskId && taskIds.length < (prompts as []).length) await sleep(600);
    }

    const images = await Promise.all(
      taskIds.map(async ({ scene, taskId }) => {
        if (!taskId) return { scene, url: null, error: "Task creation failed" };
        const url = await pollTask(taskId, apiKey, selectedModel);
        return { scene, url, error: url ? null : "Timeout or generation failed" };
      })
    );

    return NextResponse.json({ images });
  } catch (error) {
    return apiError({ route: "videos/generate-images", error });
  }
}
