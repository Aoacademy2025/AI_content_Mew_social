import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

function encrypt(text: string): string { return Buffer.from(text).toString("base64"); }
function decrypt(encrypted: string): string { return Buffer.from(encrypted, "base64").toString("utf-8"); }

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: (session.user as { id: string }).id },
      select: { openaiKey: true, geminiKey: true, heygenKey: true, elevenlabsKey: true, pexelsKey: true, pixabayKey: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    return NextResponse.json({
      openaiKey:     user.openaiKey     ? decrypt(user.openaiKey)     : "",
      geminiKey:     user.geminiKey     ? decrypt(user.geminiKey)     : "",
      heygenKey:     user.heygenKey     ? decrypt(user.heygenKey)     : "",
      elevenlabsKey: user.elevenlabsKey ? decrypt(user.elevenlabsKey) : "",
      pexelsKey:     user.pexelsKey     ? decrypt(user.pexelsKey)     : "",
      pixabayKey:    user.pixabayKey    ? decrypt(user.pixabayKey)    : "",
    });
  } catch (error) {
    return apiError({ route: "user/api-keys", error });
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { openaiKey, geminiKey, heygenKey, elevenlabsKey, pexelsKey, pixabayKey } = await req.json();

    const updateData: Record<string, string | null> = {};
    if (openaiKey     !== undefined) updateData.openaiKey     = openaiKey     ? encrypt(openaiKey)     : null;
    if (geminiKey     !== undefined) updateData.geminiKey     = geminiKey     ? encrypt(geminiKey)     : null;
    if (heygenKey     !== undefined) updateData.heygenKey     = heygenKey     ? encrypt(heygenKey)     : null;
    if (elevenlabsKey !== undefined) updateData.elevenlabsKey = elevenlabsKey ? encrypt(elevenlabsKey) : null;
    if (pexelsKey     !== undefined) updateData.pexelsKey     = pexelsKey     ? encrypt(pexelsKey)     : null;
    if (pixabayKey    !== undefined) updateData.pixabayKey    = pixabayKey    ? encrypt(pixabayKey)    : null;

    await prisma.user.update({ where: { id: (session.user as { id: string }).id }, data: updateData });
    return NextResponse.json({ message: "API keys updated successfully" });
  } catch (error) {
    return apiError({ route: "user/api-keys", error });
  }
}
