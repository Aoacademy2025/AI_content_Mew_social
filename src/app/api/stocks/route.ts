import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";

const STOCKS_DIR = path.join(process.cwd(), "stocks");

function userPrefix(userId: string) {
  return `stock-${userId}-`;
}

function isUserStock(filename: string, userId: string) {
  return filename.startsWith(userPrefix(userId)) && filename.endsWith(".mp4");
}

/** GET /api/stocks — returns size and count of THIS user's stock cache only */
export async function GET() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = authUser.id;

  if (!fs.existsSync(STOCKS_DIR)) return NextResponse.json({ count: 0, sizeMb: 0 });

  const files = fs.readdirSync(STOCKS_DIR).filter(f => isUserStock(f, userId));
  const totalBytes = files.reduce((sum, f) => {
    try { return sum + fs.statSync(path.join(STOCKS_DIR, f)).size; } catch { return sum; }
  }, 0);

  return NextResponse.json({ count: files.length, sizeMb: Math.round(totalBytes / 1024 / 1024) });
}

/** DELETE /api/stocks — delete only THIS user's stock cache files */
export async function DELETE() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = authUser.id;

  if (!fs.existsSync(STOCKS_DIR)) return NextResponse.json({ deleted: 0, sizeMb: 0 });

  const files = fs.readdirSync(STOCKS_DIR).filter(f => isUserStock(f, userId));
  let deleted = 0;
  let freedBytes = 0;
  for (const f of files) {
    const fp = path.join(STOCKS_DIR, f);
    try {
      freedBytes += fs.statSync(fp).size;
      fs.unlinkSync(fp);
      deleted++;
    } catch {}
  }

  return NextResponse.json({ deleted, sizeMb: Math.round(freedBytes / 1024 / 1024) });
}
