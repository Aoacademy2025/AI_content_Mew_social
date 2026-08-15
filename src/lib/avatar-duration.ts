export type AvatarDurationViolation = {
  clipSec: number;
  introSec: number;
  tailSec: number;
  message: string;
};

/**
 * HeyGen bookend-both needs a real middle interval. If intro + outro reaches
 * the whole clip, the two generated performances overlap; the compositor then
 * clamps the tail and its lip timing no longer matches the original timeline.
 */
export function avatarBookendDurationViolation(input: {
  mode?: string | null;
  audioDurationMs: number;
  introSec: number;
  tailSec: number;
}): AvatarDurationViolation | null {
  if (input.mode !== "bookend-both" || !Number.isFinite(input.audioDurationMs) || input.audioDurationMs <= 0) {
    return null;
  }
  const clipSec = input.audioDurationMs / 1000;
  const introSec = Math.max(0, input.introSec);
  const tailSec = Math.max(0, input.tailSec);
  if (introSec + tailSec < clipSec) return null;
  return {
    clipSec,
    introSec,
    tailSec,
    message: `คลิปยาว ${clipSec.toFixed(1)} วิ สั้นเกินไปสำหรับ Intro ${introSec} วิ + Outro ${tailSec} วิ — ลดวินาที intro/outro หรือใช้สคริปต์ยาวขึ้น`,
  };
}
