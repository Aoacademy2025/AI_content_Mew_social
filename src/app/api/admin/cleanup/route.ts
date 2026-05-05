import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";

export const maxDuration = 120;
export const runtime = "nodejs";

// GET — รายงานขนาดไฟล์ก่อนลบ
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (user?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rendersDir = path.join(process.cwd(), "public", "renders");
  const stocksDir  = path.join(process.cwd(), "stocks");

  function scanDir(dir: string, olderThanDays: number) {
    if (!fs.existsSync(dir)) return { count: 0, sizeMb: 0 };
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let count = 0, sizeBytes = 0;
    for (const f of fs.readdirSync(dir)) {
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          count++;
          sizeBytes += stat.size;
        }
      } catch {}
    }
    return { count, sizeMb: Math.round(sizeBytes / 1024 / 1024) };
  }

  // Gallery URLs ที่ใช้งานอยู่ — ห้ามลบ
  const galleryVideos = await prisma.video.findMany({ select: { videoUrl: true, audioUrl: true } });
  const protectedPaths = new Set<string>();
  for (const v of galleryVideos) {
    if (v.videoUrl) protectedPaths.add(path.basename(v.videoUrl));
    if (v.audioUrl) protectedPaths.add(path.basename(v.audioUrl));
  }

  // นับไฟล์ที่ลบได้จริง (ไม่ใช่ gallery)
  function scanDirSafe(dir: string, olderThanDays: number) {
    if (!fs.existsSync(dir)) return { count: 0, sizeMb: 0 };
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let count = 0, sizeBytes = 0;
    for (const f of fs.readdirSync(dir)) {
      if (protectedPaths.has(f)) continue;
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          count++;
          sizeBytes += stat.size;
        }
      } catch {}
    }
    return { count, sizeMb: Math.round(sizeBytes / 1024 / 1024) };
  }

  const renders1d  = scanDirSafe(rendersDir, 1);
  const renders3d  = scanDirSafe(rendersDir, 3);
  const renders7d  = scanDirSafe(rendersDir, 7);
  const stocks1d   = scanDir(stocksDir, 1);
  const totalRenders = (() => {
    if (!fs.existsSync(rendersDir)) return { count: 0, sizeMb: 0 };
    let count = 0, sizeBytes = 0;
    for (const f of fs.readdirSync(rendersDir)) {
      try { const stat = fs.statSync(path.join(rendersDir, f)); if (stat.isFile()) { count++; sizeBytes += stat.size; } } catch {}
    }
    return { count, sizeMb: Math.round(sizeBytes / 1024 / 1024) };
  })();

  return NextResponse.json({
    renders: { total: totalRenders, older1d: renders1d, older3d: renders3d, older7d: renders7d },
    stocks: { older1d: stocks1d },
    protectedCount: protectedPaths.size,
  });
}

// DELETE — ลบจริง
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (user?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { olderThanDays = 3, includeStocks = false }: { olderThanDays?: number; includeStocks?: boolean } =
    await req.json().catch(() => ({}));

  const rendersDir = path.join(process.cwd(), "public", "renders");
  const stocksDir  = path.join(process.cwd(), "stocks");

  // Gallery URLs — ห้ามลบเด็ดขาด
  const galleryVideos = await prisma.video.findMany({ select: { videoUrl: true, audioUrl: true } });
  const protectedPaths = new Set<string>();
  for (const v of galleryVideos) {
    if (v.videoUrl) protectedPaths.add(path.basename(v.videoUrl));
    if (v.audioUrl) protectedPaths.add(path.basename(v.audioUrl));
  }

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let savedMb = 0;
  const skipped: string[] = [];

  function cleanDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (protectedPaths.has(f)) { skipped.push(f); continue; }
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          savedMb += stat.size / 1024 / 1024;
          fs.unlinkSync(fp);
          deleted++;
        }
      } catch {}
    }
  }

  cleanDir(rendersDir);
  if (includeStocks) cleanDir(stocksDir);

  console.log(`[admin/cleanup] deleted=${deleted} saved=${savedMb.toFixed(1)}MB skipped=${skipped.length} gallery files`);

  return NextResponse.json({
    deleted,
    savedMb: Math.round(savedMb),
    skipped: skipped.length,
    message: `ลบ ${deleted} ไฟล์ ประหยัด ${Math.round(savedMb)} MB (ข้าม ${skipped.length} ไฟล์ใน Gallery)`,
  });
}
