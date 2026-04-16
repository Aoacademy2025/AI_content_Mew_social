import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FREE_LIMITS } from "@/lib/plan-limits";
import { createNotification } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";

// GET /api/styles - Get all styles for current user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const styles = await prisma.style.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(styles);
  } catch (error) {
    return apiError({ route: "GET /api/styles", error });
  }
}

// POST /api/styles - Create new style
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, sampleText, sampleUrl, instructionPrompt } = await req.json();

    if (!name || !instructionPrompt) {
      return NextResponse.json(
        { error: "Name and instruction prompt are required" },
        { status: 400 }
      );
    }

    // Check FREE plan limit
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true },
    });
    if (user?.plan === "FREE") {
      const count = await prisma.style.count({ where: { userId: session.user.id } });
      if (count >= FREE_LIMITS.styles) {
        return NextResponse.json(
          { error: `Free plan จำกัด ${FREE_LIMITS.styles} สไตล์ กรุณา Upgrade เป็น Pro`, limitReached: true },
          { status: 403 }
        );
      }
    }

    const style = await prisma.style.create({
      data: {
        name,
        sampleText,
        sampleUrl,
        instructionPrompt,
        userId: session.user.id,
      },
    });

    // Notify if approaching or at limit (FREE plan)
    if (user?.plan === "FREE") {
      const newCount = await prisma.style.count({ where: { userId: session.user.id } });
      if (newCount >= FREE_LIMITS.styles) {
        createNotification({
          userId: session.user.id,
          type: "LIMIT_REACHED",
          title: "ถึงขีดจำกัด Style แล้ว",
          body: `คุณใช้ Style ครบ ${FREE_LIMITS.styles}/${FREE_LIMITS.styles} แล้ว อัปเกรดเป็น Pro เพื่อสร้างได้ไม่จำกัด`,
        }).catch(() => {});
      } else if (newCount >= FREE_LIMITS.styles - 1) {
        createNotification({
          userId: session.user.id,
          type: "LIMIT_WARNING",
          title: "ใกล้ถึงขีดจำกัด Style",
          body: `คุณใช้ Style ไปแล้ว ${newCount}/${FREE_LIMITS.styles} อีก 1 ครั้งจะเต็ม`,
        }).catch(() => {});
      }
    }

    return NextResponse.json(style, { status: 201 });
  } catch (error) {
    return apiError({ route: "POST /api/styles", error });
  }
}
