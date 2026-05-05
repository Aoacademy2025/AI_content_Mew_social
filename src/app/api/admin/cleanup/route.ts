import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export const maxDuration = 120;
export const runtime = "nodejs";

function getDirSizeMb(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, f)).size; } catch {}
  }
  return Math.round(total / 1024 / 1024);
}

function scanTmp(): { sizeMb: number; count: number } {
  const patterns = ["remotion-webpack-bundle-", "react-motion-render", "puppeteer_dev_chrome_profile-"];
  let sizeMb = 0, count = 0;
  try {
    for (const entry of fs.readdirSync("/tmp")) {
      if (!patterns.some(p => entry.startsWith(p))) continue;
      try {
        const fp = `/tmp/${entry}`;
        const out = execSync(`du -sb "${fp}" 2>/dev/null || echo 0`, { timeout: 5000 }).toString().trim();
        const bytes = parseInt(out.split("\t")[0] ?? "0", 10);
        if (!isNaN(bytes)) sizeMb += bytes / 1024 / 1024;
        count++;
      } catch {}
    }
  } catch {}
  return { sizeMb: Math.round(sizeMb), count };
}

// GET — รายงานขนาดไฟล์ก่อนลบ
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (user?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rendersDir = path.join(process.cwd(), "public", "renders");
  const stocksDir  = path.join(process.cwd(), "stocks");

  // Gallery URLs ที่ใช้งานอยู่ — ห้ามลบ
  const galleryVideos = await prisma.video.findMany({ select: { videoUrl: true, audioUrl: true } });
  const protectedPaths = new Set<string>();
  for (const v of galleryVideos) {
    if (v.videoUrl) protectedPaths.add(path.basename(v.videoUrl));
    if (v.audioUrl) protectedPaths.add(path.basename(v.audioUrl));
  }

  function scanDir(dir: string, olderThanDays: number, safe = false) {
    if (!fs.existsSync(dir)) return { count: 0, sizeMb: 0 };
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let count = 0, sizeBytes = 0;
    for (const f of fs.readdirSync(dir)) {
      if (safe && protectedPaths.has(f)) continue;
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.mtimeMs < cutoff) { count++; sizeBytes += stat.size; }
      } catch {}
    }
    return { count, sizeMb: Math.round(sizeBytes / 1024 / 1024) };
  }

  const totalRenders = { count: 0, sizeMb: getDirSizeMb(rendersDir) };
  if (fs.existsSync(rendersDir)) totalRenders.count = fs.readdirSync(rendersDir).length;

  return NextResponse.json({
    renders: {
      total: totalRenders,
      older1d: scanDir(rendersDir, 1, true),
      older3d: scanDir(rendersDir, 3, true),
      older7d: scanDir(rendersDir, 7, true),
    },
    stocks: { older1d: scanDir(stocksDir, 1) },
    tmp: scanTmp(),
    protectedCount: protectedPaths.size,
  });
}

// DELETE — ลบจริง
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (user?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const {
    olderThanDays = 3,
    includeStocks = false,
    includeTmp = false,
  }: { olderThanDays?: number; includeStocks?: boolean; includeTmp?: boolean } =
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
  let skipped = 0;

  function cleanDir(dir: string, useProtected = false) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (useProtected && protectedPaths.has(f)) { skipped++; continue; }
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

  cleanDir(rendersDir, true);
  if (includeStocks) cleanDir(stocksDir);

  // ลบ /tmp Remotion + react-motion + puppeteer
  let tmpDeleted = 0, tmpSavedMb = 0;
  if (includeTmp) {
    const patterns = ["remotion-webpack-bundle-", "react-motion-render", "puppeteer_dev_chrome_profile-"];
    try {
      for (const entry of fs.readdirSync("/tmp")) {
        if (!patterns.some(p => entry.startsWith(p))) continue;
        try {
          const fp = `/tmp/${entry}`;
          const out = execSync(`du -sb "${fp}" 2>/dev/null || echo 0`, { timeout: 5000 }).toString().trim();
          const bytes = parseInt(out.split("\t")[0] ?? "0", 10);
          execSync(`rm -rf "${fp}"`, { timeout: 30000 });
          if (!isNaN(bytes)) tmpSavedMb += bytes / 1024 / 1024;
          tmpDeleted++;
        } catch {}
      }
    } catch {}
  }

  const totalSaved = Math.round(savedMb + tmpSavedMb);
  console.log(`[admin/cleanup] renders=${deleted} tmp=${tmpDeleted} saved=${totalSaved}MB skipped=${skipped}`);

  return NextResponse.json({
    deleted: deleted + tmpDeleted,
    savedMb: totalSaved,
    skipped,
    message: `ลบ ${deleted + tmpDeleted} รายการ ประหยัด ${totalSaved} MB${skipped ? ` (ข้าม ${skipped} ไฟล์ใน Gallery)` : ""}`,
  });
}
