import fs from "node:fs";
import path from "node:path";
import { sniffMediaFile, type MediaContainer } from "@/lib/media-probe-args";
import { moveFile } from "@/lib/safe-download";
import { runBrollPipeline } from "@/lib/media-import/broll-pipeline";
import { processPresenterImport } from "@/lib/media-import/presenter-checks";
import type { MediaImportPurpose, UploadKind } from "@/lib/media-import/imports";

/**
 * Staging for `PUT /api/mcp-uploads/<token>` (Task 11) and the hand-off of a staged file to
 * T9's shared pipelines (`broll-pipeline.ts` / `presenter-checks.ts`).
 *
 * The PUT writes the body to `<cwd>/.tmp/media-import/<importId>.upload` (dir 0700,
 * file 0600, exclusive create) and leaves the MediaImport "pending"; the import lane in
 * mcp-video-worker (Task 12) later calls `processStagedUpload`. Both PM2 apps run on the
 * same host as the same user with the same cwd, so they share this directory.
 *
 * Not `os.tmpdir()`: the render route rewrites `process.env.TMPDIR` for the whole web process
 * on every render, so the web app staged into `.tmp/remotion/` while the worker looked in
 * `/tmp/` and every upload failed `upload_missing` (2026-10-04).
 * `MEDIA_IMPORT_STAGING_DIR` overrides the location (the verify scripts isolate with it).
 */

export function mediaImportStagingDir(): string {
  const override = process.env.MEDIA_IMPORT_STAGING_DIR;
  return override ? path.resolve(override) : path.join(process.cwd(), ".tmp", "media-import");
}

const IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The staged file for an import. Throws on an id that could leave the staging directory. */
export function stagedUploadPath(importId: string): string {
  if (!IMPORT_ID_PATTERN.test(importId)) throw new Error("invalid import id");
  return path.join(mediaImportStagingDir(), `${importId}.upload`);
}

export function removeStagedUpload(importId: string): void {
  try {
    fs.rmSync(stagedUploadPath(importId), { force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Create the staging dir 0700 and refuse one that is a symlink or not ours (shared /tmp). */
function ensureStagingDir(): string {
  const dir = mediaImportStagingDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
    throw new Error("media import staging directory is not a private directory");
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Hand a finished download (T10's `fetchMediaToTempFile`, source "url") to the same staging
 * slot an upload uses, so the import lane runs both sources through `processStagedUpload`.
 * The caller owns `fromPath` (a 0600 file in T10's private temp dir); it is renamed into place
 * (an exclusive copy + unlink when the two dirs are on different filesystems).
 */
export function stageFetchedFile(importId: string, fromPath: string): void {
  const dest = stagedUploadPath(importId);
  ensureStagingDir();
  moveFile(fromPath, dest);
}

/**
 * Free-disk floor for staging (security review A1): an upload is admitted only while the staging
 * filesystem — the root disk prod SQLite lives on — would keep at least this much free after
 * the kind's full byte cap lands. Below it the PUT refuses with 503 `storage_busy`, link kept.
 */
export const STAGING_MIN_FREE_BYTES = 5 * 1024 ** 3;

/**
 * True when the filesystem holding `dir` has room for `maxBytes` above the floor. Throws if it
 * cannot tell. PR-B fix round 1 (SEC-B1): the import lane also checks the disk each output is
 * written to (`public/renders/`, `stocks/`), not only staging.
 */
export function diskHasRoomFor(dir: string, maxBytes: number): boolean {
  const { bavail, bsize } = fs.statfsSync(dir);
  return Number(bavail) * Number(bsize) >= STAGING_MIN_FREE_BYTES + maxBytes;
}

/** True when the staging filesystem has room for `maxBytes` above the floor. Throws if it cannot tell. */
export function stagingHasRoomFor(maxBytes: number): boolean {
  return diskHasRoomFor(ensureStagingDir(), maxBytes);
}

export type StageResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: "too_large" | "empty" | "incomplete" };

/**
 * Stream a request body to the import's staging file, enforcing `maxBytes` WHILE reading:
 * the moment the running total passes the cap the body stream is cancelled (which aborts
 * the upload) and the partial file is deleted. Never buffers the body in memory.
 */
export async function stageUploadBody(
  body: ReadableStream<Uint8Array>,
  importId: string,
  maxBytes: number,
): Promise<StageResult> {
  ensureStagingDir();
  const dest = stagedUploadPath(importId);
  const out = fs.createWriteStream(dest, { flags: "wx", mode: 0o600 });
  let writeError: Error | null = null;
  out.on("error", (error) => { writeError = error; });
  const reader = body.getReader();
  let bytes = 0;
  let outcome: StageResult | null = null;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        outcome = { ok: false, reason: "incomplete" };
        break;
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        outcome = { ok: false, reason: "too_large" };
        break;
      }
      if (writeError) throw writeError;
      if (!out.write(chunk.value)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => { out.off("error", onError); resolve(); };
          const onError = (error: Error) => { out.off("drain", onDrain); reject(error); };
          out.once("drain", onDrain);
          out.once("error", onError);
        });
      }
    }
    if (writeError) throw writeError;
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(resolve);
    });
  } catch (error) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  if (!outcome && bytes === 0) outcome = { ok: false, reason: "empty" };
  if (outcome) {
    fs.rmSync(dest, { force: true });
    return outcome;
  }
  return { ok: true, bytes };
}

