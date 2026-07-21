import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { ensureMonthlyGrant, getBalance } from "@/lib/credits";
import { publicAiGenerationJob } from "@/lib/ai-generation-jobs.server";
import { apiError } from "@/lib/api-error";
import { isInternalAiTester } from "@/lib/internal-ai-access";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await ensureMonthlyGrant(user.id);
    const [jobs, balance] = await Promise.all([
      prisma.aiGenerationJob.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
      getBalance(user.id),
    ]);
    return NextResponse.json({ jobs: jobs.map(publicAiGenerationJob), balance });
  } catch (error) {
    return apiError({ route: "ai-studio/jobs", error });
  }
}
