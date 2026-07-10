import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { storageDaysForPlan, videoExpiryFor } from "@/lib/plan-limits";

export type MediaReference = {
  ownerKind: "video" | "video-job" | "project-draft" | "render-job" | "generated-image";
  ownerId: string;
  expiresAt: Date | null;
  alwaysProtect?: boolean;
};

export type ProjectMediaState =
  | { status: "available"; expiresAt: string }
  | { status: "expired"; expiredAt: string; canRerender: true }
  | { status: "missing"; canRerender: boolean; supportCode: string };

type ProjectMediaStateInput = {
  expiresAt: Date | null;
  mediaAvailable: boolean;
  missingSupportCode?: string;
};

type ProjectMediaInspectionInput = {
  videoUrl: string | null | undefined;
  mediaExpiresAt: Date | null;
  now?: Date;
  cwd?: string;
};

function pathIsWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

async function inspectCanonicalLocalRender(videoUrl: string, cwd: string): Promise<boolean> {
  if (/[\\\u0000-\u001f\u007f]/.test(videoUrl)) return false;
  const pathname = videoUrl.split(/[?#]/, 1)[0];
  const prefix = pathname.startsWith("/api/renders/")
    ? "/api/renders/"
    : pathname.startsWith("/renders/")
      ? "/renders/"
      : null;
  if (!prefix) return false;

  let filename: string;
  try {
    filename = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return false;
  }
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename !== path.basename(filename) ||
    /[/\\\u0000-\u001f\u007f]/.test(filename) ||
    /%[0-9a-f]{2}/i.test(filename)
  ) {
    return false;
  }

  try {
    const canonicalWorkspace = await realpath(path.resolve(cwd));
    const rendersRoot = path.resolve(canonicalWorkspace, "public", "renders");
    const rootStats = await lstat(rendersRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return false;
    const canonicalRoot = await realpath(rendersRoot);
    if (canonicalRoot !== rendersRoot) return false;

    const absolutePath = path.resolve(rendersRoot, filename);
    if (!pathIsWithin(canonicalRoot, absolutePath)) return false;
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) return false;
    return pathIsWithin(canonicalRoot, await realpath(absolutePath));
  } catch {
    return false;
  }
}

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

/** Pure API/UI state decision. Unlike cleanup liveness, the exact boundary is expired. */
export function resolveProjectMediaState(
  input: ProjectMediaStateInput,
  now = new Date(),
): ProjectMediaState {
  if (input.expiresAt === null || !Number.isFinite(input.expiresAt.getTime())) {
    return { status: "missing", canRerender: true, supportCode: "MEDIA_EXPIRY_UNKNOWN" };
  }

  if (now.getTime() >= input.expiresAt.getTime()) {
    return {
      status: "expired",
      expiredAt: input.expiresAt.toISOString(),
      canRerender: true,
    };
  }

  if (!input.mediaAvailable) {
    return {
      status: "missing",
      canRerender: true,
      supportCode: input.missingSupportCode ?? "MEDIA_FILE_MISSING",
    };
  }

  return { status: "available", expiresAt: input.expiresAt.toISOString() };
}

/**
 * Inspect only canonical local render paths. Remote URLs are deliberately not fetched on
 * request paths; a non-null future expiry is the availability contract for those objects.
 */
export async function inspectProjectMediaState(
  input: ProjectMediaInspectionInput,
): Promise<ProjectMediaState> {
  const now = input.now ?? new Date();
  const expiryState = resolveProjectMediaState(
    { expiresAt: input.mediaExpiresAt, mediaAvailable: true },
    now,
  );
  if (expiryState.status !== "available") return expiryState;

  const videoUrl = input.videoUrl?.trim();
  if (!videoUrl) {
    return resolveProjectMediaState(
      { expiresAt: input.mediaExpiresAt, mediaAvailable: false },
      now,
    );
  }

  const isLocalRender = videoUrl.startsWith("/api/renders/") || videoUrl.startsWith("/renders/");
  if (!isLocalRender) {
    try {
      const externalUrl = new URL(videoUrl);
      if (externalUrl.protocol === "http:" || externalUrl.protocol === "https:") return expiryState;
    } catch {
      // Non-canonical relative values are missing incidents, not external media.
    }
    return resolveProjectMediaState(
      { expiresAt: input.mediaExpiresAt, mediaAvailable: false },
      now,
    );
  }

  const mediaAvailable = await inspectCanonicalLocalRender(videoUrl, input.cwd ?? process.cwd());

  return resolveProjectMediaState(
    { expiresAt: input.mediaExpiresAt, mediaAvailable },
    now,
  );
}

export { storageDaysForPlan };
