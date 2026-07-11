import { lstat } from "node:fs/promises";
import path from "node:path";
import { storageDaysForPlan, videoExpiryFor } from "@/lib/plan-limits";

export type ProjectMediaState =
  | { status: "available"; expiresAt: string }
  | { status: "expired"; expiredAt: string; canRerender: true }
  | { status: "missing"; canRerender: boolean; supportCode: string };

export type ProjectMediaStateInput = {
  mediaExpiresAt: Date | null;
  mediaAvailable: boolean;
  now?: Date;
  canRerender?: boolean;
};

export type ResolveProjectMediaStateInput = {
  videoUrl: string | null | undefined;
  mediaExpiresAt: Date | null;
  now?: Date;
  rendersRoot?: string;
  canRerender?: boolean;
};

export type MediaReference = {
  ownerKind: "video" | "video-job" | "project-draft" | "render-job" | "generated-image";
  ownerId: string;
  expiresAt: Date | null;
  alwaysProtect?: boolean;
  critical?: boolean;
};

export function expiryForMedia(plan: string, producedAt: Date): Date {
  return videoExpiryFor(plan, producedAt);
}

export function effectiveMediaExpiry(
  refs: Array<Pick<MediaReference, "expiresAt" | "alwaysProtect">>,
): Date | null {
  if (refs.some((ref) => ref.alwaysProtect || ref.expiresAt === null)) return null;
  return refs.reduce<Date | null>(
    (latest, ref) => (!latest || ref.expiresAt! > latest ? ref.expiresAt : latest),
    null,
  );
}

export function mediaReferenceIsLive(
  ref: Pick<MediaReference, "expiresAt" | "alwaysProtect">,
  now = new Date(),
): boolean {
  return ref.alwaysProtect === true || ref.expiresAt === null || ref.expiresAt.getTime() >= now.getTime();
}

export function projectMediaState({
  mediaExpiresAt,
  mediaAvailable,
  now = new Date(),
  canRerender = true,
}: ProjectMediaStateInput): ProjectMediaState {
  if (mediaExpiresAt === null) {
    return { status: "missing", canRerender, supportCode: "MEDIA_EXPIRY_UNKNOWN" };
  }
  if (now.getTime() >= mediaExpiresAt.getTime()) {
    return { status: "expired", expiredAt: mediaExpiresAt.toISOString(), canRerender: true };
  }
  if (!mediaAvailable) {
    return { status: "missing", canRerender, supportCode: "MEDIA_FILE_MISSING" };
  }
  return { status: "available", expiresAt: mediaExpiresAt.toISOString() };
}

function localRenderFilename(videoUrl: string): string | null | undefined {
  const value = videoUrl.trim();
  if (/^https?:\/\//i.test(value)) return undefined;

  const pathname = value.split("?", 1)[0].split("#", 1)[0];
  const prefix = ["/api/renders/", "/renders/"].find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return null;

  const encodedFilename = pathname.slice(prefix.length);
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return null;
  }
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename !== path.basename(filename) ||
    /[/\\\0\r\n]/.test(filename)
  ) {
    return null;
  }
  return filename;
}

async function localRenderIsAvailable(videoUrl: string, rendersRoot: string): Promise<boolean> {
  const filename = localRenderFilename(videoUrl);
  if (filename === undefined) return true;
  if (filename === null) return false;

  const root = path.resolve(rendersRoot);
  const filePath = path.resolve(root, filename);
  if (path.dirname(filePath) !== root) return false;

  try {
    const [rootStat, fileStat] = await Promise.all([lstat(root), lstat(filePath)]);
    return (
      rootStat.isDirectory() &&
      !rootStat.isSymbolicLink() &&
      fileStat.isFile() &&
      !fileStat.isSymbolicLink() &&
      fileStat.size > 0
    );
  } catch {
    return false;
  }
}

export async function resolveProjectMediaState({
  videoUrl,
  mediaExpiresAt,
  now = new Date(),
  rendersRoot = path.join(process.cwd(), "public", "renders"),
  canRerender = true,
}: ResolveProjectMediaStateInput): Promise<ProjectMediaState> {
  if (mediaExpiresAt === null || now.getTime() >= mediaExpiresAt.getTime()) {
    return projectMediaState({ mediaExpiresAt, mediaAvailable: false, now, canRerender });
  }

  const mediaAvailable = typeof videoUrl === "string" && videoUrl.trim().length > 0
    ? await localRenderIsAvailable(videoUrl, rendersRoot)
    : false;
  return projectMediaState({ mediaExpiresAt, mediaAvailable, now, canRerender });
}

export { storageDaysForPlan };
