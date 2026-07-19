import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { decryptKey } from "@/lib/key-crypto";
import { apiError } from "@/lib/api-error";
import { isPaid } from "@/lib/plan-limits";
import { getHeyGenAvatarList, HeyGenAuthError } from "@/lib/heygen-avatars";
import { loadStaleAvatars, saveStaleAvatars } from "@/lib/heygen-avatars-store";

// GET /api/heygen/avatars - Fetch available avatar models from HeyGen
export async function GET() {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's HeyGen API key
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true, heygenKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check plan
    if (!isPaid(user.plan)) {
      return NextResponse.json(
        { error: "HeyGen avatars are only available for Pro and Business users" },
        { status: 403 }
      );
    }

    // Check API key
    if (!user.heygenKey) {
      return NextResponse.json(
        { error: "Please add your HeyGen API key in Settings" },
        { status: 400 }
      );
    }

    // Decrypt API key
    const apiKey = decryptKey(user.heygenKey);

    // Cached + retried + durable-stale fallback: if HeyGen's list endpoint is slow/unreachable we
    // serve the last successful list (flagged stale) instead of 500ing with an empty picker.
    const list = await getHeyGenAvatarList(authUser.id, apiKey, {
      loadStale: loadStaleAvatars,
      saveStale: saveStaleAvatars,
    });
    const avatars = list.avatars.map((avatar: any) => ({
      avatar_id: avatar.avatar_id,
      avatar_name: avatar.avatar_name,
      preview_image_url: avatar.preview_image_url || avatar.preview_video_url,
      gender: avatar.gender || "unknown",
      is_public: avatar.is_public || false,
    }));

    return NextResponse.json({ avatars, stale: list.stale ?? false }, { status: 200 });
  } catch (error: any) {
    if (error instanceof HeyGenAuthError) {
      return NextResponse.json({ error: "Invalid HeyGen API key" }, { status: 401 });
    }
    console.error("HeyGen avatars error:", error?.message ?? error);
    return NextResponse.json(
      { error: "Failed to fetch avatars", details: error?.message },
      { status: 500 }
    );
  }
}
