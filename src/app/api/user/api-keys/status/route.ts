import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { computeKeyStatus } from "@/lib/key-tiers";
import { isManagedStockFlagOn, managedStockKeys } from "@/lib/managed-stock.server";

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
    const isManagedMode = process.env.MANAGED_GEMINI === "1";
    const status = computeKeyStatus({
      gemini: present(user.geminiKey), pexels: present(user.pexelsKey), pixabay: present(user.pixabayKey),
      elevenlabs: present(user.elevenlabsKey), heygen: present(user.heygenKey),
    }, isManagedMode);
    return NextResponse.json({
      ...status,
      onboardingDismissed: user.onboardingDismissedAt != null,
      ...(isManagedMode ? { managed: true } : {}),
      // Managed stock B-roll (#297): server truth for the onboarding copy, so a
      // client that never got a rebuild still stops calling Pexels/Pixabay
      // "จำเป็น". Absent (not false) when the flag is off — payload unchanged.
      ...(isManagedStockFlagOn() && (managedStockKeys().pexelsKey || managedStockKeys().pixabayKey)
        ? { managedStock: true }
        : {}),
      ...(process.env.MINUTE_QUOTA === "1" ? { minuteQuota: true } : {}),
    });
  } catch (error) {
    return apiError({ route: "user/api-keys/status", error });
  }
}
