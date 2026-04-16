import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// POST /api/user/upgrade - Upgrade user from FREE to PRO plan
export async function POST() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { plan: true, openaiKey: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if already on PRO plan
    if (user.plan === "PRO") {
      return NextResponse.json(
        { message: "Already on Pro plan" },
        { status: 200 }
      );
    }

    // Verify user has saved OpenAI API key
    if (!user.openaiKey) {
      return NextResponse.json(
        { error: "Please save your OpenAI API key first" },
        { status: 400 }
      );
    }

    // Update user plan to PRO
    await prisma.user.update({
      where: { id: session.user.id },
      data: { plan: "PRO" },
    });

    return NextResponse.json(
      { message: "Successfully upgraded to Pro plan" },
      { status: 200 }
    );
  } catch (error) {
    return apiError({ route: "user/upgrade", error });
  }
}
