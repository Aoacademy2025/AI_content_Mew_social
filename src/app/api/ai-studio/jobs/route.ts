import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { ensureMonthlyGrant, getBalance } from "@/lib/credits";
import { publicAiGenerationJob } from "@/lib/ai-generation-jobs.server";
import { apiError } from "@/lib/api-error";
import {
  heroVoiceCloneCanaryAccessDecision,
  isHeroVoiceCloneGenerationJob,
} from "@/lib/omnivoice-policy";
import {
  heroVoiceClonePrivateJson,
  heroVoiceClonePrivateResponse,
} from "@/lib/hero-voice-clone-response.server";
import { normalizeHeroVoiceClonePublicJob } from "@/lib/hero-voice-clone-state";

export async function GET() {
  try {
    const user = await getCurrentUser();
    const access = heroVoiceCloneCanaryAccessDecision(user);
    if (!access.allowed) {
      return heroVoiceClonePrivateJson(
        { error: access.status === 401 ? "Unauthorized" : "Not found" },
        { status: access.status },
      );
    }
    if (!user) throw new Error("clone canary access decision admitted a missing actor");
    await ensureMonthlyGrant(user.id);
    const [jobs, balance] = await Promise.all([
      prisma.aiGenerationJob.findMany({
        where: {
          userId: user.id,
          OR: [
            { kind: "image" },
            { kind: "voice", providerModel: "omnivoice-clone", model: { startsWith: "user_" } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
      getBalance(user.id),
    ]);
    const visibleJobs = jobs.filter((job) => job.kind === "image" || isHeroVoiceCloneGenerationJob(job));
    return heroVoiceClonePrivateJson({
      jobs: visibleJobs.map((job) => {
        const publicJob = publicAiGenerationJob(job);
        return job.kind === "voice" ? normalizeHeroVoiceClonePublicJob(publicJob) : publicJob;
      }),
      balance,
    });
  } catch (error) {
    return heroVoiceClonePrivateResponse(apiError({ route: "ai-studio/jobs", error }));
  }
}
