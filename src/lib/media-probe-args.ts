// G24 — safe ffprobe/ffmpeg input options for user-supplied media.
//
// Without `-f`, ffmpeg picks the demuxer from the file's bytes. An HLS playlist or an
// ffconcat script uploaded as "video.mp4" is then opened as a playlist, and ffmpeg follows
// its entries: other local files (ffmpeg 4.4 on prod reads a sibling file named in an
// .m3u8; every version opens files named in an ffconcat) or network URLs (SSRF).
//
// Every ffprobe/ffmpeg call on user media therefore gets, BEFORE its `-i` (they are input
// options):
//   • `-protocol_whitelist file` (or `pipe` for stdin) — the input may only be opened
//     through that one protocol;
//   • `-f <demuxer>` from SAFE_INPUT_DEMUXERS — never hls, concat, or any playlist demuxer.
//
// Three ways to pick the demuxer:
//   • resolveSafeInputDemuxer (PR-0 upload routes): the file's leading bytes when they match
//     a format the route allows for that kind, otherwise the route's validated extension.
//   • sniffSafeInputDemuxer / bufferSafeInputDemuxer (ingest, downloads): the leading bytes
//     only. Anything without a recognised media signature is refused. Use this before a
//     file is stored or handed to code that still auto-detects, because a resyncing
//     demuxer (-f mp3, -f aac) happily finds audio frames after an "#EXTM3U" header that
//     auto-detection would open as a playlist.
//   • resolveStoredMediaDemuxer (readers of files already on disk): the leading bytes,
//     otherwise the file's own extension — so legacy files keep their old behaviour, and a
//     playlist that was stored before the ingest gate just fails to parse.
import fs from "fs";

export const SAFE_INPUT_DEMUXERS = [
  "mov", "matroska", "image2", "jpeg_pipe", "png_pipe", "webp_pipe",
  "mp3", "wav", "ogg", "aac", "flac",
] as const;
export type SafeInputDemuxer = (typeof SAFE_INPUT_DEMUXERS)[number];
export type MediaKind = "image" | "video" | "audio";
/** @deprecated PR-0 name; the upload routes pass "image" or "video". */
export type UploadMediaKind = MediaKind;
export type MediaContainer =
  | "isobmff" | "matroska" | "jpeg" | "png" | "webp"
  | "mp3" | "wav" | "ogg" | "adts" | "flac";

// Which kinds of media each container can carry. ISO-BMFF and Matroska hold either (an
// .m4a is ISO-BMFF; a browser voice recording is WebM/Opus).
const CONTAINER_KINDS: Record<MediaContainer, readonly MediaKind[]> = {
  isobmff: ["video", "audio"],
  matroska: ["video", "audio"],
  jpeg: ["image"],
  png: ["image"],
  webp: ["image"],
  mp3: ["audio"],
  wav: ["audio"],
  ogg: ["audio"],
  adts: ["audio"],
  flac: ["audio"],
};

// The extensions the app accepts, with the container each one names and the kinds it may
// be used for. Mirrors the routes' allowlists (broll-window/upload: jpg/jpeg/png/webp +
// mp4/mov/webm; upload-avatar + videos/upload: mp4/mov/webm; music/upload: mp3/wav/ogg/
// aac/m4a; voice + TTS files: mp3/wav/m4a/webm/ogg/flac).
const EXTENSIONS = new Map<string, { container: MediaContainer; kinds: readonly MediaKind[] }>([
  ["mp4", { container: "isobmff", kinds: ["video", "audio"] }],
  ["mov", { container: "isobmff", kinds: ["video"] }],
  ["m4a", { container: "isobmff", kinds: ["audio"] }],
  ["webm", { container: "matroska", kinds: ["video", "audio"] }],
  ["jpg", { container: "jpeg", kinds: ["image"] }],
  ["jpeg", { container: "jpeg", kinds: ["image"] }],
  ["png", { container: "png", kinds: ["image"] }],
  ["webp", { container: "webp", kinds: ["image"] }],
  ["mp3", { container: "mp3", kinds: ["audio"] }],
  ["wav", { container: "wav", kinds: ["audio"] }],
  ["ogg", { container: "ogg", kinds: ["audio"] }],
  ["aac", { container: "adts", kinds: ["audio"] }],
  ["flac", { container: "flac", kinds: ["audio"] }],
]);

