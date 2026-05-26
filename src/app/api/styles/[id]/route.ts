import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// GET /api/styles/[id] - Get single style
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const style = await prisma.style.findFirst({
      where: {
        id,
        userId: authUser.id,
      },
    });

    if (!style) {
      return NextResponse.json({ error: "Style not found" }, { status: 404 });
    }

    return NextResponse.json(style);
  } catch (error) {
    return apiError({ route: "styles/[id]", error });
  }
}

// PUT /api/styles/[id] - Update style
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, sampleText, sampleUrl, instructionPrompt } = await req.json();

    if (!name || !instructionPrompt) {
      return NextResponse.json(
        { error: "Name and instruction prompt are required" },
        { status: 400 }
      );
    }

    const style = await prisma.style.updateMany({
      where: {
        id,
        userId: authUser.id,
      },
      data: {
        name,
        sampleText,
        sampleUrl,
        instructionPrompt,
      },
    });

    if (style.count === 0) {
      return NextResponse.json({ error: "Style not found" }, { status: 404 });
    }

    const updatedStyle = await prisma.style.findUnique({
      where: { id },
    });

    return NextResponse.json(updatedStyle);
  } catch (error) {
    return apiError({ route: "styles/[id]", error });
  }
}

// DELETE /api/styles/[id] - Delete style
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    const { id } = await params;

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const deleted = await prisma.style.deleteMany({
      where: {
        id,
        userId: authUser.id,
      },
    });

    if (deleted.count === 0) {
      return NextResponse.json({ error: "Style not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Style deleted successfully" });
  } catch (error) {
    return apiError({ route: "styles/[id]", error });
  }
}
