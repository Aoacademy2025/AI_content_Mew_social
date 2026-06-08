import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import axios from "axios";
import { isPaid } from "@/lib/plan-limits";

// GET /api/elevenlabs/voices - Fetch available voice models from ElevenLabs
export async function GET() {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's ElevenLabs API key
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { plan: true, elevenlabsKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check plan
    if (!isPaid(user.plan)) {
      return NextResponse.json(
        { error: "ElevenLabs voices are only available for Pro and Business users" },
        { status: 403 }
      );
    }

    // Check API key
    if (!user.elevenlabsKey) {
      return NextResponse.json(
        { error: "Please add your ElevenLabs API key in Settings" },
        { status: 400 }
      );
    }

    // Decrypt API key
    const apiKey = Buffer.from(user.elevenlabsKey, "base64").toString("utf-8");

    // Fetch voices from ElevenLabs API
    const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: {
        "xi-api-key": apiKey,
      },
      timeout: 10000,
    });

    const voices = response.data.voices.map((voice: any) => ({
      voice_id: voice.voice_id,
      name: voice.name,
      category: voice.category,
      description: voice.description || "",
      preview_url: voice.preview_url || null,
      labels: voice.labels || {},
    }));

    return NextResponse.json({ voices }, { status: 200 });
  } catch (error: any) {
    if (error.response?.status === 401) {
      return NextResponse.json({ error: "API Key ElevenLabs ไม่ถูกต้อง กรุณาตรวจสอบใน Settings" }, { status: 401 });
    }
    return apiError({ route: "GET /api/elevenlabs/voices", error });
  }
}
