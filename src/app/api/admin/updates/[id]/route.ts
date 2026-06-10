import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import {
  cleanUpdateString,
  normalizeUpdateCategory,
  normalizeUpdateImportance,
  normalizeUpdateState,
  parseUpdateDate,
} from "@/lib/product-updates";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

function updateData(body: Record<string, unknown>) {
  const state = body.state == null ? null : normalizeUpdateState(body.state);
  const publishedAt = body.publishedAt === null
    ? null
    : parseUpdateDate(body.publishedAt) ?? (state === "PUBLISHED" ? new Date() : undefined);
  const data: Record<string, unknown> = {};

  const version = cleanUpdateString(body.version, 32);
  const title = cleanUpdateString(body.title, 120);
  const summary = cleanUpdateString(body.summary, 280);
  if (version) data.version = version;
  if (title) data.title = title;
  if (summary) data.summary = summary;
  if (body.body !== undefined) data.body = cleanUpdateString(body.body, 8_000);
  if (body.category !== undefined) data.category = normalizeUpdateCategory(body.category);
  if (body.importance !== undefined) data.importance = normalizeUpdateImportance(body.importance);
  if (state) data.state = state;
  if (body.isPinned !== undefined) data.isPinned = Boolean(body.isPinned);
  if (body.targetPath !== undefined) data.targetPath = cleanUpdateString(body.targetPath, 160);
  if (body.ctaLabel !== undefined) data.ctaLabel = cleanUpdateString(body.ctaLabel, 80);
  if (body.ctaHref !== undefined) data.ctaHref = cleanUpdateString(body.ctaHref, 240);
  if (body.imageUrl !== undefined) data.imageUrl = cleanUpdateString(body.imageUrl, 360);
  if (state) data.publishedAt = state === "PUBLISHED" ? publishedAt ?? new Date() : null;

  return data;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const data = updateData(body);

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const update = await prisma.productUpdate.update({
      where: { id },
      data,
      include: { _count: { select: { reads: true } } },
    });

    return NextResponse.json({
      update: {
        ...update,
        publishedAt: update.publishedAt?.toISOString() ?? null,
        createdAt: update.createdAt.toISOString(),
        updatedAt: update.updatedAt.toISOString(),
        readCount: update._count.reads,
        _count: undefined,
      },
    });
  } catch (error) {
    return apiError({ route: "PATCH /api/admin/updates/[id]", error });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const { id } = await params;
    await prisma.productUpdate.update({
      where: { id },
      data: { state: "ARCHIVED", isPinned: false },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "DELETE /api/admin/updates/[id]", error });
  }
}
