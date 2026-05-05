import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import path from "path";
import fs from "fs";

import { authOptions } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const progressFile = path.join("/tmp", `render-progress-${session.user.id}.json`);
  try {
    const raw = await fs.promises.readFile(progressFile, "utf-8");
    const parsed = JSON.parse(raw) as { progress?: number };
    const progress = Number(parsed?.progress);
    return NextResponse.json({ progress: Number.isFinite(progress) ? progress : 0 });
  } catch {
    return NextResponse.json({ progress: 0 });
  }
}
