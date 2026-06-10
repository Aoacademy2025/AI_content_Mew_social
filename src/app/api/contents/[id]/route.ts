import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

// GET /api/contents/[id] - Get single content
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

    const content = await prisma.content.findFirst({
      where: {
        id,
        userId: authUser.id,
      },
    });

    if (!content) {
      return NextResponse.json({ error: "Content not found" }, { status: 404 });
    }

    return NextResponse.json(content);
  } catch (error) {
    return apiError({ route: "contents/[id]", error });
  }
}

// PUT /api/contents/[id] - Update content
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

    const {
      sourceText,
      sourceUrl,
      styleId,
      language,
      videoDuration,
      headline,
      subheadline,
      body,
      hashtags,
    } = await req.json();

    const updated = await prisma.content.updateMany({
      where: {
        id,
        userId: authUser.id,
      },
      data: {
        sourceText,
        sourceUrl,
        styleId,
        language,
        videoDuration,
        headline,
        subheadline,
        body,
        hashtags,
      },
    });

    if (updated.count === 0) {
      return NextResponse.json({ error: "Content not found" }, { status: 404 });
    }

    const content = await prisma.content.findUnique({
      where: { id },
    });

    return NextResponse.json(content);
  } catch (error) {
    return apiError({ route: "contents/[id]", error });
  }
}

// DELETE /api/contents/[id] - Delete content
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

    const deleted = await prisma.content.deleteMany({
      where: {
        id,
        userId: authUser.id,
      },
    });

    if (deleted.count === 0) {
      return NextResponse.json({ error: "Content not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Content deleted successfully" });
  } catch (error) {
    return apiError({ route: "contents/[id]", error });
  }
}
