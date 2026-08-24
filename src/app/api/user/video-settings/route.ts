import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { validateVideoSettingsPatch } from "@/lib/video-settings";
import { parseTtsProvider } from "@/lib/tts-providers";

// GET /api/user/video-settings — get saved avatar & voice IDs for current user
export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { heygenAvatarId: true, elevenlabsVoiceId: true, ttsProvider: true, geminiVoiceName: true },
    });

    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    return NextResponse.json({
      heygenAvatarId: user.heygenAvatarId ?? "",
      elevenlabsVoiceId: user.elevenlabsVoiceId ?? "",
      ttsProvider: parseTtsProvider(user.ttsProvider),
      geminiVoiceName: user.geminiVoiceName ?? "Aoede",
    });
  } catch (error) {
    return apiError({ route: "GET /api/user/video-settings", error });
  }
}

// PATCH /api/user/video-settings — save avatar & voice IDs for current user
export async function PATCH(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const validated = validateVideoSettingsPatch(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.message }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: validated.data,
      select: { heygenAvatarId: true, elevenlabsVoiceId: true, ttsProvider: true, geminiVoiceName: true },
    });

    return NextResponse.json({ ok: true, ...user });
  } catch (error) {
    return apiError({ route: "PATCH /api/user/video-settings", error });
  }
}
