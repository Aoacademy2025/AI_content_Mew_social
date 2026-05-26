import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function PUT(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { name } = await req.json();
    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: { name },
    });

    return NextResponse.json({
      message: "Profile updated successfully",
      user: { id: authUser.id, name: user.name, email: user.email },
    });
  } catch (error) {
    return apiError({ route: "user/profile", error });
  }
}
