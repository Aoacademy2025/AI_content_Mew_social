import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

const EXPIRY_DAYS = 7;

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - EXPIRY_DAYS);

    // Auto-delete expired images
    await prisma.generatedImage.deleteMany({
      where: { userId: session.user.id, createdAt: { lt: expiryDate } },
    });

    const images = await prisma.generatedImage.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(images);
  } catch (error) {
    return apiError({ route: "images", error });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { images } = await req.json();

    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: "Images array required" }, { status: 400 });
    }

    const created = await prisma.generatedImage.createMany({
      data: images.map((img: { prompt: string; url: string; imageModel: string; sceneTitle?: string; contentTitle?: string }) => ({
        userId: session.user.id,
        prompt: img.prompt,
        url: img.url,
        imageModel: img.imageModel,
        sceneTitle: img.sceneTitle ?? null,
        contentTitle: img.contentTitle ?? null,
      })),
    });

    return NextResponse.json({ count: created.count });
  } catch (error) {
    return apiError({ route: "images", error });
  }
}
