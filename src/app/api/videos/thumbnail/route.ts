import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";

export const maxDuration = 120;
export const runtime = "nodejs";

function decrypt(k: string) {
  return Buffer.from(k, "base64").toString("utf-8");
}

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

function buildOpenAIPrompt(script: string, captions: string[]): string {
  const topic = script.slice(0, 600) || captions.slice(0, 5).join(" ");
  return `You are a viral thumbnail copywriter for TikTok/YouTube Shorts. NEVER copy sentences directly from the script.

VIDEO TOPIC: "${topic}"

Create NEW thumbnail text that makes viewers instantly click. Rules:
- Invent a fresh hook — do NOT paste script lines verbatim
- Use: SHOCK / CURIOSITY GAP / NUMBER / CHALLENGE / CONTROVERSY
- Match script language (Thai script → Thai text, English mixing OK for impact)
- line: main hook, 3-5 words, punchy
- line2: supporting 2-4 words, or "" if not needed
- Pick style + colors that POP on dark backgrounds

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

async function suggestWithOpenAI(script: string, captions: string[], openaiKey: string): Promise<SuggestResult> {
  const prompt = buildOpenAIPrompt(script, captions);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.9,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
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
    const session = await getServerSession(authOptions);
    if (!session?.user?.id)
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
      // Use raw query to access thumbnailConfig without needing prisma generate
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT videoUrl, avatarVideoUrl, script, renderConfig, thumbnailConfig FROM Video WHERE id = ?`,
        videoId,
      )) as Array<{
        videoUrl: string | null;
        avatarVideoUrl: string | null;
        script: string | null;
        renderConfig: string | null;
        thumbnailConfig: string | null;
      }>;
      video = rows[0] ?? null;
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
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { geminiKey: true, openaiKey: true },
      });
      const geminiKey = user?.geminiKey ? decrypt(user.geminiKey) : null;
      const openaiKey = user?.openaiKey ? decrypt(user.openaiKey) : (process.env.SERVER_OPENAI_API_KEY || null);

      if (!geminiKey && !openaiKey) {
        return NextResponse.json({ error: "Gemini หรือ OpenAI key ยังไม่ได้ตั้งค่า — ไปที่ Settings > API Keys", missingKey: "gemini" }, { status: 400 });
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
      if (geminiKey) {
        try {
          result = await suggestWithGemini(script, captions, geminiKey);
        } catch {
          if (openaiKey) result = await suggestWithOpenAI(script, captions, openaiKey);
          else result = { line: fallback };
        }
      } else {
        result = await suggestWithOpenAI(script, captions, openaiKey!);
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
      const p = videoSrc.startsWith("/") ? path.join(process.cwd(), "public", videoSrc.replace(/^\/api\/renders\//, "/renders/")) : videoSrc;
      if (!videoSrc.startsWith("http") && !fs.existsSync(p))
        return NextResponse.json({ error: "Video file not found" }, { status: 404 });
      sourceVideoSrc = p;
    }

    // Capture frame via ffmpeg
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
      // Use raw query to write thumbnailConfig without needing prisma generate
      await prisma.$executeRawUnsafe(
        `UPDATE Video SET thumbnail = ?, thumbnailConfig = ?, updatedAt = datetime('now') WHERE id = ?`,
        thumbnailUrl,
        thumbConfig,
        videoId,
      ).catch(() => {});
    }

    return NextResponse.json({ thumbnailUrl });
  } catch (error) {
    console.error("[thumbnail] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
