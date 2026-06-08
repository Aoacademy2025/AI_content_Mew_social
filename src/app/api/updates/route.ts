import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { APP_VERSION_FALLBACK } from "@/lib/product-updates";

function publishedWhere(now = new Date()) {
  return {
    state: "PUBLISHED" as const,
    OR: [
      { publishedAt: null },
      { publishedAt: { lte: now } },
    ],
  };
}

function serializeUpdate(update: {
  id: string;
  version: string;
  title: string;
  summary: string;
  body: string | null;
  category: string;
  isPinned: boolean;
  targetPath: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  reads?: { readAt: Date }[];
}) {
  const readAt = update.reads?.[0]?.readAt ?? null;
  return {
    id: update.id,
    version: update.version,
    title: update.title,
    summary: update.summary,
    body: update.body,
    category: update.category,
    isPinned: update.isPinned,
    targetPath: update.targetPath,
    ctaLabel: update.ctaLabel,
    ctaHref: update.ctaHref,
    imageUrl: update.imageUrl,
    publishedAt: (update.publishedAt ?? update.createdAt).toISOString(),
    readAt: readAt?.toISOString() ?? null,
    unread: !readAt,
  };
}

export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const summaryOnly = url.searchParams.get("summary") === "1";
    const now = new Date();

    const updates = await prisma.productUpdate.findMany({
      where: publishedWhere(now),
      include: {
        reads: {
          where: { userId: authUser.id },
          select: { readAt: true },
        },
      },
      orderBy: [
        { isPinned: "desc" },
        { publishedAt: "desc" },
        { createdAt: "desc" },
      ],
      take: summaryOnly ? 30 : 100,
    });

    const latestByDate = [...updates].sort((a, b) => {
      const at = (a.publishedAt ?? a.createdAt).getTime();
      const bt = (b.publishedAt ?? b.createdAt).getTime();
      return bt - at;
    })[0] ?? null;
    const unreadCount = updates.filter((update) => update.reads.length === 0).length;

    return NextResponse.json({
      currentVersion: latestByDate?.version ?? APP_VERSION_FALLBACK,
      unreadCount,
      total: updates.length,
      updates: summaryOnly ? [] : updates.map(serializeUpdate),
    });
  } catch (error) {
    return apiError({ route: "GET /api/updates", error });
  }
}

export async function PATCH(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const updateId = typeof body.updateId === "string" ? body.updateId : null;
    const now = new Date();

    const updates = updateId
      ? await prisma.productUpdate.findMany({
        where: { id: updateId, ...publishedWhere(now) },
        select: { id: true },
        take: 1,
      })
      : await prisma.productUpdate.findMany({
        where: publishedWhere(now),
        select: { id: true },
        take: 100,
      });

    await prisma.$transaction(
      updates.map((update) => prisma.productUpdateRead.upsert({
        where: { updateId_userId: { updateId: update.id, userId: authUser.id } },
        update: { readAt: now },
        create: { updateId: update.id, userId: authUser.id, readAt: now },
      })),
    );

    return NextResponse.json({ ok: true, readCount: updates.length });
  } catch (error) {
    return apiError({ route: "PATCH /api/updates", error });
  }
}