// Atom types that open a QuickTime/ISO-BMFF file (the 4 bytes after the first box size).
const ISO_BMFF_LEADING_ATOMS = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

/** Input options for one ffprobe/ffmpeg input. Place them before `-i` (or the probe path). */
export function safeInputArgs(demuxer: SafeInputDemuxer, protocol: "file" | "pipe" = "file"): string[] {
  const args = ["-protocol_whitelist", protocol, "-f", demuxer];
  // image2 treats its path as a %d / glob pattern unless told otherwise.
  if (demuxer === "image2") args.push("-pattern_type", "none");
  return args;
}

const ascii = (b: Uint8Array, start: number, end: number) => Buffer.from(b.subarray(start, end)).toString("latin1");

function isAdtsHeader(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0;
}

// An MPEG-1/2/2.5 audio frame header: 11-bit sync, a defined version and layer, and a
// bitrate / sample-rate index that is not "bad".
function isMpegAudioFrame(b: Uint8Array): boolean {
  if (b.length < 4 || b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return false;
  const version = (b[1] >> 3) & 0x03;
  const layer = (b[1] >> 1) & 0x03;
  const bitrate = (b[2] >> 4) & 0x0f;
  const sampleRate = (b[2] >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrate !== 0x0f && sampleRate !== 3;
}

/** The container named by the bytes at offset 0, without looking past an ID3 tag. */
function containerAtStart(b: Uint8Array): MediaContainer | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a
    && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && ["RIFF", "RF64", "BW64"].includes(ascii(b, 0, 4)) && ascii(b, 8, 12) === "WAVE") return "wav";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return "ogg";
  if (b.length >= 4 && ascii(b, 0, 4) === "fLaC") return "flac";
  if (b.length >= 8 && ISO_BMFF_LEADING_ATOMS.has(ascii(b, 4, 8))) return "isobmff";
  if (isAdtsHeader(b)) return "adts";
  if (isMpegAudioFrame(b)) return "mp3";
  return null;
}

// ID3v2, checked exactly as ffmpeg's ff_id3v2_match / ff_id3v2_tag_len do (ffmpeg skips
// one such tag before it probes the format, so "ID3…#EXTM3U" auto-detects as HLS).
function isId3v2Header(b: Uint8Array): boolean {
  return b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b[3] !== 0xff && b[4] !== 0xff
    && (b[6] & 0x80) === 0 && (b[7] & 0x80) === 0 && (b[8] & 0x80) === 0 && (b[9] & 0x80) === 0;
}

function id3v2TagLength(b: Uint8Array): number {
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + ((b[5] & 0x10) ? 10 : 0);
}

const MAX_ID3_TAGS = 4;
const MAX_ID3_PADDING = 64 * 1024;
// ffmpeg's probe buffer never grows past 1 MiB (PROBE_BUF_MAX).
const PROBE_WINDOW = 1 << 20;
// Two demuxers built with libxml2 (dash; imf from ffmpeg 5.1) look for their manifest
// ANYWHERE in the probe buffer — as a C string, so up to its first NUL — and score as high
// as a real container. Both open the files their manifest names. A media signature at byte
// 0 therefore does not rule them out on its own.
const MANIFEST_MARKERS = ["<mpd", "<compositionplaylist"];

function manifestMarkerAt(read: (offset: number, length: number) => Uint8Array, offset: number): boolean {
  const window = read(offset, PROBE_WINDOW);
  const nul = window.indexOf(0);
  const cString = Buffer.from(nul === -1 ? window : window.subarray(0, nul)).toString("latin1").toLowerCase();
  return MANIFEST_MARKERS.some((marker) => cString.includes(marker));
}

/**
 * Sniff through a reader of (offset, length) → bytes. Behind an ID3v2 tag only audio frames
 * (MPEG audio, ADTS) or FLAC count, and they must start right after the tag(s) and any
 * zero padding: anything else there — a playlist, a script, junk — is refused. So is a
 * file whose probe window carries a DASH/IMF manifest (see MANIFEST_MARKERS).
 */
