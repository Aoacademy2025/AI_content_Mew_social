import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-crypto";
import { isPaid } from "@/lib/plan-limits";
import { HeyGenAuthError } from "@/lib/heygen-avatars";
import { getHeyGenOwnAvatars } from "@/lib/heygen-own-avatars";

// GET /api/heygen/my-avatars — the user's OWN HeyGen avatars only (their avatar groups →
// looks), fast (~2s) instead of the whole public catalog (~65s via /v2/avatars). Powers the
// editor v2 avatar picker. Same auth/plan/key contract as /api/heygen/avatars so the client
// error states (no-key/not-paid/bad-key) are identical.
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true, heygenKey: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (!isPaid(user.plan)) {
      return NextResponse.json(
        { error: "HeyGen avatars are only available for Pro and Business users" },
        { status: 403 },
      );
    }
    if (!user.heygenKey) {
      return NextResponse.json(
        { error: "Please add your HeyGen API key in Settings" },
        { status: 400 },
      );
    }

    const apiKey = decryptKey(user.heygenKey);
    const { avatars } = await getHeyGenOwnAvatars(authUser.id, apiKey);
    return NextResponse.json({ avatars, stale: false }, { status: 200 });
  } catch (error: any) {
    if (error instanceof HeyGenAuthError) {
      return NextResponse.json({ error: "Invalid HeyGen API key" }, { status: 401 });
    }
    console.error("HeyGen my-avatars error:", error?.message ?? error);
    return NextResponse.json(
      { error: "Failed to fetch avatars", details: error?.message },
      { status: 500 },
    );
  }
}
