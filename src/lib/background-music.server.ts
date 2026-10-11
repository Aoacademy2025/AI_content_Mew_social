import { prisma } from "@/lib/prisma";
import {
  backgroundMusicTrackFilename,
  normalizeBackgroundMusicEdit,
  speechSegments,
  type SubtitleAudioMix,
} from "@/lib/background-music";
import type { VideoJobPreviewData } from "@/lib/mcp/video-job";

/**
 * EP5 U7 (HERO-71), server half: which music a user may pick, and the burn's audio mix built from
 * server-trusted data only. Both front-ends reach the export through `enqueueEditorExport`, which
 * calls `buildBackgroundMusicAudioMix`; the MCP tool lists / resolves tracks with the helpers here.
 */

export type BackgroundMusicTrackOption = {
  trackId: string;
  title: string;
  kind: "system" | "user";
  mood: string | null;
  /** The library path stored in the draft (`/music/<f>` system, `/api/music/<f>` own upload). */
  track: string;
};

const MAX_SYSTEM_TRACKS = 500;
const MAX_USER_TRACKS = 200;

/** The library the user can choose from: every system track plus their OWN uploads only. */
export async function listBackgroundMusicTracks(userId: string): Promise<BackgroundMusicTrackOption[]> {
  const [system, own] = await Promise.all([
    prisma.music.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_SYSTEM_TRACKS,
      select: { id: true, title: true, filename: true, mood: true },
    }),
    prisma.userMusic.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_USER_TRACKS,
      select: { id: true, title: true, filename: true },
    }),
  ]);
  return [
    ...system.map((track) => ({
      trackId: track.id,
      title: track.title,
      kind: "system" as const,
      mood: track.mood ?? null,
      track: `/music/${track.filename}`,
    })),
    ...own.map((track) => ({
      trackId: track.id,
      title: track.title,
      kind: "user" as const,
      mood: null,
      track: `/api/music/${track.filename}`,
    })),
  ];
}

/** One library entry by its id: a system track, or the caller's OWN upload (never another's). */
export async function findBackgroundMusicTrackById(userId: string, trackId: string): Promise<BackgroundMusicTrackOption | null> {
  const system = await prisma.music.findUnique({ where: { id: trackId }, select: { id: true, title: true, filename: true, mood: true } });
  if (system) {
    return { trackId: system.id, title: system.title, kind: "system", mood: system.mood ?? null, track: `/music/${system.filename}` };
  }
  const own = await prisma.userMusic.findFirst({ where: { id: trackId, userId }, select: { id: true, title: true, filename: true } });
  return own ? { trackId: own.id, title: own.title, kind: "user", mood: null, track: `/api/music/${own.filename}` } : null;
}

/** The library entry a stored path names (for display), owner-scoped like the id lookup. */
export async function findBackgroundMusicTrackByPath(userId: string, track: string): Promise<BackgroundMusicTrackOption | null> {
  const parsed = backgroundMusicTrackFilename(track);
  if (!parsed) return null;
  if (parsed.kind === "user") {
    const own = await prisma.userMusic.findFirst({ where: { filename: parsed.filename, userId }, select: { id: true, title: true, filename: true } });
    if (own) return { trackId: own.id, title: own.title, kind: "user", mood: null, track };
  }
  const system = await prisma.music.findFirst({ where: { filename: parsed.filename }, select: { id: true, title: true, mood: true } });
  return system ? { trackId: system.id, title: system.title, kind: "system", mood: system.mood ?? null, track } : null;
}

/**
 * May this user put `track` on their video? A system track, their own upload (owner-scoped — never
 * another account's file), or the base render's own music (already in this video).
 */
export async function backgroundMusicTrackAllowed(
  userId: string,
  track: string,
  baseBgmFile: unknown,
): Promise<boolean> {
  if (typeof baseBgmFile === "string" && baseBgmFile === track) return true;
  const parsed = backgroundMusicTrackFilename(track);
  if (!parsed) return false;
  const system = await prisma.music.findFirst({ where: { filename: parsed.filename }, select: { id: true } });
  // `/music/<f>` is a system path only; `/api/music/<f>` serves both kinds.
  if (system) return true;
  if (parsed.kind === "system") return false;
  const own = await prisma.userMusic.findFirst({ where: { filename: parsed.filename, userId }, select: { id: true } });
  return !!own;
}

/** The voice-only track under the base mix: the base config's voice, else the preview's voice. */
export function backgroundMusicVoiceFile(preview: Pick<VideoJobPreviewData, "config" | "voiceUrl">): string | null {
  const configVoice = preview.config?.voiceFile;
  if (typeof configVoice === "string" && configVoice.trim()) return configVoice;
  return typeof preview.voiceUrl === "string" && preview.voiceUrl.trim() ? preview.voiceUrl : null;
}

export type BackgroundMusicMixResult =
  | { ok: true; audioMix: SubtitleAudioMix }
  | { ok: false; error: "invalid_background_music" | "background_music_unavailable"; message: string };

/**
 * The export's `audioMix`, from the user's edit + the export source's preview. The voice track,
 * its volume and the duck timing all come from the server-held preview; only the track choice,
 * volume and ducking flag come from the caller, and the track is checked against the library.
 */
export async function buildBackgroundMusicAudioMix(
  userId: string,
  value: unknown,
  preview: Pick<VideoJobPreviewData, "config" | "voiceUrl" | "words" | "captions">,
): Promise<BackgroundMusicMixResult> {
  const edit = normalizeBackgroundMusicEdit(value);
  if (!edit) return { ok: false, error: "invalid_background_music", message: "ข้อมูลเพลงประกอบไม่ถูกต้อง" };
  if (edit.track !== null && !(await backgroundMusicTrackAllowed(userId, edit.track, preview.config?.bgmFile))) {
    return { ok: false, error: "invalid_background_music", message: "ไม่พบเพลงที่เลือกในคลังเพลง — เลือกเพลงใหม่แล้วลองอีกครั้ง" };
  }
  const voiceFile = backgroundMusicVoiceFile(preview);
  if (!voiceFile) {
    return {
      ok: false,
      error: "background_music_unavailable",
      message: "คลิปนี้เปลี่ยนเพลงไม่ได้ เพราะไม่พบไฟล์เสียงพากย์แยก — ส่งออกด้วยเพลงเดิมได้ตามปกติ",
    };
  }
  const rawVoiceVolume = preview.config?.voiceVolume;
  const voiceVolume = typeof rawVoiceVolume === "number" && Number.isFinite(rawVoiceVolume)
    ? Math.min(2, Math.max(0, rawVoiceVolume))
    : 1;
  const duckSegments = edit.ducking && edit.track
    ? speechSegments({ words: preview.words, captions: preview.captions })
    : [];
  return {
    ok: true,
    audioMix: {
      voiceFile,
      voiceVolume,
      ...(edit.track ? { bgmFile: edit.track } : {}),
      bgmVolume: edit.volume,
      ducking: edit.ducking,
      ...(duckSegments.length ? { duckSegments } : {}),
    },
  };
}
