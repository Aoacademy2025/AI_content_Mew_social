import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";

const STOCKS_DIR = path.join(process.cwd(), "stocks");

// Only files starting with "stock-" are considered cache (not avatar uploads etc.)
function isStockCache(filename: string) {
  return filename.startsWith("stock-") && filename.endsWith(".mp4");
}

/** GET /api/stocks — returns total size and file count of stock cache only */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!fs.existsSync(STOCKS_DIR)) return NextResponse.json({ count: 0, sizeMb: 0 });

  const files = fs.readdirSync(STOCKS_DIR).filter(isStockCache);
  const totalBytes = files.reduce((sum, f) => {
    try { return sum + fs.statSync(path.join(STOCKS_DIR, f)).size; } catch { return sum; }
  }, 0);

  return NextResponse.json({ count: files.length, sizeMb: Math.round(totalBytes / 1024 / 1024) });
}

/** DELETE /api/stocks — delete only stock cache files (stock-*.mp4), never avatar uploads */
export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!fs.existsSync(STOCKS_DIR)) return NextResponse.json({ deleted: 0, sizeMb: 0 });

  const files = fs.readdirSync(STOCKS_DIR).filter(isStockCache);
  let deleted = 0;
  let freedBytes = 0;
  for (const f of files) {
    const fp = path.join(STOCKS_DIR, f);
    try {
      const size = fs.statSync(fp).size;
      fs.unlinkSync(fp);
      freedBytes += size;
      deleted++;
    } catch {}
  }

  return NextResponse.json({ deleted, sizeMb: Math.round(freedBytes / 1024 / 1024) });
}
