import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { fetchWithBudget } from "@/lib/fetch-budget";
import { isProviderError, providerError, classifyHttpStatus, toErrorResponse } from "@/lib/provider-errors";
import { HEYGEN_GEN_FRAMING, AVATAR_GEN_DIMENSION, AVATAR_GEN_FALLBACK_DIMENSION, isResolutionFallbackError } from "@/lib/avatar-gen-framing";
import { decryptKey } from "@/lib/key-crypto";

// Single source of truth lives in avatar-gen-framing.ts; these consts are kept so the
// destructuring defaults at line ~116-118 are unchanged and easy to read.
const HEYGEN_GEN_SCALE = HEYGEN_GEN_FRAMING.scale;
const HEYGEN_GEN_OFFSET_Y = HEYGEN_GEN_FRAMING.offsetY;

function getFfmpegPath(): string {
  if (process.platform !== "win32") return "/usr/bin/ffmpeg";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `win32-${process.arch}`, "ffmpeg.exe");
}

/** Convert any audio file to MP3 128k, return path to tmp mp3 */
function toMp3(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.\w+$/, "") + `-heygen-${Date.now()}.mp3`;
  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), [
      "-y", "-i", inputPath,
      "-vn", "-acodec", "libmp3lame", "-ab", "128k", "-ar", "44100", "-ac", "2",
      outPath,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg mp3 convert failed: ${stderr?.slice(-300)}`));
      else resolve(outPath);
    });
  });
}

export const maxDuration = 300;
export const runtime = "nodejs";


// Detect content type from file bytes
function detectVideoType(buf: Buffer): string {
  if (buf.length > 12) {
    const ftyp = buf.toString("ascii", 4, 8);
    if (ftyp === "ftyp") {
      const brand = buf.toString("ascii", 8, 12);
      if (brand === "qt  " || brand === "mqt ") return "video/quicktime";
    }
  }
  return "video/mp4";
}

// Upload a local file to HeyGen and return { id, url }
async function uploadAsset(localUrl: string, heygenKey: string, contentType?: string): Promise<{ id: string; url: string | null }> {
  const normalizedUrl = localUrl.replace(/^\/api\/renders\//, "/renders/");
  const localPath = path.join(process.cwd(), "public", normalizedUrl);
  if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localUrl}`);
  const buffer = fs.readFileSync(localPath);
  const ct = contentType ?? detectVideoType(buffer);
  console.log("[generate-with-bg] uploading:", localUrl, "content-type:", ct, "size:", buffer.length);

  // HeyGen asset-upload budget: 120s/attempt, 1 retry (network/429/5xx only —
  // a duplicated upload only creates an unused asset, no user-visible harm).
  // Non-ok statuses throw ProviderError → surfaced by the route-level catch.
  const res = await fetchWithBudget("https://upload.heygen.com/v1/asset", {
    method: "POST",
    headers: { "X-API-KEY": heygenKey, "Content-Type": ct, Accept: "application/json" },
    body: buffer as unknown as BodyInit,
  }, { provider: "heygen", timeoutMs: 120_000, retries: 1, wallClockMs: 300_000 });
  const data = await res.json();
  console.log("[generate-with-bg] upload result:", res.status, JSON.stringify(data));
  if (!data.data?.id) throw new Error(`Upload failed: ${data.message ?? res.status}`);
  return { id: data.data.id as string, url: (data.data.url as string) ?? null };
}

// POST /api/heygen/generate-with-bg
// Mode A (video bg): { text|audioUrl, avatarId, bgVideoUrl, scale?, offsetX?, offsetY? }
// Mode B (green screen): { text|audioUrl, avatarId, greenScreen: true, scale?, offsetX?, offsetY? }
// Returns: { videoId }
export async function POST(req: Request) {
  try {
    return await handleGenerateWithBg(req);
  } catch (error) {
    if (isProviderError(error)) {
      console.error(`[generate-with-bg] ${error.provider}/${error.code}:`, error.message);
      const { body: errBody, status } = toErrorResponse(error);
      return NextResponse.json(errBody, { status });
    }
    console.error("[generate-with-bg] unexpected error:", error);
    return NextResponse.json(
      { error: "ระบบ Avatar ทำงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", retryable: false },
      { status: 500 }
    );
  }
}

