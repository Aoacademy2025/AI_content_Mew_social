import fs from "fs";
import path from "path";

export const LOW_RES_PREVIEW_WIDTH = 540;

export type LowResPreviewInfo = {
  sourceFilename: string;
  sourceFilePath: string;
  previewFilename: string;
  previewFilePath: string;
  previewUrl: string;
  sourceExists: boolean;
  previewExists: boolean;
};

const RENDER_PREFIXES = ["/api/renders/", "/renders/"];

function pathnameFromUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).pathname;
  } catch {}
  return value.split("?")[0].split("#")[0];
}

export function lowResPreviewFilenameForRender(filename: string): string | null {
  const safeName = path.basename(filename);
  if (!safeName || safeName !== filename || /[/\\]/.test(safeName)) return null;

  const ext = path.extname(safeName).toLowerCase();
  if (ext !== ".mp4") return null;

  const name = safeName.slice(0, -ext.length);
  if (!name || (name.startsWith("preview-") && name.endsWith(`-${LOW_RES_PREVIEW_WIDTH}p`))) {
    return null;
  }

  return `preview-${name}-${LOW_RES_PREVIEW_WIDTH}p.mp4`;
}

export function renderFilenameFromVideoUrl(videoUrl: string | null | undefined): string | null {
  if (!videoUrl) return null;
  const pathname = pathnameFromUrl(videoUrl);
  for (const prefix of RENDER_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    const filename = path.basename(pathname.slice(prefix.length));
    return filename && filename === pathname.slice(prefix.length) ? filename : null;
  }
  return null;
}

export function lowResPreviewInfoForVideoUrl(
  videoUrl: string | null | undefined,
  cwd = process.cwd(),
): LowResPreviewInfo | null {
  const sourceFilename = renderFilenameFromVideoUrl(videoUrl);
  if (!sourceFilename) return null;

  const previewFilename = lowResPreviewFilenameForRender(sourceFilename);
  if (!previewFilename) return null;

  const rendersDir = path.join(cwd, "public", "renders");
  const sourceFilePath = path.join(rendersDir, sourceFilename);
  const previewFilePath = path.join(rendersDir, previewFilename);

  return {
    sourceFilename,
    sourceFilePath,
    previewFilename,
    previewFilePath,
    previewUrl: `/api/renders/${previewFilename}`,
    sourceExists: fs.existsSync(sourceFilePath),
    previewExists: fs.existsSync(previewFilePath),
  };
}

export function existingLowResPreviewUrlForVideoUrl(
  videoUrl: string | null | undefined,
  cwd = process.cwd(),
): string | null {
  const info = lowResPreviewInfoForVideoUrl(videoUrl, cwd);
  return info?.sourceExists && info.previewExists ? info.previewUrl : null;
}

export function deleteLowResPreviewForVideoUrl(
  videoUrl: string | null | undefined,
  cwd = process.cwd(),
): boolean {
  const info = lowResPreviewInfoForVideoUrl(videoUrl, cwd);
  if (!info?.previewExists) return false;
  try {
    fs.unlinkSync(info.previewFilePath);
    return true;
  } catch {
    return false;
  }
}