function sniffWithReader(read: (offset: number, length: number) => Uint8Array): MediaContainer | null {
  if (manifestMarkerAt(read, 0)) return null;
  const head = read(0, 16);
  if (!isId3v2Header(head)) return containerAtStart(head);
  let offset = 0;
  for (let tags = 0; tags < MAX_ID3_TAGS; tags++) {
    const header = read(offset, 10);
    if (!isId3v2Header(header)) break;
    offset += id3v2TagLength(header);
    // ffmpeg probes from the end of the first tag.
    if (manifestMarkerAt(read, offset)) return null;
  }
  const padding = read(offset, MAX_ID3_PADDING);
  let skip = 0;
  while (skip < padding.length && padding[skip] === 0) skip++;
  if (skip === MAX_ID3_PADDING) return null;
  const after = read(offset + skip, 16);
  if (isAdtsHeader(after)) return "adts";
  if (isMpegAudioFrame(after)) return "mp3";
  if (after.length >= 4 && ascii(after, 0, 4) === "fLaC") return "flac";
  return null;
}

/** Recognises only the containers the app accepts; anything else → null. */
export function sniffMediaBuffer(buf: Uint8Array): MediaContainer | null {
  return sniffWithReader((offset, length) =>
    offset >= buf.length ? new Uint8Array(0) : buf.subarray(offset, Math.min(buf.length, offset + length)));
}

/** PR-0 name for sniffing a buffer that holds (at least) the start of the file. */
export const sniffMediaContainer = sniffMediaBuffer;

/** Sniffs a file on disk; an unreadable file → null. */
export function sniffMediaFile(filePath: string): MediaContainer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const handle = fd;
    return sniffWithReader((offset, length) => {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(handle, buf, 0, length, offset);
      return buf.subarray(0, n);
    });
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
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
    case "mp3":
      return "mp3";
    case "wav":
      return "wav";
    case "ogg":
      return "ogg";
    case "adts":
      return "aac";
    case "flac":
      return "flac";
  }
}

const carries = (container: MediaContainer, kinds: readonly MediaKind[]) =>
  CONTAINER_KINDS[container].some((k) => kinds.includes(k));

/**
 * The input demuxer for an uploaded file on disk. `routeExt` is the extension the route
 * already validated against its allowlist; `kind` is what the route decided the upload is.
 * Returns null only when `routeExt` is not an allowed extension for `kind`.
 */
export function resolveSafeInputDemuxer(
  filePath: string,
  routeExt: string,
  kind: MediaKind,
): SafeInputDemuxer | null {
  const byExtension = EXTENSIONS.get(routeExt.toLowerCase());
  if (!byExtension || !byExtension.kinds.includes(kind)) return null;
  // Unreadable here means unreadable for ffprobe too; the extension's demuxer will fail.
  const sniffed = sniffMediaFile(filePath);
  const container = sniffed && carries(sniffed, [kind]) ? sniffed : byExtension.container;
  return demuxerFor(container, filePath);
}

/** Strict: the demuxer named by the file's own bytes, or null. No extension fallback. */
export function sniffSafeInputDemuxer(filePath: string, kinds: readonly MediaKind[]): SafeInputDemuxer | null {
  const sniffed = sniffMediaFile(filePath);
  return sniffed && carries(sniffed, kinds) ? demuxerFor(sniffed, filePath) : null;
}

/** Strict, for bytes that will be written to a temp file or piped (no extension to trust). */
export function bufferSafeInputDemuxer(buf: Uint8Array, kinds: readonly MediaKind[]): SafeInputDemuxer | null {
  const sniffed = sniffMediaBuffer(buf);
  return sniffed && carries(sniffed, kinds) ? demuxerFor(sniffed, "") : null;
}

/**
 * For a file already stored on disk (possibly before the ingest gate existed): its own
 * bytes when they name a container of the wanted kinds, otherwise its own extension when
 * that is an accepted media extension of those kinds, otherwise null (refuse to read it).
 */
export function resolveStoredMediaDemuxer(filePath: string, kinds: readonly MediaKind[]): SafeInputDemuxer | null {
  const sniffed = sniffSafeInputDemuxer(filePath, kinds);
  if (sniffed) return sniffed;
  const ext = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase() ?? "";
  const byExtension = EXTENSIONS.get(ext);
  if (!byExtension || !byExtension.kinds.some((k) => kinds.includes(k))) return null;
  return demuxerFor(byExtension.container, filePath);
}
