import crypto from "crypto";
import fs from "fs";
import path from "path";

export const VOICE_PREVIEW_TEXT = "สวัสดีครับ นี่คือตัวอย่างเสียงสำหรับวิดีโอของคุณ";
export const MAX_VOICE_PREVIEW_CHARS = 90;

export type VoicePreviewProvider = "gemini" | "elevenlabs";

export function normalizeVoicePreviewText(input: unknown) {
  const text = typeof input === "string" && input.trim()
    ? input.trim()
    : VOICE_PREVIEW_TEXT;
  return text.slice(0, MAX_VOICE_PREVIEW_CHARS);
}

export function getVoicePreviewCachePath({
  provider,
  userId,
  voiceKey,
  text,
  ext,
  cacheVersion,
}: {
  provider: VoicePreviewProvider;
  userId: string;
  voiceKey: string;
  text: string;
  ext: "mp3" | "wav";
  // Optional bust: appended to the hash input ONLY when provided, so existing
  // callers stay byte-identical. Bump when the bytes behind an identical key
  // change (new voice model semantics, post-processing, ...).
  cacheVersion?: string;
}) {
  const rendersDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const hashInput = cacheVersion
    ? [provider, userId, voiceKey, text, cacheVersion]
    : [provider, userId, voiceKey, text];
  const hash = crypto
    .createHash("sha256")
    .update(hashInput.join("\n"))
    .digest("hex")
    .slice(0, 24);
  const filename = `voice-preview-${provider}-${hash}.${ext}`;
  return {
    filePath: path.join(rendersDir, filename),
    voiceUrl: `/api/renders/${filename}`,
  };
}

export function cachedVoicePreview(filePath: string, voiceUrl: string) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return { voiceUrl, cached: true };
    }
  } catch {}
  return null;
}
