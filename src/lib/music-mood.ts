// music-mood.ts — admin mood tag on Music tracks + the editor's pack-suggested
// default track (Brands wave 1, Task 6). Browser-safe (no server-only imports):
// the admin page and the editor client hook both import this directly.

import { MUSIC_MOODS, type MusicMood } from "@/lib/style-pack-catalog";

/** One Thai label per MusicMood (admin copy, exact per the task brief) + the
 *  "unspecified" choice shown when a track has no mood tag. */
export const MUSIC_MOOD_LABELS: Record<MusicMood, string> = {
  ominous: "น่ากลัว / กดดัน",
  tense: "ตึงเครียด",
  emotional: "ซึ้ง / สะเทือนใจ",
  upbeat: "สดใส / มีพลัง",
  calm: "สงบ / ผ่อนคลาย",
  epic: "ยิ่งใหญ่",
  serious: "จริงจัง",
  lounge: "หรู / ชิล",
  traditional: "ไทยเดิม",
  eerie: "ลึกลับ / วังเวง",
};

export const MUSIC_MOOD_UNSPECIFIED_LABEL = "ไม่ระบุ";

export function isMusicMood(value: unknown): value is MusicMood {
  return typeof value === "string" && (MUSIC_MOODS as readonly string[]).includes(value);
}

export type MusicMoodInputResult =
  | { ok: true; provided: true; mood: MusicMood | null }
  | { ok: true; provided: false }
  | { ok: false };

/** Validate a mood value coming from an admin request (formData or JSON body).
 *  - `undefined` → the field was not sent at all; caller keeps the existing value.
 *  - `null` or `""` → explicitly "no mood".
 *  - anything else must be a member of MUSIC_MOODS, else `{ ok: false }` (→ the
 *    caller returns 400). Never throws. */
export function parseMusicMoodInput(value: unknown): MusicMoodInputResult {
  if (value === undefined) return { ok: true, provided: false };
  if (value === null || value === "") return { ok: true, provided: true, mood: null };
  if (isMusicMood(value)) return { ok: true, provided: true, mood: value };
  return { ok: false };
}

export type MusicTrackForMoodPick = { filename: string; mood?: string | null };

/** Pure choice for the editor: the first system track whose mood matches the
 *  Style Pack's suggested mood. No mood requested, no tracks, or no match →
 *  null. Never throws — a missing/unknown mood must never block a render. */
export function pickDefaultMusicTrack(
  tracks: readonly MusicTrackForMoodPick[] | null | undefined,
  mood: MusicMood | null | undefined,
): string | null {
  if (!mood || !tracks) return null;
  const match = tracks.find((track) => track.mood === mood);
  return match ? match.filename : null;
}

export type MusicMoodHintCarryDecision = { carry: true; mood: MusicMood } | { carry: false };

/** Fix round 1, finding 1: decide whether the Style Pack's suggested-mood hint
 *  should still be carried in the draft (so a later save/load can retry picking
 *  a default track), or dropped because it is already consumed.
 *  - No hint at all -> never carry.
 *  - A track is already chosen ("" and undefined both mean "not chosen yet";
 *    anything else — including `null`, an explicit "no music" — counts as
 *    chosen) -> drop, the hint is consumed.
 *  - Otherwise (a hint exists and no track is chosen yet) -> keep carrying,
 *    even if a prior pick attempt found no matching track: an admin may tag a
 *    matching track later, and the next load should be able to retry. Never
 *    throws. */
export function decideMusicMoodHintCarry(input: {
  musicMoodDefault: MusicMood | null | undefined;
  musicTrack: string | null | undefined;
}): MusicMoodHintCarryDecision {
  const mood = input.musicMoodDefault;
  if (!mood) return { carry: false };
  const trackAlreadyChosen = input.musicTrack !== undefined && input.musicTrack !== "";
  if (trackAlreadyChosen) return { carry: false };
  return { carry: true, mood };
}
