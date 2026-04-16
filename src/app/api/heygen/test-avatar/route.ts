import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";

export const maxDuration = 300;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

async function uploadAsset(buffer: Buffer, contentType: string, heygenKey: string) {
  const res = await fetch("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": contentType, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  });
  const data = await res.json();
  console.log(`[test-avatar] upload ${contentType}:`, res.status, JSON.stringify(data));
  if (!res.ok || !data.data?.id) throw new Error(`Upload failed: ${data.message ?? res.status}`);
  return { id: data.data.id as string, url: data.data.url as string };
}


// POST /api/heygen/test-avatar
// Body: { text, avatarId, bgVideoUrl? }
// bgVideoUrl: local /renders/xxx.mp4 — ถ้าไม่มีให้ใช้ solid black bg
// HeyGen จัดการ matting + composite ทั้งหมด ไม่ใช้ ffmpeg
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    text,
    avatarId,
    voiceId = "2d5b0e6cf36f460aa7fc47e3eee4ba54",
  } = body ?? {};
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = decrypt(user.heygenKey);

  // Params from heygen-direct (proven working): scale=2.02, offset.y=0.28
  const genPayload = {
    video_inputs: [{
      character: {
        type: "avatar",
        avatar_id: avatarId,
        avatar_style: "normal",
        offset: { x: 0.0, y: 0.28 },
        scale: 2.02,
        matting: true,
      },
      voice: { type: "text", input_text: text, voice_id: voiceId, speed: 1.0 },
      background: { type: "color", value: "#00FF00" },
    }],
    dimension: { width: 720, height: 1280 },
  };

  console.log("[test-avatar] generate:", JSON.stringify(genPayload));
  const genRes = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
    body: JSON.stringify(genPayload),
  });
  const genData = await genRes.json();
  console.log("[test-avatar] response:", genRes.status, JSON.stringify(genData));
  if (!genRes.ok || !genData.data?.video_id) {
    return NextResponse.json({ error: `HeyGen generate failed: ${JSON.stringify(genData.error ?? genData)}` }, { status: 500 });
  }

  // Return videoId immediately — client polls /api/videos/poll-avatar
  return NextResponse.json({ videoId: genData.data.video_id, status: "pending" });
}
