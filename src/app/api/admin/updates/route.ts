import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import {
  cleanUpdateString,
  normalizeUpdateCategory,
  normalizeUpdateState,
  parseUpdateDate,
} from "@/lib/product-updates";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

function serializeAdminUpdate(update: {
  id: string;
  version: string;
  title: string;
  summary: string;
  body: string | null;
  category: string;
  state: string;
  isPinned: boolean;
  targetPath: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { reads: number };
}) {
  return {
    ...update,
    publishedAt: update.publishedAt?.toISOString() ?? null,
    createdAt: update.createdAt.toISOString(),
    updatedAt: update.updatedAt.toISOString(),
    readCount: update._count?.reads ?? 0,
    _count: undefined,
  };
}

function buildUpdateData(body: Record<string, unknown>, mode: "create" | "update"): { error: string } | { data: Prisma.ProductUpdateCreateInput } {
  const version = cleanUpdateString(body.version, 32);
  const title = cleanUpdateString(body.title, 120);
  const summary = cleanUpdateString(body.summary, 280);
  const state = normalizeUpdateState(body.state);
  const publishedAt = parseUpdateDate(body.publishedAt) ?? (state === "PUBLISHED" ? new Date() : null);

  if (mode === "create" && (!version || !title || !summary)) {
    return { error: "version, title, summary required" };
  }

  if (!version || !title || !summary) {
    return { error: "version, title, summary required" };
  }

  const data: Prisma.ProductUpdateCreateInput = {
    version,
    title,
    summary,
    body: cleanUpdateString(body.body, 8_000),
    category: normalizeUpdateCategory(body.category),
    state,
    isPinned: Boolean(body.isPinned),
    targetPath: cleanUpdateString(body.targetPath, 160),
    ctaLabel: cleanUpdateString(body.ctaLabel, 80),
    ctaHref: cleanUpdateString(body.ctaHref, 240),
    imageUrl: cleanUpdateString(body.imageUrl, 360),
    publishedAt: state === "PUBLISHED" ? publishedAt : null,
  };

  return { data };
}

export async function GET(req: Request) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const where = state && state !== "ALL" ? { state: normalizeUpdateState(state) } : {};
    const updates = await prisma.productUpdate.findMany({
      where,
      include: { _count: { select: { reads: true } } },
      orderBy: [
        { state: "asc" },
        { isPinned: "desc" },
        { publishedAt: "desc" },
        { createdAt: "desc" },
      ],
      take: 200,
    });

    return NextResponse.json({ updates: updates.map(serializeAdminUpdate) });
  } catch (error) {
    return apiError({ route: "GET /api/admin/updates", error });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const body = await req.json().catch(() => ({}));
    const built = buildUpdateData(body, "create");
    if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 });

    const update = await prisma.productUpdate.create({
      data: built.data!,
      include: { _count: { select: { reads: true } } },
    });

    return NextResponse.json({ update: serializeAdminUpdate(update) }, { status: 201 });
  } catch (error) {
    return apiError({ route: "POST /api/admin/updates", error });
  }
}
