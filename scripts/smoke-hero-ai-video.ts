import dotenv from "dotenv";

dotenv.config({ path: ".env", override: false, quiet: true });

import { prisma } from "../src/lib/prisma";
import { createVideoJob } from "../src/lib/mcp/video-job";
import { getBalance } from "../src/lib/credits";
import { isHeroAiBetaUser } from "../src/lib/internal-ai-access";

const confirmed = process.argv.includes("--confirm-production");
if (!confirmed) throw new Error("Pass --confirm-production to enqueue the real billed smoke video");

const testerEmail = (process.env.HERO_AI_SMOKE_EMAIL ?? "duckyhero@gmail.com").trim().toLowerCase();
const timeoutMs = Math.max(5 * 60_000, Number(process.env.HERO_AI_SMOKE_TIMEOUT_MS) || 30 * 60_000);
const script = [
  "เช้าวันนี้ เจ้าของร้านกาแฟไทยเริ่มต้นวันด้วยการคัดเลือกเมล็ดกาแฟอย่างตั้งใจ",
  "เขาชงกาแฟทีละแก้วด้วยแสงธรรมชาติอ่อน ๆ เพื่อให้ลูกค้าได้รับทั้งรสชาติและความอบอุ่น",
].join(" ");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: testerEmail },
    select: { id: true, email: true, role: true, plan: true, geminiKey: true, suspended: true },
  });
  if (!user) throw new Error(`Smoke user not found: ${testerEmail}`);
  if (user.suspended) throw new Error("Smoke user is suspended");
  if (!isHeroAiBetaUser(user)) throw new Error("Smoke user is outside the Hero AI beta policy");
  if (!user.geminiKey && process.env.MANAGED_GEMINI !== "1") {
    throw new Error("Smoke user has no Gemini key for captions/keywords");
  }
  if (process.env.OMNIVOICE_BACKEND !== "runpod") throw new Error("OMNIVOICE_BACKEND must be runpod");
  if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID) {
    throw new Error("RunPod OmniVoice configuration is incomplete");
  }
  if (process.env.AI_STUDIO_IMAGE_ENABLED !== "1" || process.env.CREDITS_LIVE !== "1") {
    throw new Error("Hero AI Image flags are not live");
  }
  if (process.env.AI_STUDIO_Z_IMAGE_ROUTE === "custom") {
    throw new Error("Smoke refuses the custom Z-Image route; expected RunPod Public");
  }

  const before = await getBalance(user.id);
  const idempotencyKey = `ops-hero-ai-${Date.now()}`;
  const job = await createVideoJob(user.id, {
    script,
    title: "Hero AI RunPod production smoke",
    previewMode: true,
    voiceProvider: "omnivoice",
    omniVoiceId: "voice_02",
    voiceBackend: "runpod",
    stockSource: "kie-image",
    imageEngine: "runpod",
    imageModel: "z-image-turbo",
    targetClipCount: 2,
    brollRegionPreference: "thailand",
    brollVisualStyle: "realistic",
    subtitleMode: "sentence",
    subtitlePosition: "bottom",
  }, idempotencyKey);

  console.log(JSON.stringify({ event: "enqueued", jobId: job.id, user: testerEmail, balanceBefore: before.total }));
  const deadline = Date.now() + timeoutMs;
  let lastState = "";
  while (Date.now() < deadline) {
    const current = await prisma.videoJob.findUnique({
      where: { id: job.id },
      select: {
        status: true,
        currentStep: true,
        progress: true,
        errorMessage: true,
        errorCode: true,
        errorProvider: true,
        outputJson: true,
      },
    });
    if (!current) throw new Error("Smoke VideoJob disappeared");
    const state = `${current.status}:${current.currentStep ?? "-"}:${current.progress}`;
    if (state !== lastState) {
      console.log(JSON.stringify({ event: "progress", jobId: job.id, status: current.status, step: current.currentStep, progress: current.progress }));
      lastState = state;
    }
    if (current.status === "failed" || current.status === "canceled") {
      throw new Error(JSON.stringify({
        jobId: job.id,
        status: current.status,
        errorCode: current.errorCode,
        errorProvider: current.errorProvider,
        errorMessage: current.errorMessage,
      }));
    }
    if (current.status === "done") {
      const output = current.outputJson ? JSON.parse(current.outputJson) as Record<string, unknown> : {};
      const images = await prisma.aiGenerationJob.findMany({
        where: { userId: user.id, inputJson: { contains: job.id } },
        select: {
          id: true,
          status: true,
          provider: true,
          model: true,
          providerRoute: true,
          creditCost: true,
          delayTimeMs: true,
          executionTimeMs: true,
          providerReportedCostUsdMicros: true,
          outputUrl: true,
        },
        orderBy: { createdAt: "asc" },
      });
      const after = await getBalance(user.id);
      console.log(JSON.stringify({
        event: "completed",
        jobId: job.id,
        videoUrl: typeof output.videoUrl === "string" ? output.videoUrl : null,
        imageJobs: images,
        balanceBefore: before.total,
        balanceAfter: after.total,
        creditsDebited: before.total - after.total,
      }));
      return;
    }
    await sleep(5_000);
  }
  throw new Error(`Smoke VideoJob ${job.id} exceeded ${Math.round(timeoutMs / 60_000)} minutes`);
}

main()
  .catch((error) => {
    console.error(`smoke_failed=${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
