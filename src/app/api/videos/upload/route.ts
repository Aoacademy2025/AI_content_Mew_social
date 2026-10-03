import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import path from "path";
import fs from "fs";
import os from "os";
import { randomUUID } from "crypto";
import { admitUserMediaFile } from "@/lib/upload-media-probe";

export const maxDuration = 60;
export const runtime = "nodejs";

// SEC-4 fix: this endpoint used to trust the client-supplied filename extension
// verbatim and write to a predictable `upload-<Date.now()>.<ext>` path under
// public/renders/ (served statically, unauthenticated, and excluded from Clerk's
// middleware for .html/.svg — see src/middleware.ts). An attacker could upload
// `x.html`/`x.svg` containing script and have it served back as text/html on the
// app origin (stored XSS). Mirror the same ext+MIME allowlist and random-filename
// pattern already used by the sibling routes /api/videos/upload-avatar and
// /api/videos/broll-window/upload.
const VIDEO_EXTS = new Set(["mp4", "mov", "webm"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isAllowedVideo(file: File, ext: string): boolean {
  if (!VIDEO_EXTS.has(ext)) return false;
  if (!file.type) return true; // some browsers send no MIME for e.g. .mov
  return VIDEO_MIMES.has(file.type);
}

const UNSUPPORTED = "Unsupported file type — only mp4/mov/webm video is accepted";

/** rename, or copy + unlink when the temp dir is on another filesystem. */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

export async function POST(req: Request) {
  let tempPath: string | null = null;
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("video") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No video file provided" }, { status: 400 });
    }

    // Limit 500MB
    const MAX_SIZE = 500 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: "File too large (max 500MB)" }, { status: 400 });
    }

    const ext = fileExt(file.name);
    if (!isAllowedVideo(file, ext)) {
      return NextResponse.json({ error: UNSUPPORTED }, { status: 400 });
    }

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Server-generated filename only — the client filename never contributes a
    // path component or extension choice beyond the validated allowlist above.
    const filename = `upload-${randomUUID()}.${ext}`;
    const outputPath = path.join(rendersDir, filename);

    // G24: the bytes must be a real video container before they are stored. Files here
    // are read later by ffmpeg paths that still auto-detect the format, so a playlist or
    // ffconcat script named .mp4 must never land in public/renders.
    tempPath = path.join(os.tmpdir(), `video-upload-${randomUUID()}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    // Default mode (as before): nginx serves public/renders straight from disk.
    fs.writeFileSync(tempPath, buffer, { flag: "wx" });
    if (!(await admitUserMediaFile(tempPath, ["video"]))) {
      return NextResponse.json({ error: UNSUPPORTED }, { status: 400 });
    }
    moveFile(tempPath, outputPath);
    tempPath = null;

    return NextResponse.json({ url: `/api/renders/${filename}` });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
  }
}
