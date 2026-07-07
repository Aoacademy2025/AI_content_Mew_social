import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

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

export async function POST(req: Request) {
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
      return NextResponse.json(
        { error: "Unsupported file type — only mp4/mov/webm video is accepted" },
        { status: 400 },
      );
    }

    const rendersDir = path.join(process.cwd(), "public", "renders");
    fs.mkdirSync(rendersDir, { recursive: true });

    // Server-generated filename only — the client filename never contributes a
    // path component or extension choice beyond the validated allowlist above.
    const filename = `upload-${randomUUID()}.${ext}`;
    const outputPath = path.join(rendersDir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    return NextResponse.json({ url: `/api/renders/${filename}` });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
