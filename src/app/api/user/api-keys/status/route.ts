import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { computeKeyStatus } from "@/lib/key-tiers";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        geminiKey: true, pexelsKey: true, pixabayKey: true, elevenlabsKey: true, heygenKey: true,
        onboardingDismissedAt: true,
      },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const present = (v: string | null) => !!(v && v.length > 0);
    const status = computeKeyStatus({
      gemini: present(user.geminiKey), pexels: present(user.pexelsKey), pixabay: present(user.pixabayKey),
      elevenlabs: present(user.elevenlabsKey), heygen: present(user.heygenKey),
    });
    return NextResponse.json({ ...status, onboardingDismissed: user.onboardingDismissedAt != null });
  } catch (error) {
    return apiError({ route: "user/api-keys/status", error });
  }
}
