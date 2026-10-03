// G24 — safe ffprobe/ffmpeg input options for user-supplied media.
//
// Without `-f`, ffmpeg picks the demuxer from the file's bytes. An HLS playlist or an
// ffconcat script uploaded as "video.mp4" is then opened as a playlist, and ffmpeg follows
// its entries: other local files (ffmpeg 4.4 on prod reads a sibling file named in an
// .m3u8; every version opens files named in an ffconcat) or network URLs (SSRF).
//
// Every ffprobe/ffmpeg call on uploaded media therefore gets, BEFORE its `-i` (they are
// input options):
//   • `-protocol_whitelist file` — the input may only be opened through the file protocol;
//   • `-f <demuxer>` from SAFE_INPUT_DEMUXERS — never hls, concat, or any playlist demuxer.
//
// The demuxer is chosen from the file's leading bytes when they match a format the route
// allows for that kind (so a real WebM saved as .mp4, or a PNG saved as .jpg, keeps working
// exactly as ffmpeg's auto-detection handled it before), otherwise from the route's
// validated extension. Either way the result is one of the six allowlisted demuxers, and a
// playlist simply fails to parse as mov/matroska/jpeg/png/webp.
import fs from "fs";

export const SAFE_INPUT_DEMUXERS = ["mov", "matroska", "image2", "jpeg_pipe", "png_pipe", "webp_pipe"] as const;
export type SafeInputDemuxer = (typeof SAFE_INPUT_DEMUXERS)[number];
export type UploadMediaKind = "image" | "video";
export type MediaContainer = "isobmff" | "matroska" | "jpeg" | "png" | "webp";

const CONTAINER_KIND: Record<MediaContainer, UploadMediaKind> = {
  isobmff: "video",
  matroska: "video",
  jpeg: "image",
  png: "image",
  webp: "image",
};

// Mirrors the routes' extension allowlists (broll-window/upload: jpg/jpeg/png/webp +
// mp4/mov/webm; upload-avatar: mp4/mov/webm).
const CONTAINER_BY_EXTENSION = new Map<string, MediaContainer>([
  ["mp4", "isobmff"],
  ["mov", "isobmff"],
  ["webm", "matroska"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["png", "png"],
  ["webp", "webp"],
]);

// Atom types that open a QuickTime/ISO-BMFF file (the 4 bytes after the first box size).
const ISO_BMFF_LEADING_ATOMS = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

/** Input options for one ffprobe/ffmpeg input. Place them before `-i` (or the probe path). */
export function safeInputArgs(demuxer: SafeInputDemuxer): string[] {
  const args = ["-protocol_whitelist", "file", "-f", demuxer];
  // image2 treats its path as a %d / glob pattern unless told otherwise.
  if (demuxer === "image2") args.push("-pattern_type", "none");
  return args;
}

/** Recognises only the containers the upload routes accept; anything else → null. */
export function sniffMediaContainer(head: Uint8Array): MediaContainer | null {
  const ascii = (start: number, end: number) => Buffer.from(head.subarray(start, end)).toString("latin1");
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === "PNG" && head[4] === 0x0d && head[5] === 0x0a
    && head[6] === 0x1a && head[7] === 0x0a) return "png";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "matroska";
  if (head.length >= 8 && ISO_BMFF_LEADING_ATOMS.has(ascii(4, 8))) return "isobmff";
  return null;
}

function demuxerFor(container: MediaContainer, filePath: string): SafeInputDemuxer {
  switch (container) {
    case "isobmff":
      return "mov";
    case "matroska":
      return "matroska";
    case "png":
      return "png_pipe";
    case "webp":
      return "webp_pipe";
    case "jpeg":
      // image2 is what ffmpeg auto-detects for real-world JPEGs (and the only one that
      // handles an MP4 appended after EOI — "motion photos" — on prod's ffmpeg 4.4), but a
      // forced image2 picks its decoder from the path's extension, so it is only right when
      // that extension says JPEG.
      return /\.jpe?g$/i.test(filePath) ? "image2" : "jpeg_pipe";
  }
}

function readHead(filePath: string, bytes = 16): Uint8Array {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The input demuxer for an uploaded file on disk. `routeExt` is the extension the route
 * already validated against its allowlist; `kind` is what the route decided the upload is.
 * Returns null only when `routeExt` is not an allowed extension for `kind`.
 */
export function resolveSafeInputDemuxer(
  filePath: string,
  routeExt: string,
  kind: UploadMediaKind,
): SafeInputDemuxer | null {
  const byExtension = CONTAINER_BY_EXTENSION.get(routeExt.toLowerCase());
  if (!byExtension || CONTAINER_KIND[byExtension] !== kind) return null;
  let sniffed: MediaContainer | null = null;
  try {
    sniffed = sniffMediaContainer(readHead(filePath));
  } catch {
    // Unreadable here means unreadable for ffprobe too; the extension's demuxer will fail.
  }
  const container = sniffed && CONTAINER_KIND[sniffed] === kind ? sniffed : byExtension;
  return demuxerFor(container, filePath);
}
