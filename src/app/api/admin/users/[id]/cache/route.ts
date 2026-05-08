import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

function scanUserFiles(userId: string) {
  const stocksDir = path.join(process.cwd(), "stocks");
  const rendersDir = path.join(process.cwd(), "public", "renders");

  // Gallery-protected files — never delete
  const galleryVideos = prisma.video.findMany({ where: { userId }, select: { videoUrl: true, audioUrl: true } });

  function scanDir(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return { files: [] as string[], sizeMb: 0 };
    const files: string[] = [];
    let sizeBytes = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(prefix)) continue;
        try {
          const fp = path.join(dir, f);
          const stat = fs.statSync(fp);
          if (stat.isFile()) { files.push(f); sizeBytes += stat.size; }
        } catch {}
      }
    } catch {}
    return { files, sizeMb: Math.round(sizeBytes / 1024 / 1024 * 10) / 10 };
  }

  const stocks = scanDir(stocksDir, `stock-${userId}`);
  const renders = scanDir(rendersDir, `render-`); // renders not prefixed by userId — scan all non-gallery
  return { stocks, renders };
}

// GET — scan cache size for a user
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as { role?: string }).role !== "ADMIN")
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id: userId } = await params;

    const stocksDir = path.join(process.cwd(), "stocks");
    const rendersDir = path.join(process.cwd(), "public", "renders");

    // Stock files are prefixed with userId
    const userStockPrefix = `stock-${userId}`;
    let stockCount = 0, stockBytes = 0;
    if (fs.existsSync(stocksDir)) {
      for (const f of fs.readdirSync(stocksDir)) {
        if (!f.startsWith(userStockPrefix)) continue;
        try { const s = fs.statSync(path.join(stocksDir, f)); stockCount++; stockBytes += s.size; } catch {}
      }
    }

    // Gallery videos (protected)
    const galleryVideos = await prisma.video.findMany({ where: { userId }, select: { videoUrl: true, audioUrl: true } });
    const protectedNames = new Set<string>();
    for (const v of galleryVideos) {
      if (v.videoUrl) protectedNames.add(path.basename(v.videoUrl));
      if (v.audioUrl) protectedNames.add(path.basename(v.audioUrl));
    }

    // Render files (not user-prefixed — show all non-gallery renders for global cleanup context)
    let renderCount = 0, renderBytes = 0, renderProtected = 0;
    if (fs.existsSync(rendersDir)) {
      for (const f of fs.readdirSync(rendersDir)) {
        try {
          const s = fs.statSync(path.join(rendersDir, f));
          if (!s.isFile()) continue;
          if (protectedNames.has(f)) { renderProtected++; continue; }
          renderCount++;
          renderBytes += s.size;
        } catch {}
      }
    }

    // Open support tickets
    const openTickets = await prisma.supportTicket.count({ where: { userId, status: "OPEN" } });

    return NextResponse.json({
      stocks: { count: stockCount, sizeMb: Math.round(stockBytes / 1024 / 1024 * 10) / 10 },
      renders: { count: renderCount, sizeMb: Math.round(renderBytes / 1024 / 1024 * 10) / 10, protected: renderProtected },
      openTickets,
    });
  } catch (error) {
    return apiError({ route: "GET admin/users/[id]/cache", error });
  }
}

// DELETE — clear stock files for this user + optionally non-gallery renders
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as { role?: string }).role !== "ADMIN")
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id: userId } = await params;
    const { includeRenders = false } = await req.json().catch(() => ({}));

    const stocksDir = path.join(process.cwd(), "stocks");
    const rendersDir = path.join(process.cwd(), "public", "renders");

    const userStockPrefix = `stock-${userId}`;
    let deleted = 0, savedBytes = 0;

    // Delete user's stock files
    if (fs.existsSync(stocksDir)) {
      for (const f of fs.readdirSync(stocksDir)) {
        if (!f.startsWith(userStockPrefix)) continue;
        try {
          const fp = path.join(stocksDir, f);
          const s = fs.statSync(fp);
          fs.unlinkSync(fp);
          deleted++;
          savedBytes += s.size;
        } catch {}
      }
    }

    // Optionally delete non-gallery renders
    if (includeRenders && fs.existsSync(rendersDir)) {
      const galleryVideos = await prisma.video.findMany({ where: { userId }, select: { videoUrl: true, audioUrl: true } });
      const protectedNames = new Set<string>();
      for (const v of galleryVideos) {
        if (v.videoUrl) protectedNames.add(path.basename(v.videoUrl));
        if (v.audioUrl) protectedNames.add(path.basename(v.audioUrl));
      }
      for (const f of fs.readdirSync(rendersDir)) {
        if (protectedNames.has(f)) continue;
        try {
          const fp = path.join(rendersDir, f);
          const s = fs.statSync(fp);
          if (!s.isFile()) continue;
          fs.unlinkSync(fp);
          deleted++;
          savedBytes += s.size;
        } catch {}
      }
    }

    console.log(`[admin/cache] cleared userId=${userId} deleted=${deleted} saved=${Math.round(savedBytes / 1024 / 1024)}MB`);
    return NextResponse.json({
      deleted,
      savedMb: Math.round(savedBytes / 1024 / 1024 * 10) / 10,
      message: `ลบ ${deleted} ไฟล์ ประหยัด ${Math.round(savedBytes / 1024 / 1024 * 10) / 10} MB`,
    });
  } catch (error) {
    return apiError({ route: "DELETE admin/users/[id]/cache", error });
  }
}
