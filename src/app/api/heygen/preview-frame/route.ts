import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const maxDuration = 120;
export const runtime = "nodejs";

function getFfmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}

async function downloadFile(url: string, dest: string, heygenKey?: string) {
  if (url.startsWith("/")) {
    const src = path.join(process.cwd(), "public", url);
    if (!fs.existsSync(src)) throw new Error(`Local file not found: ${url}`);
    fs.copyFileSync(src, dest);
    return;
  }
  const headers: Record<string, string> = { Accept: "video/mp4,video/*,*/*" };
  if (heygenKey && url.includes("heygen.ai")) headers["X-Api-Key"] = heygenKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// POST /api/heygen/preview-frame
// Body: same as /api/heygen/composite
// Returns: { imageUrl } — single JPEG frame of the composite (fast, for position verification)
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { avatarVideoUrl, bgVideoUrl, overlayX = 0, overlayY = 0, overlayW, avatarCrop } = body ?? {};
  if (!avatarVideoUrl || !bgVideoUrl) return NextResponse.json({ error: "avatarVideoUrl and bgVideoUrl required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { heygenKey: true } });
  const heygenKey = user?.heygenKey ? Buffer.from(user.heygenKey, "base64").toString("utf-8") : undefined;

  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });

  const ts = Date.now();
  const avatarTmp = path.join(rendersDir, `pf-avatar-${ts}.mp4`);
  const bgTmp = path.join(rendersDir, `pf-bg-${ts}.mp4`);
  const outPath = path.join(rendersDir, `preview-${ts}.jpg`);

  try {
    await Promise.all([
      downloadFile(avatarVideoUrl, avatarTmp, heygenKey),
      downloadFile(bgVideoUrl, bgTmp, heygenKey),
    ]);

    const crop = avatarCrop ?? { left: 0, right: 0, top: 0, bottom: 0 };
    const hasCrop = crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0;
    const cropPart = hasCrop
      ? `,crop=floor(iw*(${100 - crop.left - crop.right})/200)*2:floor(ih*(${100 - crop.top - crop.bottom})/200)*2:iw*${crop.left}/100:ih*${crop.top}/100`
      : "";

    const scaleAndCrop = overlayW
      ? `scale=${overlayW}:-2${cropPart}`
      : `scale=iw:ih${cropPart}`;

    const filter = [
      `[1:v]${scaleAndCrop}[av]`,
      "[av]colorkey=color=0x00FF00:similarity=0.05:blend=0.0[ck]",
      `[0:v][ck]overlay=${overlayX}:${overlayY}[out]`,
    ].join(";");

    const ffmpeg = getFfmpegPath();
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        "-ss", "0.5", "-i", bgTmp,
        "-ss", "0.5", "-i", avatarTmp,
        "-filter_complex", filter,
        "-map", "[out]",
        "-vframes", "1",
        "-q:v", "2",
        outPath,
      ];
      execFile(ffmpeg, args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (stderr) console.log("[preview-frame] ffmpeg:", stderr.slice(-600));
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });

    return NextResponse.json({ imageUrl: `/renders/preview-${ts}.jpg` });
  } catch (err) {
    console.error("[preview-frame]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  } finally {
    if (fs.existsSync(avatarTmp)) fs.unlinkSync(avatarTmp);
    if (fs.existsSync(bgTmp)) fs.unlinkSync(bgTmp);
  }
}
