import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { estimatePortraitFaceBoxesFromRgba, type FaceBox } from "@/lib/face-safe-placement";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import {
  GEMINI_DIRECTOR_FLASH_MODEL,
  GEMINI_DIRECTOR_NEON_MODEL,
  geminiGenerateVision,
} from "@/lib/gemini";
import { safeInputArgs } from "@/lib/media-probe-args";
import {
  buildStoryDirectorPlan,
  buildStoryDirectorPlanFromVisionSelection,
  type AnalyzedFootageItem,
  type StoryDirectorModelTier,
  type StoryDirectorPlan,
  type StoryVoiceMode,
  type VisionDirectorSelection,
} from "@/lib/story-director-planner";
import { ffprobeDurationSec, ffprobeVideoStreamMeta } from "@/lib/upload-media-probe";
import type { BrollVideo } from "@/remotion/types";

const execFileAsync = promisify(execFile);

export interface AnalyzedFootageItemWithSheet extends AnalyzedFootageItem {
  contactSheetBase64?: string;
  contactSheetMimeType?: "image/jpeg";
  sampledTimestampsSec?: number[];
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function resolveLocalStockOrImportFile(src: string): string | null {
  const clean = (src.split("?")[0] ?? "").trim();
  const stockMatch = /^\/(?:api\/)?stocks\/([a-zA-Z0-9._-]+)$/.exec(clean);
  if (stockMatch?.[1] && !stockMatch[1].includes("..")) {
    const rootStock = path.join(process.cwd(), "stocks", stockMatch[1]);
    if (fs.existsSync(rootStock)) return rootStock;
    const pubStock = path.join(process.cwd(), "public", "stocks", stockMatch[1]);
    if (fs.existsSync(pubStock)) return pubStock;
  }
  const renderMatch = /^\/(?:api\/)?renders\/([a-zA-Z0-9._-]+)$/.exec(clean);
  if (renderMatch?.[1] && !renderMatch[1].includes("..")) {
    const pubRender = path.join(process.cwd(), "public", "renders", renderMatch[1]);
    if (fs.existsSync(pubRender)) return pubRender;
    const rootRender = path.join(process.cwd(), "renders", renderMatch[1]);
    if (fs.existsSync(rootRender)) return rootRender;
  }
  return null;
}

async function detectClipAudioSpeechActivity(filePath: string, durationSec: number): Promise<boolean> {
  try {
    const probeDur = Math.min(6, Math.max(0.5, durationSec));
    const { stderr } = await execFileAsync(
      getFfmpegPath(),
      [
        "-hide_banner",
        ...safeInputArgs("mov"),
        "-t",
        probeDur.toFixed(2),
        "-i",
        filePath,
        "-af",
        "highpass=f=180,lowpass=f=3800,volumedetect",
        "-f",
        "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ],
      { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const meanMatch = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    const maxMatch = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
    const meanDb = meanMatch ? Number(meanMatch[1]) : -91;
    const maxDb = maxMatch ? Number(maxMatch[1]) : -91;
    return Number.isFinite(meanDb) && meanDb > -38 && maxDb > -18;
  } catch {
    return false;
  }
}

/**
 * Transcribes short spoken Thai quotes/cheers (< 12s) from an uploaded video clip
 * using `gemini-3.5-transcribe` so the AI Story Director knows exact real dialogue!
 */
export async function transcribeShortClipAudio(
  filePath: string,
  durationSec: number,
  apiKey: string,
): Promise<string | undefined> {
  const tmpWav = path.join(
    os.tmpdir(),
    `story-asr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  try {
    const sliceDur = Math.min(12, Math.max(0.8, durationSec));
    await execFileAsync(
      getFfmpegPath(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...safeInputArgs("mov"),
        "-t",
        sliceDur.toFixed(2),
        "-i",
        filePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        tmpWav,
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!fs.existsSync(tmpWav)) return undefined;
    const wavBase64 = fs.readFileSync(tmpWav).toString("base64");
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: "ถอดเสียงพูดภาษาไทยที่ได้ยินจริงในคลิปสั้นนี้แบบคำต่อคำสั้นกระชับ ถ้ามีแต่เสียงดนตรีหรือเสียงรบกวนไม่มีคำพูดให้ตอบคำว่า NONE คำเดียว",
                },
                { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 256 },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").trim();
    if (!raw || /^none$/i.test(raw) || raw.length < 2) return undefined;
    return raw.replace(/\s+/g, " ").slice(0, 140);
  } catch {
    return undefined;
  } finally {
    try {
      if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
    } catch {}
  }
}

async function detectMidpointPortraitFaceBoxes(
  filePath: string,
  seekSec: number,
): Promise<FaceBox[]> {
  const tmpPng = path.join(os.tmpdir(), `face-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await execFileAsync(
      getFfmpegPath(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...safeInputArgs("mov"),
        "-ss",
        Math.max(0, seekSec).toFixed(2),
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=96:170:force_original_aspect_ratio=increase,crop=96:170",
        tmpPng,
      ],
      { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!fs.existsSync(tmpPng)) return [];
    const { data, info } = await sharp(tmpPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return estimatePortraitFaceBoxesFromRgba(data, info.width, info.height);
  } catch {
    return [];
  } finally {
    try {
      if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
    } catch {}
  }
}

/**
 * Generates a compact, crystal-clear 1fps Timestamped Contact Sheet JPEG for a video/photo clip.
 * Every tile has a high-contrast `0.2s`, `1.2s`, `2.2s`... timestamp badge burned into its
 * top-left corner + a top header bar naming the clip index & duration so BOTH Web Vision AI
 * (`Gemini 4 Neon` / `3.8 Flash`) AND MCP Client Agents (`Claude Opus 5.5`) can pick exact
 * `inSec..outSec` windows with zero guesswork!
 */
export async function buildTimestampedContactSheetJpeg(input: {
  filePath: string;
  durationSec: number;
  stillImage?: boolean;
  clipIndex: number;
  filename?: string;
}): Promise<{ base64Jpeg: string; timestampsSec: number[]; faceBoxes: FaceBox[] } | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-sheet-"));
  try {
    const dur = Math.max(0.5, input.durationSec);
    const timestampsSec: number[] = [];
    if (input.stillImage || dur <= 1.2) {
      timestampsSec.push(0);
    } else {
      const maxTiles = 12;
      const step = Math.max(1.0, Number((dur / maxTiles).toFixed(2)));
      for (let t = 0.2; t < dur - 0.15 && timestampsSec.length < maxTiles; t += step) {
        timestampsSec.push(Number(t.toFixed(1)));
      }
      if (timestampsSec.length === 0) timestampsSec.push(0);
    }

    const tileW = 216;
    const tileH = 384;
    const cols = Math.min(4, Math.max(1, timestampsSec.length));
    const rows = Math.ceil(timestampsSec.length / cols);
    const headerH = 40;
    const sheetW = cols * tileW;
    const sheetH = headerH + rows * tileH;

    // Extract frames sequentially into tmpDir
    const tileBuffers: Array<{ buf: Buffer; sec: number; col: number; row: number }> = [];
    let bestFaces: FaceBox[] = [];

    for (let i = 0; i < timestampsSec.length; i++) {
      const sec = timestampsSec[i]!;
      const framePng = path.join(tmpDir, `f-${i}.jpg`);
      await execFileAsync(
        getFfmpegPath(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          ...safeInputArgs("mov"),
          "-ss",
          sec.toFixed(2),
          "-i",
          input.filePath,
          "-frames:v",
          "1",
          "-vf",
          `scale=${tileW}:${tileH}:force_original_aspect_ratio=increase,crop=${tileW}:${tileH}`,
          "-q:v",
          "4",
          framePng,
        ],
        { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
      );
      if (!fs.existsSync(framePng)) continue;
      const buf = fs.readFileSync(framePng);
      if (bestFaces.length === 0 && (i === Math.floor(timestampsSec.length / 2) || i === 0)) {
        const { data, info } = await sharp(buf).resize(96, 170).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const f = estimatePortraitFaceBoxesFromRgba(data, info.width, info.height);
        if (f.length > 0) bestFaces = f;
      }
      tileBuffers.push({
        buf,
        sec,
        col: i % cols,
        row: Math.floor(i / cols),
      });
    }

    if (tileBuffers.length === 0) return null;

    const titleText = `CLIP #${input.clipIndex} · ${input.filename || path.basename(input.filePath)} · ${
      input.stillImage ? "STILL PHOTO" : `${dur.toFixed(1)}s`
    }`;
    const tileLabelsSvg = tileBuffers
      .map(({ sec, col, row }) => {
        const x = col * tileW;
        const y = headerH + row * tileH;
        const label = input.stillImage ? "PHOTO" : `${sec.toFixed(1)}s`;
        return `
          <rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.5"/>
          <rect x="${x + 8}" y="${y + 8}" width="68" height="26" rx="6" fill="rgba(0,0,0,0.82)" stroke="#FFE500" stroke-width="1.5"/>
          <text x="${x + 42}" y="${y + 26}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" fill="#FFE500" text-anchor="middle">${escapeXml(label)}</text>
        `;
      })
      .join("\n");

    const overlaySvg = Buffer.from(`
      <svg width="${sheetW}" height="${sheetH}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${sheetW}" height="${headerH}" fill="#0F172A"/>
        <text x="14" y="26" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" fill="#FFFFFF">${escapeXml(titleText)}</text>
        ${tileLabelsSvg}
      </svg>
    `);

    const jpegBuf = await sharp({
      create: {
        width: sheetW,
        height: sheetH,
        channels: 3,
        background: { r: 12, g: 15, b: 24 },
      },
    })
      .composite([
        ...tileBuffers.map((t) => ({
          input: t.buf,
          left: t.col * tileW,
          top: headerH + t.row * tileH,
        })),
        { input: overlaySvg, left: 0, top: 0 },
      ])
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();

    return {
      base64Jpeg: jpegBuf.toString("base64"),
      timestampsSec,
      faceBoxes: bestFaces,
    };
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Inspects local `/api/stocks/...` or staged import MP4s on disk to populate durations,
 * native audio & speech/cheer activity, Live-Photo cadence, face safe zones, and optional
 * 1fps Timestamped Contact Sheets + short speech transcripts!
 */
export async function analyzeUploadedFootageItems(
  items: readonly {
    id?: string;
    src: string;
    localFilePath?: string | null;
    filename?: string;
    stillImage?: boolean;
    durationSec?: number;
    hasAudio?: boolean;
    sourceFps?: number | null;
    isLivePhotoCadence?: boolean;
    transcriptSnippet?: string;
  }[],
  options: {
    includeContactSheets?: boolean;
    apiKey?: string | null;
  } = {},
): Promise<AnalyzedFootageItemWithSheet[]> {
  const analyzed: AnalyzedFootageItemWithSheet[] = [];
  const slice = items.slice(0, 16);

  for (let idx = 0; idx < slice.length; idx++) {
    const item = slice[idx]!;
    const filePath = item.localFilePath && fs.existsSync(item.localFilePath)
      ? item.localFilePath
      : resolveLocalStockOrImportFile(item.src);

    let durationSec = item.durationSec && item.durationSec > 0 ? item.durationSec : 5;
    let hasAudio = item.hasAudio ?? false;
    let sourceFps = item.sourceFps ?? null;
    let isLivePhotoCadence = item.isLivePhotoCadence ?? false;
    let hasSpeechOrCheer = false;
    let faceBoxes: FaceBox[] = [];
    let transcriptSnippet = item.transcriptSnippet;
    let contactSheetBase64: string | undefined;
    let sampledTimestampsSec: number[] | undefined;

    if (filePath) {
      const probedDur = ffprobeDurationSec(filePath, "mov");
      if (probedDur > 0) durationSec = probedDur;
      const meta = ffprobeVideoStreamMeta(filePath, "mov");
      if (item.hasAudio === undefined) hasAudio = meta.hasAudio;
      if (sourceFps === null) sourceFps = meta.fps;
      if (!item.isLivePhotoCadence && meta.isLivePhotoCadence) {
        isLivePhotoCadence = true;
      }

      const [speechActive, sheetOrFaces] = await Promise.all([
        hasAudio && !item.stillImage ? detectClipAudioSpeechActivity(filePath, durationSec) : Promise.resolve(false),
        options.includeContactSheets
          ? buildTimestampedContactSheetJpeg({
              filePath,
              durationSec,
              stillImage: item.stillImage,
              clipIndex: idx,
              filename: item.filename,
            })
          : detectMidpointPortraitFaceBoxes(filePath, item.stillImage ? 0 : durationSec * 0.35).then((f) => ({
              base64Jpeg: undefined,
              timestampsSec: undefined,
              faceBoxes: f,
            })),
      ]);

      hasSpeechOrCheer = speechActive;
      if (sheetOrFaces) {
        faceBoxes = sheetOrFaces.faceBoxes;
        contactSheetBase64 = sheetOrFaces.base64Jpeg;
        sampledTimestampsSec = sheetOrFaces.timestampsSec;
      }

      if (hasSpeechOrCheer && !transcriptSnippet && options.apiKey) {
        transcriptSnippet = await transcribeShortClipAudio(filePath, durationSec, options.apiKey);
      }
    }

    analyzed.push({
      ...(item.id ? { id: item.id } : {}),
      src: item.src,
      ...(item.filename ? { filename: item.filename } : {}),
      durationSec: Number(durationSec.toFixed(2)),
      stillImage: Boolean(item.stillImage),
      hasAudio,
      hasSpeechOrCheer,
      isLivePhotoCadence,
      sourceFps,
      ...(faceBoxes.length > 0 ? { faceBoxes } : {}),
      ...(transcriptSnippet ? { transcriptSnippet } : {}),
      ...(contactSheetBase64
        ? {
            contactSheetBase64,
            contactSheetMimeType: "image/jpeg" as const,
            sampledTimestampsSec,
          }
        : {}),
    });
  }
  return analyzed;
}

/**
 * Calls `Gemini 4 Neon` (Pro Director, 19 credits) or `Gemini 3.8 Flash` (6 credits)
 * with Thinking enabled on all 1fps Timestamped Contact Sheets + short audio transcripts
 * to produce a context-accurate, viral-ready Story Director EDL!
 */
export async function planStoryDirectorWithVisionModel(input: {
  apiKey: string;
  modelTier?: StoryDirectorModelTier;
  voiceMode?: StoryVoiceMode;
  brief?: string;
  templateId?: string | null;
  targetDurationSec?: number;
  clips: readonly AnalyzedFootageItemWithSheet[];
  creditsCharged?: number;
}): Promise<StoryDirectorPlan> {
  const modelTier: StoryDirectorModelTier = input.modelTier ?? "neon";
  const voiceMode: StoryVoiceMode = input.voiceMode ?? "real-moments";
  const model = modelTier === "neon" ? GEMINI_DIRECTOR_NEON_MODEL : GEMINI_DIRECTOR_FLASH_MODEL;
  const thinkingBudget = modelTier === "neon" ? 2048 : 1024;

  const sheets = input.clips
    .map((c, idx) => ({ clip: c, idx }))
    .filter((x) => Boolean(x.clip.contactSheetBase64));

  if (sheets.length === 0) {
    return buildStoryDirectorPlan({
      brief: input.brief,
      voiceMode,
      templateId: input.templateId,
      clips: input.clips,
      targetDurationSec: input.targetDurationSec,
    });
  }

  const clipCatalogLines = sheets.map(({ clip, idx }) => {
    const audioDesc = clip.transcriptSnippet
      ? `มีเสียงพูดจริง: "${clip.transcriptSnippet}"`
      : clip.hasSpeechOrCheer
        ? "มีเสียงเชียร์/บรรยากาศดังชัด"
        : clip.hasAudio
          ? "มีเสียงบรรยากาศทั่วไป"
          : "ไม่มีเสียง (ภาพนิ่ง/ปิดเสียง)";
    return `- CLIP #${idx} (${clip.filename || `clip-${idx}`}): ความยาว ${clip.durationSec}s, ${
      clip.stillImage ? "ภาพนิ่ง (PHOTO)" : "วิดีโอเคลื่อนไหว"
    }, ${audioDesc}`;
  });

  const targetSecHint = input.targetDurationSec ?? Math.min(36, Math.max(18, sheets.length * 4));
  const prompt = `คุณคือผู้กำกับตัดต่อวิดีโอสั้น TikTok / Reels มืออาชีพระดับยอดวิวหลักแสน
หน้าที่ของคุณคือดู "แผ่นภาพ Contact Sheet รายวินาที (มีเลขวินาทีสีเหลืองกำกับมุมซ้ายบนของทุกเฟรม)" ของแต่ละ CLIP แล้วคัดเฉพาะช่วงวินาทีที่ดีที่สุดมาเรียงเป็นเรื่องราวที่สนุก ลื่นไหล และตรงกับภาพที่เห็นจริง 100%!

โจทย์จากลูกค้า: "${(input.brief ?? "").trim() || "รวมไฮไลต์กิจกรรมสนุกและโมเมนต์ประทับใจวันนี้"}"
โหมดการเล่าเรื่อง: ${
    voiceMode === "real-moments"
      ? "TikTok Vlog (ไม่ใช้เสียงโฆษก AI พูดยาวทับ! ใช้เสียงจริงจากคลิปสลับเพลงสนุกๆ + ป้ายข้อความพากย์อารมณ์สั้นๆ ให้ตรงกับภาพในช็อตนั้นเป๊ะๆ)"
      : "พากย์เสียง AI บรรยายสั้นกระชับให้ตรงกับภาพในแต่ละช็อต"
  }
ความยาวรวมเป้าหมาย: ประมาณ ${targetSecHint} วินาที (เลือกประมาณ 5–9 ช็อต ช็อตละ 2.0–4.2 วินาที)

รายการฟุตเทจ (ตรงกับรูป Contact Sheet ที่แนบตามลำดับ):
${clipCatalogLines.join("\n")}

━━━ กฎเหล็กของผู้กำกับ (ห้ามฝ่าฝืนเด็ดขาด!) ━━━
1. ดูตัวเลขวินาทีสีเหลืองบนแต่ละช่องภาพให้แม่นยำ! ระบุตัวเอกของคลิปให้ชัด (หน้าตา/ชุด/สีทีม) ห้ามเลือกช่วงวินาทีที่เป็นเด็กคนอื่นเดินนำโดยไม่เห็นตัวเอก ห้ามเลือกวินาทีที่มีคนเดินบังหน้ากล้อง ห้ามเลือกช่วงถ่ายพื้นถนนหรือกล้องเหวี่ยงเบลอ!
2. ห้ามมั่วชื่อกีฬาหรือกิจกรรมเด็ดขาด! ดูจากภาพจริงว่าเขาทำอะไรกันแน่ (เช่น ถ้าในภาพเป็นการสวมกางเกงยักษ์วิ่งผลัด ห้ามเขียนว่าวิ่งกระสอบ!)
3. ทุกช็อตวิดีโอต้องมีช่วงเวลา (outSec - inSec) อย่างน้อย 1.8–4.0 วินาทีที่เป็นแอ็กชันต่อเนื่องสวยๆ ไม่ตัดสั้นจู๋จนกระตุก
4. ถ้าคลิปไหนมีเสียงพูดถาม-ตอบจริงน่ารักๆ หรือเสียงเชียร์/หัวเราะท้ายคลิป ให้ตั้ง keepClipAudio: true ในช็อตนั้น (เช่น cold-open ต้นคลิป หรือ blooper ท้ายคลิป)
5. เลือก slowMo: true ได้สูงสุดแค่ 1 ช็อตเดียว ที่เป็นจังหวะแอ็กชันพีคของตัวเอกจริงๆ (เช่น จังหวะวิ่งเข้าเส้นชัย หมุนตัว หรือเดินนำขบวนเด่นๆ) และเลือก heroFreeze: true ได้สูงสุด 1 ช็อตที่ตัวเอกหันหน้าชัดมือนิ่ง
6. captionText ของแต่ละช็อตต้องเป็นภาษาไทยสั้นๆ สนุกๆ มีชีวิตชีวา (ไม่เกิน 28 ตัวอักษร) และตรงกับสิ่งที่เห็นใน inSec..outSec ของช็อตนั้นเป๊ะๆ!
7. ระบุ faceZone ของตัวเอกในแต่ละช็อต ("upper" = ใบหน้าอยู่ครึ่งบนของจอ, "center" = ใบหน้าอยู่กลางจอ, "lower" = ใบหน้าก้มต่ำ/ใกล้ขอบล่างจอ, "none" = ไม่เห็นใบหน้าใกล้ๆ) เพื่อให้ระบบวางข้อความหลบหน้าอัตโนมัติ 100%! ห้ามใส่คำว่า "ภารกิจ 1:" ซ้ำใน mission1Label/mission2Label (ใส่เฉพาะชื่อกิจกรรมสั้นๆ เช่น "เดินขบวนดรัมเมเยอร์" หรือ "แข่งวิ่งผลัดกางเกงยักษ์")

ตอบเป็น JSON เท่านั้นตามโครงสร้างนี้:
{
  "templateId": "event-mission-vlog" | "proud-moment-highlight" | "product-beat-showcase",
  "protagonistSummary": "ลักษณะตัวเอกที่เห็นในภาพ",
  "headline": "พาดหัวเปิดคลิปสั้นคม (ไม่เกิน 36 ตัวอักษร)",
  "subheadline": "คำโปรยรอง (ไม่เกิน 50 ตัวอักษร)",
  "mission1Label": "ชื่อภารกิจ 1 สั้นๆ (ไม่ต้องใส่คำว่า ภารกิจ 1)",
  "mission2Label": "ชื่อภารกิจ 2 สั้นๆ (ไม่ต้องใส่คำว่า ภารกิจ 2)",
  "checklistTitle": "หัวข้อเช็กลิสต์สั้นๆ",
  "checklistItems": ["ข้อ 1 สั้นๆ", "ข้อ 2 สั้นๆ", "ข้อ 3 สั้นๆ"],
  "peakSticker": "ข้อความสติกเกอร์ช็อตพีค",
  "blooperTitle": "ข้อความป้ายช็อตเบื้องหลังท้ายคลิป",
  "shots": [
    {
      "clipIndex": 0,
      "inSec": 0.2,
      "outSec": 3.0,
      "role": "cold-open" | "hero-freeze" | "mission-1" | "mission-2" | "slow-mo-peak" | "blooper",
      "faceZone": "upper" | "center" | "lower" | "none",
      "keepClipAudio": true,
      "slowMo": false,
      "heroFreeze": false,
      "captionText": "ข้อความพากย์อารมณ์ตรงกับภาพช็อตนี้",
      "visualCheck": "อธิบายสั้นๆ ว่าในวินาทีนี้เห็นตัวเอกทำอะไรชัด"
    }
  ],
  "narrationSentences": ["ประโยคบรรยาย 1", "ประโยคบรรยาย 2", "ประโยคบรรยาย 3"]
}`;

  const rawJson = await geminiGenerateVision(
    input.apiKey,
    prompt,
    sheets.map((s) => ({
      mimeType: "image/jpeg",
      dataBase64: s.clip.contactSheetBase64!,
    })),
    8192,
    {
      model,
      thinkingBudget,
      responseMimeType: "application/json",
    },
  );

  const cleaned = rawJson.replace(/```(?:json)?/gi, "").trim();
  const match = /\{[\s\S]*\}/.exec(cleaned);
  if (!match) {
    throw new Error("Vision model returned non-JSON Story Director output");
  }
  const parsed = JSON.parse(match[0]) as VisionDirectorSelection;

  return buildStoryDirectorPlanFromVisionSelection({
    brief: input.brief,
    voiceMode,
    templateId: input.templateId,
    targetDurationSec: input.targetDurationSec,
    clips: input.clips,
    selection: parsed,
    modelUsed: model,
    creditsCharged: input.creditsCharged,
  });
}

/**
 * Pre-renders any slow-motion (`playbackRate < 1`) Story Director segment into a dedicated
 * true-30fps optical-flow (`minterpolate`) clip in `outDir` and resets `playbackRate` to `1`!
 *
 * Eliminates the `30fps * 0.58 = 17.4fps` frame-duplication stutter completely while taking
 * only ~2–3 seconds because only the 1.8–2.5s peak action slice is interpolated!
 */
export async function materializeSmoothSlowMoSegments(
  bgVideos: readonly BrollVideo[],
  options: {
    outDir: string;
    urlPrefix: string;
    resolveLocalPath?: (src: string) => string | null;
  },
): Promise<BrollVideo[]> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const out: BrollVideo[] = [];

  for (let idx = 0; idx < bgVideos.length; idx++) {
    const seg = bgVideos[idx]!;
    const rate = typeof seg.playbackRate === "number" ? seg.playbackRate : 1;
    if (seg.stillImage || rate >= 0.96 || rate <= 0.2) {
      out.push(seg);
      continue;
    }

    const localPath = options.resolveLocalPath
      ? options.resolveLocalPath(seg.src)
      : resolveLocalStockOrImportFile(seg.src);

    if (!localPath || !fs.existsSync(localPath)) {
      // If we cannot access local bytes to optical-flow interpolate, play at 1.0x rather than stuttering at 17fps!
      out.push({ ...seg, playbackRate: 1 });
      continue;
    }

    const timelineDur = Math.max(1.2, seg.end - seg.start);
    const sourceSliceDur = Math.max(0.8, timelineDur * rate);
    const inSec = Math.max(0, seg.clipOffset ?? 0);
    const slowFilename = `story-slowmo-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const slowPath = path.join(options.outDir, slowFilename);
    const stretchFactor = Number((1 / rate).toFixed(4));

    try {
      await execFileAsync(
        getFfmpegPath(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          ...safeInputArgs("mov"),
          "-ss",
          inSec.toFixed(2),
          "-t",
          sourceSliceDur.toFixed(2),
          "-i",
          localPath,
          "-an",
          "-vf",
          `setpts=${stretchFactor}*PTS,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1,format=yuv420p`,
          "-r",
          "30",
          "-fps_mode",
          "cfr",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "19",
          "-movflags",
          "+faststart",
          slowPath,
        ],
        { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      );

      const newDur = ffprobeDurationSec(slowPath, "mov") || timelineDur;
      out.push({
        ...seg,
        src: `${options.urlPrefix.replace(/\/$/, "")}/${slowFilename}`,
        clipOffset: 0,
        clipDuration: Number(newDur.toFixed(2)),
        playbackRate: 1,
        keepClipAudio: false,
      });
    } catch {
      out.push({ ...seg, playbackRate: 1 });
    }
  }

  return out;
}
