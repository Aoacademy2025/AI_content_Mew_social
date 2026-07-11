import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const images = await prisma.generatedImage.findMany({
      where: { userId: authUser.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(images);
  } catch (error) {
    return apiError({ route: "images", error });
  }
}

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { images } = await req.json();

    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: "Images array required" }, { status: 400 });
    }

    const created = await prisma.generatedImage.createMany({
      data: images.map((img: { prompt: string; url: string; imageModel: string; sceneTitle?: string; contentTitle?: string }) => ({
        userId: authUser.id,
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
