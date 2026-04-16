import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// GET /api/user/video-settings — get saved avatar & voice IDs for current user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { heygenAvatarId: true, elevenlabsVoiceId: true, ttsProvider: true, geminiVoiceName: true },
    });

    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    return NextResponse.json({
      heygenAvatarId: user.heygenAvatarId ?? "",
      elevenlabsVoiceId: user.elevenlabsVoiceId ?? "",
      ttsProvider: user.ttsProvider ?? "elevenlabs",
      geminiVoiceName: user.geminiVoiceName ?? "Aoede",
    });
  } catch (error) {
    return apiError({ route: "GET /api/user/video-settings", error });
  }
}

// PATCH /api/user/video-settings — save avatar & voice IDs for current user
export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const data: {
      heygenAvatarId?: string;
      elevenlabsVoiceId?: string;
      ttsProvider?: string;
      geminiVoiceName?: string;
    } = {};

    if (typeof body.heygenAvatarId === "string") data.heygenAvatarId = body.heygenAvatarId.trim();
    if (typeof body.elevenlabsVoiceId === "string") data.elevenlabsVoiceId = body.elevenlabsVoiceId.trim();
    if (typeof body.ttsProvider === "string") data.ttsProvider = body.ttsProvider.trim();
    if (typeof body.geminiVoiceName === "string") data.geminiVoiceName = body.geminiVoiceName.trim();

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data,
      select: { heygenAvatarId: true, elevenlabsVoiceId: true, ttsProvider: true, geminiVoiceName: true },
    });

    return NextResponse.json({ ok: true, ...user });
  } catch (error) {
    return apiError({ route: "PATCH /api/user/video-settings", error });
  }
}
