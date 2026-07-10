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

/** DELETE /api/stocks — direct deletion is gated by the reviewed media lifecycle. */
export async function DELETE() {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    error: "media_lifecycle_managed",
    message: "การลบไฟล์สื่อโดยตรงถูกปิดไว้ โปรดใช้ Media Retention reference graph และ quarantine workflow ที่ผ่านการตรวจสอบ",
    deleted: 0,
    sizeMb: 0,
  }, { status: 409 });
}
