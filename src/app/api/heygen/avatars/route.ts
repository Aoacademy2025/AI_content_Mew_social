import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import axios from "axios";
import { apiError } from "@/lib/api-error";

// GET /api/heygen/avatars - Fetch available avatar models from HeyGen
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's HeyGen API key
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true, heygenKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check plan
    if (user.plan !== "PRO") {
      return NextResponse.json(
        { error: "HeyGen avatars are only available for Pro users" },
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
    const apiKey = Buffer.from(user.heygenKey, "base64").toString("utf-8");

    // Fetch avatars from HeyGen API
    const response = await axios.get(
      "https://api.heygen.com/v2/avatars",
      {
        headers: {
          "X-Api-Key": apiKey,
          accept: "application/json",
        },
        timeout: 10000,
      }
    );

    const avatars = response.data.data.avatars.map((avatar: any) => ({
      avatar_id: avatar.avatar_id,
      avatar_name: avatar.avatar_name,
      preview_image_url: avatar.preview_image_url || avatar.preview_video_url,
      gender: avatar.gender || "unknown",
      is_public: avatar.is_public || false,
    }));

    return NextResponse.json({ avatars }, { status: 200 });
  } catch (error: any) {
    console.error("HeyGen avatars error:", error);

    if (error.response?.status === 401) {
      return NextResponse.json(
        { error: "Invalid HeyGen API key" },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: "Failed to fetch avatars",
        details: error.message,
      },
      { status: 500 }
    );
  }
}
