// Decide whether a gallery clip has become a "ghost": its record still exists but the
// playable file is gone, so it shows as READY yet cannot be played.
//
// The clip's REAL output is its composed render (`videoUrl`). `avatarVideoUrl` is only the
// raw HeyGen talking-head segment, delivered as a time-limited signed URL that expires after
// a few days. So a remote `avatarVideoUrl` must NOT keep a clip alive once the local render
// has been swept off disk — otherwise avatar clips linger forever as unplayable cards.
//
// Fall back to `avatarVideoUrl` ONLY when there is no `videoUrl` at all (avatar-only record).

export interface GalleryClipFiles {
  videoUrl: string | null;
  avatarVideoUrl: string | null;
}

/**
 * @param localFileExists Resolves a candidate URL to a presence boolean. By convention it
 *   returns `true` for remote (http/https) URLs — they cannot be verified server-side without
 *   a network call, so we assume present rather than wrongly deleting them. Local paths are
 *   checked against the filesystem by the caller.
 * @returns true when the clip's primary playable file is missing (record should be cleaned up).
 */
export function isGalleryClipFileMissing(
  clip: GalleryClipFiles,
  localFileExists: (url: string | null) => boolean,
): boolean {
  const primaryUrl = clip.videoUrl || clip.avatarVideoUrl;
  return !localFileExists(primaryUrl);
}
