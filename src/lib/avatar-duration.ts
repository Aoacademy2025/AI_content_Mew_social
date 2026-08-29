export type AvatarDurationViolation = {
  clipSec: number;
  introSec: number;
  tailSec: number;
  message: string;
};

export const FULL_AVATAR_MAX_DURATION_SEC = 5 * 60;

export type AvatarFullDurationViolation = {
  code: "full_avatar_duration_unsupported";
  durationSec: number;
  maxDurationSec: number;
  message: string;
  userAction: string;
};

/**
 * Public full-avatar completion envelope.
 *
 * Production evidence on 2026-08-29: 167 successful jobs reached 308.9s at
 * the sparse edge, while a 350.8s job exhausted the supported composite path.
 * The customer-facing boundary deliberately rounds down to five minutes so an
 * accepted job has operating headroom instead of depending on an outlier.
 */
export function avatarFullDurationViolation(input: {
  mode?: string | null;
  durationSec: number;
}): AvatarFullDurationViolation | null {
  if (input.mode !== "full" || !Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    return null;
  }
  if (input.durationSec <= FULL_AVATAR_MAX_DURATION_SEC) return null;

  const durationSec = Math.round(input.durationSec * 10) / 10;
  return {
    code: "full_avatar_duration_unsupported",
    durationSec,
    maxDurationSec: FULL_AVATAR_MAX_DURATION_SEC,
    message: `Full Avatar รองรับคลิปไม่เกิน 5 นาที แต่คลิปนี้ยาวประมาณ ${(durationSec / 60).toFixed(1)} นาที`,
    userAction: "เปลี่ยนเป็น Bookend แบบเปิดคลิปหรือเปิด+ปิดได้ โดยไม่ต้องสร้างโปรเจกต์ใหม่",
  };
}

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
