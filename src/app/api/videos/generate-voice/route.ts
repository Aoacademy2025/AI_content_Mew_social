import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
export const maxDuration = 180;
export const runtime = "nodejs";

function decrypt(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

/** Properly merge multiple MP3 files using ffmpeg concat filter → correct headers + total duration */
function mergeAudioFiles(inputPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (inputPaths.length === 1) {
      fs.copyFileSync(inputPaths[0], outputPath);
      return resolve();
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpeg = require("fluent-ffmpeg");
    if (process.platform !== "win32") {
      ffmpeg.setFfmpegPath("ffmpeg");
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
      ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    }
    const cmd = ffmpeg();
    inputPaths.forEach(p => cmd.input(p));
    cmd
      .complexFilter([`concat=n=${inputPaths.length}:v=0:a=1[aout]`], ["aout"])
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`Audio merge failed: ${err.message}`)))
      .run();
  });
}

// POST /api/videos/generate-voice
// Body: { scenes: [{ scene: number; text: string }], voiceId: string }
// Returns: { audioUrls: [{ scene: number; url: string }], mergedUrl: string }
export async function POST(req: Request) {
  try {
    // 1. Auth
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Parse body first
    const body = await req.json().catch(() => null);
    const scenes: { scene: number; text: string }[] = body?.scenes ?? [];
    const voiceId: string = body?.voiceId ?? "";

    if (!voiceId) return NextResponse.json({ error: "voiceId required" }, { status: 400 });
    if (!scenes.length) return NextResponse.json({ error: "scenes required" }, { status: 400 });

    // 3. Get ElevenLabs key from DB
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { elevenlabsKey: true },
    });

    if (!user?.elevenlabsKey) {
      return NextResponse.json({ error: "ElevenLabs API key ยังไม่ได้ตั้งค่า — ตั้งค่าใน Settings > API Keys", missingKey: "elevenlabs" }, { status: 400 });
    }

    const elevenlabsKey = decrypt(user.elevenlabsKey);

    // 4. Generate audio per scene
    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    const audioUrls: { scene: number; url: string }[] = [];
    const ts = Date.now();

    for (const s of scenes) {
      // Detect language: Thai Unicode block U+0E00–U+0E7F
      const hasThai = /[\u0E00-\u0E7F]/.test(s.text);
      const language_code = hasThai ? "th" : "en";

      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": elevenlabsKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: s.text,
          model_id: "eleven_v3",
          language_code,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
        }),
      });

      if (!res.ok) {
        // Try to parse ElevenLabs JSON error
        let errMsg = `ElevenLabs ${res.status}`;
        try {
          const errBody = await res.json();
          errMsg = errBody?.detail?.message ?? errBody?.detail ?? errBody?.message ?? errMsg;
        } catch {
          errMsg = `${errMsg}: ${await res.text().catch(() => "")}`;
        }
        return NextResponse.json({ error: `Scene ${s.scene}: ${errMsg}` }, { status: 400 });
      }

      const audioBuffer = Buffer.from(await res.arrayBuffer());
      const filename = `voice-${s.scene}-${ts}.mp3`;
      fs.writeFileSync(path.join(rendersDir, filename), audioBuffer);
      audioUrls.push({ scene: s.scene, url: `/renders/${filename}` });
    }

    // 5. Merge all scenes into one MP3 using ffmpeg concat (proper headers + duration)
    const mergedFilename = `voice-merged-${ts}.mp3`;
    const mergedPath = path.join(rendersDir, mergedFilename);
    await mergeAudioFiles(audioUrls.map(a => path.join(rendersDir, path.basename(a.url))), mergedPath);
    const mergedUrl = `/renders/${mergedFilename}`;

    return NextResponse.json({ audioUrls, mergedUrl });
  } catch (error) {
    console.error("generate-voice error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Voice generation failed" },
      { status: 500 }
    );
  }
}
