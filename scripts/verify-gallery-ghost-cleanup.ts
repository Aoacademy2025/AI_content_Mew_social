/**
 * verify-gallery-ghost-cleanup.ts
 *
 * Regression guard for BUG 1b: avatar clips lingering in the gallery as unplayable "ghost"
 * cards after their local render file was swept off disk.
 *
 * Root cause: the lazy cleanup in /api/videos GET treated a clip as having a file when
 * `localFileExists(videoUrl) || localFileExists(avatarVideoUrl)` was true, and localFileExists
 * returns true for ANY remote (http/https) URL. Avatar clips carry a remote HeyGen
 * `avatarVideoUrl`, so the missing local `videoUrl` render was never detected → ghost.
 *
 * Run: npx tsx scripts/verify-gallery-ghost-cleanup.ts
 */
import { isGalleryClipFileMissing } from "../src/lib/gallery-clip-cleanup";

// Mirrors the route's localFileExists semantics: remote URLs are assumed present; local URLs
// are present only if listed in `existingLocal`.
function makeLocalFileExists(existingLocal: Set<string>) {
  return (url: string | null): boolean => {
    if (!url) return false;
    if (url.startsWith("http://") || url.startsWith("https://")) return true;
    return existingLocal.has(url);
  };
}

let failures = 0;
function check(name: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name} (got=${got}, want=${want})`);
}

const HEYGEN = "https://files2.heygen.ai/aws_pacific/avatar_tmp/abc.mp4";
const RENDER = "/api/renders/render-123.mp4";

// THE BUG: avatar clip, local render swept, remote avatarVideoUrl present.
// Must be reported missing (so it gets cleaned up), NOT rescued by the remote URL.
check(
  "avatar clip with swept local render + remote avatarVideoUrl → MISSING",
  isGalleryClipFileMissing({ videoUrl: RENDER, avatarVideoUrl: HEYGEN }, makeLocalFileExists(new Set())),
  true,
);

// Healthy avatar clip: local render still on disk → kept.
check(
  "avatar clip with local render present → not missing",
  isGalleryClipFileMissing({ videoUrl: RENDER, avatarVideoUrl: HEYGEN }, makeLocalFileExists(new Set([RENDER]))),
  false,
);

// Normal (non-avatar) clip: local render present → kept.
check(
  "normal clip with local render present → not missing",
  isGalleryClipFileMissing({ videoUrl: RENDER, avatarVideoUrl: null }, makeLocalFileExists(new Set([RENDER]))),
  false,
);

// Normal clip: local render gone, no avatar → missing.
check(
  "normal clip with local render gone, no avatar → MISSING",
  isGalleryClipFileMissing({ videoUrl: RENDER, avatarVideoUrl: null }, makeLocalFileExists(new Set())),
  true,
);

// Remote-hosted videoUrl (cannot be verified server-side) → assumed present, kept.
check(
  "clip with remote videoUrl → not missing (cannot verify remote)",
  isGalleryClipFileMissing({ videoUrl: "https://cdn.example.com/v.mp4", avatarVideoUrl: null }, makeLocalFileExists(new Set())),
  false,
);

// Avatar-only record (no composed render): falls back to avatarVideoUrl.
check(
  "avatar-only record, remote avatarVideoUrl → not missing (only source we have)",
  isGalleryClipFileMissing({ videoUrl: null, avatarVideoUrl: HEYGEN }, makeLocalFileExists(new Set())),
  false,
);
check(
  "avatar-only record, local avatarVideoUrl gone → MISSING",
  isGalleryClipFileMissing({ videoUrl: null, avatarVideoUrl: "/api/renders/avatar-9.mp4" }, makeLocalFileExists(new Set())),
  true,
);

// Empty record → missing.
check(
  "record with no urls → MISSING",
  isGalleryClipFileMissing({ videoUrl: null, avatarVideoUrl: null }, makeLocalFileExists(new Set())),
  true,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
