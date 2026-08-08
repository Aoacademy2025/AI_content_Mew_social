export type MusicTrackKind = "system" | "user";

/** Shared editor payload for both script and uploaded-clip projects. */
export function buildBgmSelectionInput(
  musicTrack: string | null | undefined,
  kind: MusicTrackKind,
  volume: number,
): { bgmFile?: string; bgmVolume?: number } {
  const filename = musicTrack?.trim();
  if (!filename) return {};
  const safeVolume = Number.isFinite(volume)
    ? Math.min(1, Math.max(0, volume))
    : 0.12;
  return {
    bgmFile: kind === "user" ? `/api/music/${filename}` : `/music/${filename}`,
    bgmVolume: safeVolume,
  };
}
