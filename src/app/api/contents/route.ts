import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FREE_LIMITS } from "@/lib/plan-limits";
import { createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";

// GET /api/contents - Get all contents for current user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contents = await prisma.content.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(contents);
  } catch (error) {
    return apiError({ route: "GET /api/contents", error });
  }
}

// POST /api/contents - Create new content
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      sourceText,
      sourceUrl,
      styleId,
      language,
      imageModel,
      videoDuration,
      headline,
      subheadline,
      body,
      hashtags,
      imagePrompt,
      visualNotes,
    } = await req.json();

    if (!headline && !body) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    // Check FREE plan limit
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true },
    });
    if (user?.plan === "FREE") {
      const count = await prisma.content.count({ where: { userId: session.user.id } });
      if (count >= FREE_LIMITS.contents) {
        return NextResponse.json(
          { error: `Free plan จำกัด ${FREE_LIMITS.contents} คอนเทนต์ กรุณา Upgrade เป็น Pro`, limitReached: true },
          { status: 403 }
        );
      }
    }

    const content = await prisma.content.create({
      data: {
        sourceText,
        sourceUrl,
        styleId,
        language: language || "TH",
        imageModel: imageModel || "nanobanana",
        videoDuration,
        headline,
        subheadline,
        body,
        hashtags,
        imagePrompt,
        visualNotes,
        userId: session.user.id,
      },
    });

    // Notify if approaching or at limit (FREE plan)
    if (user?.plan === "FREE") {
      const newCount = await prisma.content.count({ where: { userId: session.user.id } });
      if (newCount >= FREE_LIMITS.contents) {
        createNotification({
          userId: session.user.id,
          type: "LIMIT_REACHED",
          title: "ถึงขีดจำกัด Content แล้ว",
          body: `คุณใช้ Content ครบ ${FREE_LIMITS.contents}/${FREE_LIMITS.contents} แล้ว อัปเกรดเป็น Pro เพื่อสร้างได้ไม่จำกัด`,
        }).catch(() => {});
      } else if (newCount >= FREE_LIMITS.contents - 1) {
        createNotification({
          userId: session.user.id,
          type: "LIMIT_WARNING",
          title: "ใกล้ถึงขีดจำกัด Content",
          body: `คุณใช้ Content ไปแล้ว ${newCount}/${FREE_LIMITS.contents} อีก 1 ครั้งจะเต็ม`,
        }).catch(() => {});
      }
    }

    return NextResponse.json(content, { status: 201 });
  } catch (error) {
    return apiError({ route: "POST /api/contents", error });
  }
}
