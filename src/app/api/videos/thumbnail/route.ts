import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { resolveGeminiKey, KeyRequiredError } from "@/lib/gemini-key";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";

export const maxDuration = 120;
export const runtime = "nodejs";

async function getFfmpegPath(): Promise<string> {
  try {
    const installer = await import(
      /* webpackIgnore: true */ "@ffmpeg-installer/ffmpeg" as string
    );
    return installer.default?.path ?? installer.path ?? "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

/** Capture a single frame from video at given second */
async function captureFrame(videoPath: string, atSec: number, outPath: string): Promise<void> {
  const ffmpegPath = await getFfmpegPath();
  return new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-ss", String(atSec), "-i", videoPath, "-frames:v", "1", "-q:v", "2", "-y", outPath],
      { timeout: 30000 },
      (error, _stdout, stderr) => {
        if (error) {
          console.error("[thumbnail] ffmpeg stderr:", stderr);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });
}

interface TextLayer {
  text: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  yPercent: number;
  fontFamily?: string;
}

/** Use Sharp to overlay text layers on captured frame */
async function renderWithTextLayers(
  imagePath: string,
  outPath: string,
  textLayers: TextLayer[],
): Promise<void> {
  const sharp = (await import(/* webpackIgnore: true */ "sharp" as string)).default;

  const img = sharp(imagePath);
  const meta = await img.metadata();
  const w = meta.width ?? 1080;
  const h = meta.height ?? 1920;

  const escapeXml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
     .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

  let svgText = "";
  const centerX = w / 2;

  for (const layer of textLayers) {
    if (!layer.text.trim()) continue;
    const y = Math.round((layer.yPercent / 100) * h);
    const sw = Math.max(1, layer.strokeWidth * 2);

    const fontFam = layer.fontFamily ?? "Arial, sans-serif";
    svgText += `
      <text x="${centerX}" y="${y}" text-anchor="middle" dominant-baseline="middle"
        font-family="${escapeXml(fontFam)}" font-weight="${layer.fontWeight}" font-size="${layer.fontSize}"
        stroke="${escapeXml(layer.strokeColor)}" stroke-width="${sw}" stroke-linejoin="round"
        fill="${escapeXml(layer.color)}" paint-order="stroke">${escapeXml(layer.text)}</text>`;
  }

  // Dark gradient overlay at bottom for readability
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="grad" x1="0" y1="0.45" x2="0" y2="1">
        <stop offset="0%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.7"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${Math.round(h * 0.45)}" width="${w}" height="${Math.round(h * 0.55)}" fill="url(#grad)"/>
    ${svgText}
  </svg>`;

  await sharp(imagePath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outPath);
}

interface SuggestResult {
  line: string;
  line2?: string;
  style?: string; // preset id: tiktok, neon, fire, cinema, bold, highlight, pink, blue
  line1Color?: string;
  line2Color?: string;
}

function getCaptionsList(script: string, captions: string[]): string[] {
  return captions.length > 0
    ? captions
    : script.split(/[.\n]+/).filter((s: string) => s.trim().length > 3).slice(0, 15);
}

const STYLE_GUIDE = `STYLE PRESETS — pick the one that best matches the mood:
"tiktok" | "bold" | "neon" | "fire" | "cinema" | "highlight" | "pink" | "blue"`;

const JSON_SCHEMA = `Output ONLY valid JSON, no markdown, no explanation:
{"line":"<main hook 4-6 words>","line2":"<supporting 3-5 words or empty>","style":"<preset>","line1Color":"<#hex>","line2Color":"<#hex>"}`;

function buildGeminiPrompt(script: string, captions: string[]): string {
  const topic = script.slice(0, 500) || captions.slice(0, 5).join(" ");
  return `คุณคือนักเขียน thumbnail viral มืออาชีพ ห้ามคัดลอกประโยคจาก script มาใส่ตรงๆ

เนื้อหาของวิดีโอ:
"${topic}"

สร้างข้อความ thumbnail ใหม่ที่ทำให้คนอยากกดดูทันที โดย:
- คิด hook ใหม่ที่กระแทกใจ ไม่ใช่คัดลอกประโยคจากวิดีโอ
- ใช้สูตร: ช็อค / ความอยากรู้ / ตัวเลข / ท้าทาย / ขัดแย้ง
- ภาษาเดียวกับเนื้อหา (ไทย→ไทย, ผสม Eng ได้เพื่อ impact)
- line: hook หลัก 3-5 คำ สั้นกระแทก
- line2: เสริม 2-4 คำ หรือ "" ถ้าไม่จำเป็น
- เลือก style และสีที่ pop บน background มืด

${STYLE_GUIDE}

${JSON_SCHEMA}`;
}

function parseJsonResult(text: string, fallback: string): SuggestResult {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match?.[0] ?? "{}");
  } catch {
    return { line: fallback };
  }
}

async function suggestWithGemini(script: string, captions: string[], geminiKey: string): Promise<SuggestResult> {
  const { geminiGenerateText } = await import("@/lib/gemini");
  const prompt = buildGeminiPrompt(script, captions);
  const text = await geminiGenerateText(geminiKey, prompt, 512, 1.0);
  return parseJsonResult(text, "");
}

/**
 * POST /api/videos/thumbnail
 * Body: { videoId, videoUrl?, mode?: "render" | "suggest", seekTime?, textLayers? }
 *
 * mode="suggest" → AI suggests text (returns { line, line2 })
 * mode="render"  → Capture frame + overlay text layers → save thumbnail
 * no mode        → Legacy: capture frame + auto-text (backward compat)
 */
export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { videoId, videoUrl: bodyVideoUrl, mode, seekTime, textLayers } = body;

    // Get video record from DB
    let video: {
      videoUrl: string | null;
      avatarVideoUrl: string | null;
      script: string | null;
      renderConfig: string | null;
      thumbnailConfig: string | null;
    } | null = null;
    if (videoId) {
      // Use raw query to access thumbnailConfig without needing prisma generate.
      // Scope by userId so a caller can only read their OWN video (prevents IDOR).
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT videoUrl, avatarVideoUrl, script, renderConfig, thumbnailConfig FROM Video WHERE id = ? AND userId = ?`,
        videoId,
        authUser.id,
      )) as Array<{
        videoUrl: string | null;
        avatarVideoUrl: string | null;
        script: string | null;
        renderConfig: string | null;
        thumbnailConfig: string | null;
      }>;
      video = rows[0] ?? null;
      if (!video)
        return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const videoSrc = bodyVideoUrl || video?.videoUrl || video?.avatarVideoUrl;
    const script = video?.script ?? "";

    // ── MODE: load (return saved thumbnailConfig) ──
    if (mode === "load") {
      if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
      let config = null;
      if (video.thumbnailConfig) {
        try { config = JSON.parse(video.thumbnailConfig); } catch { /* ignore */ }
      }
      return NextResponse.json({ config });
    }

    // ── MODE: suggest ──
    if (mode === "suggest") {
      // Require an OWNED video — closes the no-resource loop-burn vector: without
      // this a caller could POST {mode:"suggest"} with no videoId and spend server
      // Gemini in a loop (videoId reads are already userId-scoped above = IDOR-safe).
      if (!video) return NextResponse.json({ error: "videoId required" }, { status: 400 });
      const user = await prisma.user.findUnique({
        where: { id: authUser.id },
        select: { geminiKey: true, plan: true },
      });
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      let geminiKey: string;
      let geminiMode: "managed" | "byok";
      try {
        const resolved = resolveGeminiKey(user);
        geminiKey = resolved.key;
        geminiMode = resolved.mode;
      } catch (e) {
        if (e instanceof KeyRequiredError) {
          return NextResponse.json({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }, { status: 409 });
        }
        throw e;
      }

      // L4 input cap + H1 managed-Gemini text-call ceiling (BYOK → no-op, byte-identical).
      // Without these a caller could loop suggest on an owned videoId to burn the server key.
      const capCheck = checkAiInputCaps({ script });
      if (!capCheck.ok) return NextResponse.json({ error: capCheck.message }, { status: 400 });
      const textReserve = await reserveAiTextCall(authUser.id, { enforce: geminiMode === "managed" });
      if (!textReserve.allowed) {
        return NextResponse.json({ code: "QUOTA_AI_TEXT", message: textReserve.message }, { status: 429 });
      }

      // Extract captions from renderConfig
      const captions: string[] = [];
      if (video?.renderConfig) {
        try {
          const cfg = typeof video.renderConfig === "string"
            ? JSON.parse(video.renderConfig) : video.renderConfig;
          for (const kp of (cfg?.keywordPopups ?? [])) {
            if (kp.text?.trim()) captions.push(kp.text.trim());
          }
        } catch { /* ignore */ }
      }

      const fallback = captions[0] ?? script.split(/[.\n]+/).find(s => s.trim().length > 3) ?? "";

      let result: SuggestResult;
      try {
        result = await suggestWithGemini(script, captions, geminiKey);
      } catch {
        result = { line: fallback };
      }

      if (!result.line) result.line = fallback;
      return NextResponse.json(result);
    }

    // ── MODE: render (or legacy) ──
    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    const atSec = seekTime ?? 0;
    const filename = `thumb-${Date.now()}.jpg`;
    const outPath = path.join(rendersDir, filename);

    // Prefer stock video (no subtitles) from renderConfig, fallback to rendered video
    let sourceVideoSrc: string | null = null;
    if (video?.renderConfig) {
      try {
        const cfg = typeof video.renderConfig === "string"
          ? JSON.parse(video.renderConfig) : video.renderConfig;
        const firstSrc = cfg?.bgVideos?.[0]?.src ?? null;
        if (firstSrc) {
          // bgVideos src may be /renders/stock-xxx.mp4 or /api/stocks/xxx.mp4
          const localPath = firstSrc.startsWith("/api/stocks/")
            ? path.join(process.cwd(), "stocks", firstSrc.slice("/api/stocks/".length))
            : firstSrc.startsWith("/")
              ? path.join(process.cwd(), "public", firstSrc.replace(/^\/api\/renders\//, "/renders/"))
              : null;
          if (localPath && fs.existsSync(localPath)) {
            sourceVideoSrc = localPath;
          }
        }
      } catch { /* ignore */ }
    }

    // Fallback to rendered video
    if (!sourceVideoSrc) {
      if (!videoSrc)
        return NextResponse.json({ error: "No video URL available" }, { status: 400 });
      const isRemote = /^https?:\/\//i.test(videoSrc);
      const p = videoSrc.startsWith("/") ? path.join(process.cwd(), "public", videoSrc.replace(/^\/api\/renders\//, "/renders/")) : videoSrc;
      if (videoSrc.startsWith("/")) {
        // Contain local webroot paths so a "/../.." can't escape public/ into .env / prisma/dev.db.
        const publicDir = path.resolve(process.cwd(), "public");
        if (path.resolve(p) !== publicDir && !path.resolve(p).startsWith(publicDir + path.sep))
          return NextResponse.json({ error: "Invalid video URL" }, { status: 400 });
      }
      if (!isRemote && !fs.existsSync(p))
        return NextResponse.json({ error: "Video file not found" }, { status: 404 });
      sourceVideoSrc = p;
    }

    // Capture frame via ffmpeg. A remote URL is handed to ffmpeg -i (which fetches it) → SSRF-guard
    // so it can't reach internal/private hosts.
    if (/^https?:\/\//i.test(sourceVideoSrc!)) {
      try { await assertSafeFetchUrl(sourceVideoSrc!); }
      catch { return NextResponse.json({ error: "URL ไม่ปลอดภัยหรือไม่รองรับ" }, { status: 400 }); }
    }
    const framePath = path.join(rendersDir, `thumb-frame-${Date.now()}.jpg`);
    await captureFrame(sourceVideoSrc!, atSec, framePath);

    // Overlay text layers (Sharp) or just use the frame
    if (mode === "render" && Array.isArray(textLayers) && textLayers.length > 0) {
      await renderWithTextLayers(framePath, outPath, textLayers);
      try { fs.unlinkSync(framePath); } catch { /* ignore */ }
    } else {
      fs.renameSync(framePath, outPath);
    }

    const thumbnailUrl = `/api/renders/${filename}`;

    // Save to DB (thumbnail URL + editor config for re-editing)
    if (videoId) {
      const thumbConfig = mode === "render" && textLayers
        ? JSON.stringify({ seekTime: atSec, textLayers })
        : null;
      // Use raw query to write thumbnailConfig without needing prisma generate.
      // Scope by userId so a caller can only write their OWN video (prevents IDOR).
      await prisma.$executeRawUnsafe(
        `UPDATE Video SET thumbnail = ?, thumbnailConfig = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
        thumbnailUrl,
        thumbConfig,
        videoId,
        authUser.id,
      ).catch(() => {});
    }

    return NextResponse.json({ thumbnailUrl });
  } catch (error) {
    console.error("[thumbnail] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