async function handleGenerateWithBg(req: Request) {
  const authUser = await getCurrentUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await prisma.user.findUnique({ where: { id: authUser.id }, select: { plan: true } });
  if (dbUser?.plan === "FREE") return NextResponse.json({ error: "HeyGen Avatar ใช้ได้เฉพาะแผน Pro ขึ้นไป" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const {
    text,
    audioUrl,
    avatarId,
    voiceId = "2d5b0e6cf36f460aa7fc47e3eee4ba54",
    bgVideoUrl,
    greenScreen = false,
    removeBg = false,
    bgColor = "#000000",
    scale = HEYGEN_GEN_SCALE,
    offsetX = HEYGEN_GEN_FRAMING.offsetX,
    offsetY = HEYGEN_GEN_OFFSET_Y,
  } = body ?? {};

  if (!text && !audioUrl) return NextResponse.json({ error: "text or audioUrl required" }, { status: 400 });
  if (!avatarId) return NextResponse.json({ error: "avatarId required" }, { status: 400 });
  if (!greenScreen && !removeBg && !bgVideoUrl) return NextResponse.json({ error: "bgVideoUrl, greenScreen, or removeBg required" }, { status: 400 });

  // HeyGen ยอมรับ offset เป็นสัดส่วนของเฟรม -1..1 เท่านั้น (บวก = ขวา/ลง; 1.0 = เลื่อนทั้งเฟรม → avatar หลุดเฟรม)
  // แต่ slider ตำแหน่ง avatar ใน video-editor (bundle เก่า) ส่งค่าเป็น px (-200..200; px=200 = เลื่อน 50% เฟรม
  // ตามสเกล preview) ทำให้ HeyGen ตอบ 400 — composite วาง canvas เต็มเฟรม ตำแหน่งสุดท้ายมาจาก offset
  // ฝั่ง HeyGen เท่านั้น จึงแปลงหน่วยด้วย px/400 แทนการตัดทิ้ง (client ใหม่แปลงเองแล้ว ส่วนนี้กัน bundle เก่า)
  const safeOffset = (v: unknown, fallback: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (Math.abs(n) <= 1) return n;
    return Math.max(-1, Math.min(1, n / 400));
  };
  const hgOffsetX = safeOffset(offsetX, HEYGEN_GEN_FRAMING.offsetX);
  const hgOffsetY = safeOffset(offsetY, HEYGEN_GEN_OFFSET_Y);
  if (hgOffsetX !== Number(offsetX) || hgOffsetY !== Number(offsetY)) {
    console.warn(`[generate-with-bg] offset adjusted for HeyGen range: (${offsetX}, ${offsetY}) → (${hgOffsetX}, ${hgOffsetY})`);
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { heygenKey: true } });
  if (!user?.heygenKey) return NextResponse.json({ error: "HeyGen API key not set", missingKey: "heygen" }, { status: 400 });
  const heygenKey = decryptKey(user.heygenKey);

  // Step 1: Background — remove bg / green screen / uploaded video
  let background: Record<string, unknown> | undefined;
  let bgAssetId: string | undefined;

  if (removeBg) {
    // removeBg mode: green bg — best contrast for AI segmentation (BiRefNet)
    background = { type: "color", value: "#00FF00" };
    console.log("[generate-with-bg] using green bg for AI removal");
  } else if (greenScreen) {
    // greenScreen mode: green bg for AI removal
    background = { type: "color", value: "#00FF00" };
    console.log("[generate-with-bg] using green bg mode");
  } else {
    // Video background mode: upload bg video to HeyGen
    const bgAsset = await uploadAsset(bgVideoUrl, heygenKey);
    if (!bgAsset.url) return NextResponse.json({ error: "HeyGen upload returned no URL for BG asset" }, { status: 500 });
    bgAssetId = bgAsset.id;
    background = { type: "video", url: bgAsset.url, fit: "cover", play_style: "loop" };
  }

  // Step 2: Build voice input
  let voiceInput: Record<string, unknown>;

  if (audioUrl) {
    // Always upload as MP3 — HeyGen's asset API is strict about audio format.
    // WAV (Gemini TTS) and other formats must be converted first.
    const normalizedAudioUrl = audioUrl.replace(/^\/api\/renders\//, "/renders/");
    const localPath = path.join(process.cwd(), "public", normalizedAudioUrl);
    const audioExt = audioUrl.split(".").pop()?.toLowerCase() ?? "";
    let uploadPath = localPath;
    let tmpMp3: string | null = null;

    if (audioExt !== "mp3") {
      console.log("[generate-with-bg] converting", audioExt, "→ mp3 before HeyGen upload");
      tmpMp3 = await toMp3(localPath);
      uploadPath = tmpMp3;
    }

    // Upload the MP3 file directly (bypass uploadAsset which reads from /public path)
    const buffer = fs.readFileSync(uploadPath);
    console.log("[generate-with-bg] uploading audio as audio/mpeg, size:", buffer.length);
    // Audio upload budget: 120s/attempt, 1 retry. returnHttpErrors keeps the
    // carefully-worded Thai 401-vs-other handling below working unchanged.
    const uploadRes = await fetchWithBudget("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-API-KEY": heygenKey, "Content-Type": "audio/mpeg", Accept: "application/json" },
      body: buffer as unknown as BodyInit,
    }, { provider: "heygen", timeoutMs: 120_000, retries: 1, wallClockMs: 300_000, returnHttpErrors: true });
    const uploadData = await uploadRes.json();
    console.log("[generate-with-bg] audio upload result:", uploadRes.status, JSON.stringify(uploadData));
    if (tmpMp3) try { fs.unlinkSync(tmpMp3); } catch {}
    if (!uploadRes.ok || !uploadData.data?.id) {
      // ตอบ JSON ชัดเจนแทน throw (เดิมกลายเป็น 500 plain text → client parse พัง)
      // - ห้ามมีคำว่า "Unauthorized"/"401" ในข้อความ: video-creator จะ map เป็น "Session หมดอายุ" ซึ่งผิดเรื่อง
      // - retryable:false ทุกกรณี: ปัญหา upload ไม่ใช่ key หาย — ไม่ต้องเปิด modal ใส่ key ซ้ำ
      const keyRejected = uploadRes.status === 401;
      const msg = keyRejected
        ? "HeyGen API key ไม่ถูกต้องหรือถูกปฏิเสธ — กรุณาตรวจสอบ HeyGen key ใน Settings"
        : `HeyGen audio upload ล้มเหลว: ${uploadData.message ?? uploadRes.status}`;
      console.error(`[generate-with-bg] audio upload failed (${uploadRes.status}): ${JSON.stringify(uploadData).slice(0, 300)}`);
      return NextResponse.json(
        { error: msg, retryable: false, code: keyRejected ? "invalid_key" : "fatal", provider: "heygen" },
        { status: keyRejected ? 401 : 500 }
      );
    }

    const audioAssetId = uploadData.data.id as string;
    console.log("[generate-with-bg] audioAssetId:", audioAssetId);
    voiceInput = { type: "audio", audio_asset_id: audioAssetId };
  } else {
    voiceInput = { type: "text", input_text: text, voice_id: voiceId, speed: 1.0 };
  }

  // Step 3: Generate
  const payload: Record<string, unknown> = {
    video_inputs: [{
      character: {
        type: "avatar",
        avatar_id: avatarId,
        avatar_style: "normal",
        offset: { x: hgOffsetX, y: hgOffsetY },
        scale,
        matting: true,
      },
      voice: voiceInput,
      ...(background ? { background } : {}),
    }],
    dimension: AVATAR_GEN_DIMENSION,
  };

  console.log("[generate-with-bg] generate payload:", JSON.stringify(payload));
  // HeyGen generate budget: 60s, NO retries — a duplicated generate would
  // spend the user's HeyGen credits twice. returnHttpErrors → map status below.
  let genRes = await fetchWithBudget("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, { provider: "heygen", timeoutMs: 60_000, retries: 0, wallClockMs: 65_000, returnHttpErrors: true });
  let genData = await genRes.json();
  console.log("[generate-with-bg] generate response:", genRes.status, JSON.stringify(genData));

  // One-shot fallback: some accounts/plans reject 1080 — retry once at 720×1280.
  if (!genRes.ok && isResolutionFallbackError(JSON.stringify(genData?.error ?? genData))) {
    console.warn("[generate-with-bg] 1080 generate rejected (resolution/plan) — retrying once at 720x1280 fallback");
    payload.dimension = AVATAR_GEN_FALLBACK_DIMENSION;
    genRes = await fetchWithBudget("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": heygenKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, { provider: "heygen", timeoutMs: 60_000, retries: 0, wallClockMs: 65_000, returnHttpErrors: true });
    genData = await genRes.json();
    console.log("[generate-with-bg] fallback generate response:", genRes.status, JSON.stringify(genData));
  }

  if (!genRes.ok || !genData.data?.video_id) {
    if (!genRes.ok) {
      // §8 mapping: 401→invalid_key(401)+missingKey (key modal ถูกต้องเมื่อ key
      // ถูกปฏิเสธจริง), 402/403→quota(402) เช่น credit หมด — ไม่เปิด modal ใส่ key,
      // 429→rate_limit(429), 5xx→transient(503)
      const pErr = providerError(
        classifyHttpStatus(genRes.status),
        "heygen",
        `HeyGen generate failed (${genRes.status}): ${JSON.stringify(genData.error ?? genData).slice(0, 300)}`,
        { status: genRes.status },
      );
      const { body: errBody, status } = toErrorResponse(pErr);
      return NextResponse.json(errBody, { status });
    }
    // 200 แต่ไม่มี video_id — response ผิดรูป ไม่ใช่ปัญหา key (อย่าเปิด modal ใส่ key ซ้ำ)
    return NextResponse.json(
      { error: `HeyGen generate failed: ${JSON.stringify(genData?.error ?? genData)}`, retryable: false },
      { status: 500 }
    );
  }

  return NextResponse.json({ videoId: genData.data.video_id, bgAssetId });
}
