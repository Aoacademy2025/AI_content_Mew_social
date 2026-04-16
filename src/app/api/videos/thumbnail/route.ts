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

/** Ask OpenAI to create viral thumbnail text + style */
async function suggestText(
  script: string,
  captions: string[],
  apiKey: string,
): Promise<SuggestResult> {
  const captionsList = captions.length > 0
    ? captions
    : script.split(/[.\n]+/).filter((s: string) => s.trim().length > 3).slice(0, 15);

  const prompt = `You are the world's #1 viral thumbnail copywriter. Your thumbnails get 3x higher CTR than average.

SCRIPT:
"${script.slice(0, 800)}"

AVAILABLE LINES FROM VIDEO:
${captionsList.map((c, i) => `${i + 1}. ${c}`).join("\n")}

CREATE the ultimate clickbait thumbnail text. You can:
- Pick from available lines OR rewrite them to be more shocking
- Create completely NEW text that captures the video's hook
- Mix Thai + English if the script is Thai (e.g. "สิ่งที่คุณไม่เคยรู้!" or "5 เรื่องช็อค!")

VIRAL THUMBNAIL FORMULAS (use one):
1. SHOCK: "คนส่วนใหญ่ไม่รู้..." / "ห้ามทำแบบนี้!"
2. CURIOSITY GAP: "สิ่งที่เกิดขึ้นคือ..." / "ผลลัพธ์น่าตกใจ"
3. NUMBER HOOK: "5 สิ่งที่..." / "3 ความลับ..."
4. CHALLENGE: "ลองแล้วช็อค!" / "ไม่เชื่อก็ต้องเชื่อ"
5. EMOTION: extreme joy, anger, surprise — one strong feeling
6. QUESTION: "ทำไม...?" / "จริงหรือ?"
7. CONTROVERSY: bold claim that makes people click to verify

STYLE PRESETS (pick best match for content mood):
- "tiktok" — yellow accent, playful, trendy
- "bold" — red accent, aggressive, attention-grabbing
- "neon" — cyan glow, tech/modern/futuristic
- "fire" — orange blaze, intense/action/drama
- "cinema" — clean white, classy/documentary
- "highlight" — yellow highlight pill, educational
- "pink" — pink glow, beauty/lifestyle/emotional
- "blue" — blue highlight, calm/trust/informational

RULES:
- Line 1: MAX 5-6 words, the main hook — must trigger instant curiosity or emotion
- Line 2: MAX 4-5 words, supporting punch — amplifies line 1 (optional, use "" if line 1 is enough)
- If script is Thai, write Thai text (mixing English words is OK for impact)
- Suggest colors that POP against dark video backgrounds
- Be BOLD. Be DRAMATIC. Think Mr.Beast / viral TikTok energy

Return JSON ONLY:
{
  "line": "main hook text",
  "line2": "supporting text or empty",
  "style": "preset_id",
  "line1Color": "#hex color for line 1",
  "line2Color": "#hex color for line 2"
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match?.[0] ?? '{"line":""}');
  } catch {
    return { line: captionsList[0] ?? "" };
  }
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
      const rows = await prisma.$queryRawUnsafe<Array<{
        videoUrl: string | null;
        avatarVideoUrl: string | null;
        script: string | null;
        renderConfig: string | null;
        thumbnailConfig: string | null;
      }>>(
        `SELECT videoUrl, avatarVideoUrl, script, renderConfig, thumbnailConfig FROM Video WHERE id = ?`,
        videoId,
      );
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
      let apiKey = process.env.SERVER_OPENAI_API_KEY || null;
      if (!apiKey) {
        const user = await prisma.user.findUnique({
          where: { id: session.user.id },
          select: { openaiKey: true },
        });
        if (user?.openaiKey) apiKey = decrypt(user.openaiKey);
      }
      if (!apiKey) return NextResponse.json({ error: "OpenAI key not set", missingKey: "openai" }, { status: 400 });

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

      const result = await suggestText(script, captions, apiKey);
      return NextResponse.json(result);
    }

    // ── MODE: render (or legacy) ──
    if (!videoSrc)
      return NextResponse.json({ error: "No video URL available" }, { status: 400 });

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Resolve video path
    let videoPath: string;
    if (videoSrc.startsWith("/")) {
      videoPath = path.join(process.cwd(), "public", videoSrc);
    } else {
      videoPath = videoSrc;
    }

    if (!videoSrc.startsWith("http") && !fs.existsSync(videoPath)) {
      return NextResponse.json({ error: "Video file not found" }, { status: 404 });
    }

    // Capture frame
    const atSec = seekTime ?? 3;
    const framePath = path.join(rendersDir, `thumb-frame-${Date.now()}.jpg`);
    await captureFrame(videoPath, atSec, framePath);

    const filename = `thumb-${Date.now()}.jpg`;
    const outPath = path.join(rendersDir, filename);

    if (mode === "render" && Array.isArray(textLayers) && textLayers.length > 0) {
      // User-defined text layers
      await renderWithTextLayers(framePath, outPath, textLayers);
    } else {
      // No text — just use the captured frame
      fs.copyFileSync(framePath, outPath);
    }

    // Cleanup temp frame
    try { fs.unlinkSync(framePath); } catch { /* ignore */ }

    const thumbnailUrl = `/renders/${filename}`;

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
