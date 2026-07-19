import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import {
  lowResPreviewFilenamesForRender,
  renderFilenameFromVideoUrl,
} from "@/lib/low-res-preview-paths";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

function protectRenderName(set: Set<string>, url: string | null) {
  if (!url) return;
  const filename = renderFilenameFromVideoUrl(url) ?? path.basename(url);
  set.add(filename);
  for (const previewFilename of lowResPreviewFilenamesForRender(filename)) set.add(previewFilename);
}

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
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!authUser || authUser.role !== "ADMIN")
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
      protectRenderName(protectedNames, v.videoUrl);
      protectRenderName(protectedNames, v.audioUrl);
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

// DELETE — compatibility endpoint, intentionally fail-closed. Stock and render
// media may still have live graph owners and cannot be deleted from this tool.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!authUser || authUser.role !== "ADMIN")
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    return NextResponse.json({
      error: "media_lifecycle_managed",
      message: "Customer media cleanup requires a reviewed graph/quarantine manifest.",
    }, { status: 409 });
  } catch (error) {
    return apiError({ route: "DELETE admin/users/[id]/cache", error });
  }
}
