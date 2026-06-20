import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// Trim leading/trailing whitespace + newlines BEFORE encoding — paste-from-clipboard
// commonly includes a trailing \n or surrounding spaces which break Google auth (401).
function encrypt(text: string): string { return Buffer.from(text.trim()).toString("base64"); }
function decrypt(encrypted: string): string { return Buffer.from(encrypted, "base64").toString("utf-8").trim(); }

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { geminiKey: true, heygenKey: true, elevenlabsKey: true, pexelsKey: true, pixabayKey: true, kieKey: true, unsplashKey: true, flickrKey: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    return NextResponse.json({
      geminiKey:     user.geminiKey     ? decrypt(user.geminiKey)     : "",
      heygenKey:     user.heygenKey     ? decrypt(user.heygenKey)     : "",
      elevenlabsKey: user.elevenlabsKey ? decrypt(user.elevenlabsKey) : "",
      pexelsKey:     user.pexelsKey     ? decrypt(user.pexelsKey)     : "",
      pixabayKey:    user.pixabayKey    ? decrypt(user.pixabayKey)    : "",
      kieKey:        user.kieKey        ? decrypt(user.kieKey)        : "",
      unsplashKey:   user.unsplashKey   ? decrypt(user.unsplashKey)   : "",
      flickrKey:     user.flickrKey     ? decrypt(user.flickrKey)     : "",
    });
  } catch (error) {
    return apiError({ route: "user/api-keys", error });
  }
}

export async function PUT(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { geminiKey, heygenKey, elevenlabsKey, pexelsKey, pixabayKey, kieKey, unsplashKey, flickrKey } = await req.json();

    const updateData: Record<string, string | null> = {};
    if (geminiKey     !== undefined) updateData.geminiKey     = geminiKey     ? encrypt(geminiKey)     : null;
    if (heygenKey     !== undefined) updateData.heygenKey     = heygenKey     ? encrypt(heygenKey)     : null;
    if (elevenlabsKey !== undefined) updateData.elevenlabsKey = elevenlabsKey ? encrypt(elevenlabsKey) : null;
    if (pexelsKey     !== undefined) updateData.pexelsKey     = pexelsKey     ? encrypt(pexelsKey)     : null;
    if (pixabayKey    !== undefined) updateData.pixabayKey    = pixabayKey    ? encrypt(pixabayKey)    : null;
    if (kieKey        !== undefined) updateData.kieKey        = kieKey        ? encrypt(kieKey)        : null;
    if (unsplashKey   !== undefined) updateData.unsplashKey   = unsplashKey   ? encrypt(unsplashKey)   : null;
    if (flickrKey     !== undefined) updateData.flickrKey     = flickrKey     ? encrypt(flickrKey)     : null;

    await prisma.user.update({ where: { id: authUser.id }, data: updateData });
    return NextResponse.json({ message: "API keys updated successfully" });
  } catch (error) {
    return apiError({ route: "user/api-keys", error });
  }
}