/** Containers each upload kind may carry — decided from the file's own bytes (G22/G24). */
export const UPLOAD_KIND_CONTAINERS: Record<UploadKind, readonly MediaContainer[]> = {
  image: ["jpeg", "png", "webp"],
  video: ["isobmff", "matroska"],
  presenter: ["isobmff", "matroska"],
};

const PURPOSE_KIND: Record<MediaImportPurpose, UploadKind> = {
  broll_image: "image",
  broll_video: "video",
  presenter: "presenter",
};

/** The pipeline extension for a sniffed container (the server name, never the client's). */
const CONTAINER_EXT: Partial<Record<MediaContainer, string>> = {
  isobmff: "mp4",
  matroska: "webm",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

/** The staged file's container when it is one its kind accepts, else null. */
export function stagedContainerFor(importId: string, kind: UploadKind): MediaContainer | null {
  const container = sniffMediaFile(stagedUploadPath(importId));
  return container && UPLOAD_KIND_CONTAINERS[kind].includes(container) ? container : null;
}

export type StagedUploadResult =
  | { ok: true; resultSrc: string; durationMs: number }
  | { ok: false; errorCode: string; message: string };

/**
 * Run a staged upload through the same validation the web upload uses: B-roll → T9's
 * `runBrollPipeline` (ffprobe-pinned demuxer, 4096 px guard, Ken Burns / normalize);
 * presenter → T9's `processPresenterImport` (portrait, plan duration, 4096 px). The staged
 * file is gone afterwards on every path. Status transitions are the caller's (import lane).
 */
export async function processStagedUpload(params: {
  importId: string;
  purpose: string;
  plan: string;
  stocksDir?: string;
}): Promise<StagedUploadResult> {
  const { importId, plan } = params;
  const purpose = params.purpose as MediaImportPurpose;
  const kind = PURPOSE_KIND[purpose];
  if (!kind) return { ok: false, errorCode: "unsupported_media", message: "ชนิดไฟล์นำเข้าไม่ถูกต้อง" };
  let stagedPath: string;
  try {
    stagedPath = stagedUploadPath(importId);
  } catch {
    return { ok: false, errorCode: "upload_missing", message: "ไม่พบไฟล์ที่อัปโหลด" };
  }
  if (!fs.existsSync(stagedPath)) return { ok: false, errorCode: "upload_missing", message: "ไม่พบไฟล์ที่อัปโหลด" };
  try {
    const container = stagedContainerFor(importId, kind);
    const ext = container ? CONTAINER_EXT[container] : undefined;
    if (!ext) return { ok: false, errorCode: "unsupported_media", message: "ชนิดไฟล์ไม่รองรับ" };

    if (kind === "presenter") {
      const result = await processPresenterImport({ tempFilePath: stagedPath, ext, plan });
      return result.ok
        ? { ok: true, resultSrc: result.src, durationMs: result.durationMs }
        : { ok: false, errorCode: result.error.code, message: result.error.message };
    }

    const file = new File([await fs.openAsBlob(stagedPath)], `upload.${ext}`);
    const result = await runBrollPipeline({
      file,
      kind,
      ext,
      stocksDir: params.stocksDir ?? path.join(process.cwd(), "stocks"),
    });
    return result.ok
      ? { ok: true, resultSrc: result.value.src, durationMs: Math.round(result.value.clipDuration * 1000) }
      : { ok: false, errorCode: result.value.error, message: result.value.message };
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }
}
