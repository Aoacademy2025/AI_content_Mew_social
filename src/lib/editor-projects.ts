import { prisma } from "@/lib/prisma";
import { parseVideoJobOutput } from "@/lib/mcp/video-job";
import { resolveProjectMediaState } from "@/lib/media-retention";

export const DEFAULT_EDITOR_PROJECT_TITLE = "New Project";
export const MAX_EDITOR_PROJECT_TITLE_LENGTH = 80;
export const MAX_EDITOR_PROJECT_DRAFT_BYTES = 2 * 1024 * 1024;

export const EDITOR_PROJECT_STATUSES = ["draft", "rendering", "post", "exporting", "exported", "archived"] as const;
export type EditorProjectStatus = (typeof EDITOR_PROJECT_STATUSES)[number];

type ProjectRow = Awaited<ReturnType<typeof prisma.editorProject.findFirst>>;

export function sanitizeEditorProjectTitle(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const title = raw || DEFAULT_EDITOR_PROJECT_TITLE;
  return title.slice(0, MAX_EDITOR_PROJECT_TITLE_LENGTH);
}

export function normalizeEditorProjectStatus(value: unknown): EditorProjectStatus | null {
  if (typeof value !== "string") return null;
  return (EDITOR_PROJECT_STATUSES as readonly string[]).includes(value)
    ? (value as EditorProjectStatus)
    : null;
}

export function encodeEditorProjectDraft(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const raw = typeof value === "string" ? value : JSON.stringify(value);
  JSON.parse(raw);

  if (Buffer.byteLength(raw, "utf8") > MAX_EDITOR_PROJECT_DRAFT_BYTES) {
    const err = new Error("draft_too_large");
    (err as { code?: string }).code = "draft_too_large";
    throw err;
  }
  return raw;
}

export function editorProjectResponse(project: NonNullable<ProjectRow>) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    draft: project.draftJson ? JSON.parse(project.draftJson) : null,
    activeJobId: project.activeJobId,
    activeExportJobId: project.activeExportJobId,
    latestVideoId: project.latestVideoId,
    lastOpenedAt: project.lastOpenedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export async function listEditorProjects(userId: string, opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.editorProject.findMany({
    where: {
      userId,
      ...(opts.includeArchived ? {} : { status: { not: "archived" } }),
    },
    orderBy: [{ lastOpenedAt: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map(editorProjectResponse);
}

export async function getEditorProject(userId: string, projectId: string) {
  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId },
  });
  return project ? editorProjectResponse(project) : null;
}

export async function getEditorProjectWithMediaState(
  userId: string,
  projectId: string,
  opts: { now?: Date; rendersRoot?: string } = {},
) {
  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId },
  });
  if (!project) return null;

  const activeJobId = project.activeExportJobId ?? project.activeJobId;
  if (!activeJobId) {
    return { ...editorProjectResponse(project), previewMediaState: null };
  }

  const job = await prisma.videoJob.findFirst({
    where: { id: activeJobId, userId, status: "done" },
    select: { outputJson: true, mediaExpiresAt: true },
  });
  if (!job) {
    return { ...editorProjectResponse(project), previewMediaState: null };
  }

  const output = parseVideoJobOutput(job.outputJson);
  const previewMediaState = await resolveProjectMediaState({
    videoUrl: output?.videoUrl,
    mediaExpiresAt: job.mediaExpiresAt,
    ...opts,
  });
  return { ...editorProjectResponse(project), previewMediaState };
}

export async function createEditorProject(
  userId: string,
  input: { title?: unknown; draft?: unknown; status?: unknown } = {},
) {
  const draftJson = encodeEditorProjectDraft(input.draft);
  const status = normalizeEditorProjectStatus(input.status) ?? "draft";
  const project = await prisma.editorProject.create({
    data: {
      userId,
      title: sanitizeEditorProjectTitle(input.title),
      status,
      draftJson: draftJson ?? null,
      lastOpenedAt: new Date(),
    },
  });
  return editorProjectResponse(project);
}

export async function updateEditorProject(
  userId: string,
  projectId: string,
  input: {
    title?: unknown;
    draft?: unknown;
    status?: unknown;
    activeJobId?: unknown;
    activeExportJobId?: unknown;
    latestVideoId?: unknown;
    touchLastOpened?: unknown;
  },
) {
  const data: {
    title?: string;
    draftJson?: string | null;
    status?: string;
    activeJobId?: string | null;
    activeExportJobId?: string | null;
    latestVideoId?: string | null;
    lastOpenedAt?: Date;
  } = {};

  if ("title" in input) data.title = sanitizeEditorProjectTitle(input.title);
  if ("draft" in input) data.draftJson = encodeEditorProjectDraft(input.draft) ?? null;
  if ("status" in input) {
    const status = normalizeEditorProjectStatus(input.status);
    if (!status) {
      const err = new Error("invalid_status");
      (err as { code?: string }).code = "invalid_status";
      throw err;
    }
    data.status = status;
  }
  if ("activeJobId" in input) {
    data.activeJobId = typeof input.activeJobId === "string" && input.activeJobId.trim()
      ? input.activeJobId.trim()
      : null;
  }
  if ("activeExportJobId" in input) {
    data.activeExportJobId = typeof input.activeExportJobId === "string" && input.activeExportJobId.trim()
      ? input.activeExportJobId.trim()
      : null;
  }
  if ("latestVideoId" in input) {
    data.latestVideoId = typeof input.latestVideoId === "string" && input.latestVideoId.trim()
      ? input.latestVideoId.trim()
      : null;
  }
  if (input.touchLastOpened === true) data.lastOpenedAt = new Date();

  if (Object.keys(data).length === 0) {
    const err = new Error("no_fields");
    (err as { code?: string }).code = "no_fields";
    throw err;
  }

  const updated = await prisma.editorProject.updateMany({
    where: { id: projectId, userId },
    data,
  });
  if (updated.count !== 1) return null;
  return getEditorProject(userId, projectId);
}

export async function archiveEditorProject(userId: string, projectId: string) {
  const updated = await prisma.editorProject.updateMany({
    where: { id: projectId, userId },
    data: { status: "archived" },
  });
  return updated.count === 1;
}

export async function assertEditorProjectOwner(userId: string, projectId: string | null | undefined) {
  if (!projectId) return null;
  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId, status: { not: "archived" } },
    select: { id: true },
  });
  if (!project) {
    const err = new Error("project_not_found");
    (err as { code?: string }).code = "project_not_found";
    throw err;
  }
  return project.id;
}
