import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { encryptKey, decryptKey } from "@/lib/key-crypto";

// SECURITY: keys are write-only from the client's perspective. GET never returns the
// raw key — only whether it is set + the last 4 chars (for a "•••• 1234" style hint).
// encryptKey/decryptKey (AES-256-GCM, base64-backward-compatible) live in key-crypto.
function maskKey(stored: string | null): { set: boolean; last4: string | null } {
  if (!stored) return { set: false, last4: null };
  const v = decryptKey(stored);
  return { set: true, last4: v.length >= 4 ? v.slice(-4) : null };
}

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
      geminiKey:     maskKey(user.geminiKey),
      heygenKey:     maskKey(user.heygenKey),
      elevenlabsKey: maskKey(user.elevenlabsKey),
      pexelsKey:     maskKey(user.pexelsKey),
      pixabayKey:    maskKey(user.pixabayKey),
      kieKey:        maskKey(user.kieKey),
      unsplashKey:   maskKey(user.unsplashKey),
      flickrKey:     maskKey(user.flickrKey),
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
    if (geminiKey     !== undefined && process.env.MANAGED_GEMINI !== "1") updateData.geminiKey = geminiKey ? encryptKey(geminiKey) : null;
    if (heygenKey     !== undefined) updateData.heygenKey     = heygenKey     ? encryptKey(heygenKey)     : null;
    if (elevenlabsKey !== undefined) updateData.elevenlabsKey = elevenlabsKey ? encryptKey(elevenlabsKey) : null;
    if (pexelsKey     !== undefined) updateData.pexelsKey     = pexelsKey     ? encryptKey(pexelsKey)     : null;
    if (pixabayKey    !== undefined) updateData.pixabayKey    = pixabayKey    ? encryptKey(pixabayKey)    : null;
    if (kieKey        !== undefined) updateData.kieKey        = kieKey        ? encryptKey(kieKey)        : null;
    if (unsplashKey   !== undefined) updateData.unsplashKey   = unsplashKey   ? encryptKey(unsplashKey)   : null;
    if (flickrKey     !== undefined) updateData.flickrKey     = flickrKey     ? encryptKey(flickrKey)     : null;

    await prisma.user.update({ where: { id: authUser.id }, data: updateData });
    return NextResponse.json({ message: "API keys updated successfully" });
  } catch (error) {
    return apiError({ route: "user/api-keys", error });
  }
}
