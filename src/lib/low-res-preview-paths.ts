import fs from "fs";
import path from "path";

export const LOW_RES_PREVIEW_WIDTH = 720;
export const LOW_RES_PREVIEW_FALLBACK_WIDTH = 540;
export const LOW_RES_PREVIEW_WIDTHS = [LOW_RES_PREVIEW_FALLBACK_WIDTH, LOW_RES_PREVIEW_WIDTH] as const;
export type LowResPreviewWidth = typeof LOW_RES_PREVIEW_WIDTHS[number];

export type LowResPreviewInfo = {
  previewWidth: LowResPreviewWidth;
  sourceFilename: string;
  sourceFilePath: string;
  previewFilename: string;
  previewFilePath: string;
  previewUrl: string;
  sourceExists: boolean;
  previewExists: boolean;
};

const RENDER_PREFIXES = ["/api/renders/", "/renders/"];

function isPreviewWidth(width: number): width is LowResPreviewWidth {
  return (LOW_RES_PREVIEW_WIDTHS as readonly number[]).includes(width);
}

function pathnameFromUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).pathname;
  } catch {}
  return value.split("?")[0].split("#")[0];
}

export function lowResPreviewFilenameForRender(
  filename: string,
  width: LowResPreviewWidth = LOW_RES_PREVIEW_WIDTH,
): string | null {
  const safeName = path.basename(filename);
  if (!safeName || safeName !== filename || /[/\\]/.test(safeName)) return null;
  if (!isPreviewWidth(width)) return null;

  const ext = path.extname(safeName).toLowerCase();
  if (ext !== ".mp4") return null;

  const name = safeName.slice(0, -ext.length);
  if (!name || (name.startsWith("preview-") && LOW_RES_PREVIEW_WIDTHS.some((w) => name.endsWith(`-${w}p`)))) {
    return null;
  }

  return `preview-${name}-${width}p.mp4`;
}

export function lowResPreviewFilenamesForRender(filename: string): string[] {
  return LOW_RES_PREVIEW_WIDTHS
    .map((width) => lowResPreviewFilenameForRender(filename, width))
    .filter((value): value is string => Boolean(value));
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
  width: LowResPreviewWidth = LOW_RES_PREVIEW_WIDTH,
): LowResPreviewInfo | null {
  const sourceFilename = renderFilenameFromVideoUrl(videoUrl);
  if (!sourceFilename) return null;

  const previewFilename = lowResPreviewFilenameForRender(sourceFilename, width);
  if (!previewFilename) return null;

  const rendersDir = path.join(cwd, "public", "renders");
  const sourceFilePath = path.join(rendersDir, sourceFilename);
  const previewFilePath = path.join(rendersDir, previewFilename);

  return {
    previewWidth: width,
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
  width: LowResPreviewWidth = LOW_RES_PREVIEW_WIDTH,
): string | null {
  const info = lowResPreviewInfoForVideoUrl(videoUrl, cwd, width);
  return info?.sourceExists && info.previewExists ? info.previewUrl : null;
}

export function existingLowResPreviewFallbackUrlForVideoUrl(
  videoUrl: string | null | undefined,
  cwd = process.cwd(),
): string | null {
  return existingLowResPreviewUrlForVideoUrl(videoUrl, cwd, LOW_RES_PREVIEW_FALLBACK_WIDTH);
}

export function deleteLowResPreviewForVideoUrl(
  videoUrl: string | null | undefined,
  cwd = process.cwd(),
): boolean {
  let deleted = false;
  for (const width of LOW_RES_PREVIEW_WIDTHS) {
    const info = lowResPreviewInfoForVideoUrl(videoUrl, cwd, width);
    if (!info?.previewExists) continue;
    try {
      fs.unlinkSync(info.previewFilePath);
      deleted = true;
    } catch {}
  }
  return deleted;
}
