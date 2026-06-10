import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const image = await prisma.generatedImage.findUnique({
      where: { id },
    });

    if (!image || image.userId !== authUser.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.generatedImage.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError({ route: "images/[id]", error });
  }
}
