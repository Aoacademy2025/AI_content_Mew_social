import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { resolveChromaParams, detectChromaColor, buildKeyChain, featherSupported } from "@/lib/chroma-key";
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
    const src = path.join(process.cwd(), "public", url.replace(/^\/api\/renders\//, "/renders/"));
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
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const {
    avatarVideoUrl, bgVideoUrl, overlayX = 0, overlayY = 0, overlayW, avatarCrop,
    chromaColor, chromaSimilarity, chromaBlend,
  } = body ?? {};
  if (!avatarVideoUrl || !bgVideoUrl) return NextResponse.json({ error: "avatarVideoUrl and bgVideoUrl required" }, { status: 400 });

  // Sanitize geometry — these values become ffmpeg args (injection surface).
  const num = (v: unknown, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
  const clampPct = (v: unknown) => Math.min(100, Math.max(0, num(v, 0)));
  const ovX = Math.round(num(overlayX));
  const ovY = Math.round(num(overlayY));
  const ovW = overlayW != null && Number.isFinite(Number(overlayW)) ? Math.max(2, Math.round(Number(overlayW))) : null;

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
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

    const cl = clampPct(avatarCrop?.left), cr = clampPct(avatarCrop?.right);
    const ct = clampPct(avatarCrop?.top), cb = clampPct(avatarCrop?.bottom);
    const hasCrop = cl > 0 || cr > 0 || ct > 0 || cb > 0;
    const cropPart = hasCrop
      ? `,crop=floor(iw*(${100 - cl - cr})/200)*2:floor(ih*(${100 - ct - cb})/200)*2:iw*${cl}/100:ih*${ct}/100`
      : "";

    const scaleAndCrop = ovW
      ? `scale=${ovW}:-2${cropPart}`
      : `scale=iw:ih${cropPart}`;

    const ffmpeg = getFfmpegPath();

    // WYSIWYG: use the SAME detection + key chain as the render composite (lib/chroma-key) so the
    // editor preview matches the final output. Auto-detects the green shade unless sliders are tuned.
    const resolved = resolveChromaParams({ chromaColor, chromaSimilarity, chromaBlend });
    const keyColor = resolved.autoDetect ? await detectChromaColor(avatarTmp, ffmpeg) : resolved.color;
    // Not every ffmpeg build ships erosion/gblur (dev=darwin-arm64, prod=linux-x64 peer build) — the
    // keying path isn't fail-open, so resolve BEFORE building the filter. Cached per-process.
    const feather = await featherSupported(ffmpeg);
    const keyChain = buildKeyChain({ color: keyColor, similarity: resolved.similarity, blend: resolved.blend }, feather);

    const filter = [
      `[1:v]${scaleAndCrop},${keyChain}[ck]`,
      `[0:v][ck]overlay=${ovX}:${ovY}[out]`,
    ].join(";");
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
      // 30 min bound — see composite/route.ts FFMPEG_TIMEOUT_MS; this is a single-frame extraction
      // so it's normally fast, but a hung ffmpeg process should never wedge the request forever.
      execFile(ffmpeg, args, { maxBuffer: 50 * 1024 * 1024, timeout: 30 * 60 * 1000 }, (err, _stdout, stderr) => {
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
