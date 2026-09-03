import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseVideoJobOutput } from "@/lib/mcp/video-job";
import { resolveProjectMediaState } from "@/lib/media-retention";
import {
  advanceEditorProjectBrandAsset,
  prepareEditorProjectBrandAsset,
} from "@/lib/editor-project-brand-asset.server";
import { observeEditorProjectBrandAssetVerificationStep } from "@/lib/editor-project-brand-asset-verification.server";
import {
  brandVisualPinAdmissionFields,
  type PinAdmission,
} from "@/lib/brand-visual-pin-admission";
import { withTransientSqliteRetry } from "@/lib/sqlite-retry";
import { sanitizeEditorProjectTitle } from "@/lib/editor-project-title";

export {
  DEFAULT_EDITOR_PROJECT_TITLE,
  MAX_EDITOR_PROJECT_TITLE_LENGTH,
  sanitizeEditorProjectTitle,
} from "@/lib/editor-project-title";
export const MAX_EDITOR_PROJECT_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_EDITOR_PROJECT_DRAFT_REVISION = 2_147_483_647;

export const EDITOR_PROJECT_STATUSES = ["draft", "rendering", "post", "exporting", "exported", "archived"] as const;
export type EditorProjectStatus = (typeof EDITOR_PROJECT_STATUSES)[number];

type ProjectRow = Awaited<ReturnType<typeof prisma.editorProject.findFirst>>;

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

function parseEditorProjectDraftRevision(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value <= MAX_EDITOR_PROJECT_DRAFT_REVISION
    ? value
    : null;
}

function parseExpectedEditorProjectDraftRevision(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_EDITOR_PROJECT_DRAFT_REVISION
    ? value
    : null;
}

function invalidProjectPointer(field: "activeJobId" | "activeExportJobId" | "latestVideoId"): Error {
  const error = new Error("invalid_project_pointer");
  (error as { code?: string; field?: string }).code = "invalid_project_pointer";
  (error as { code?: string; field?: string }).field = field;
  return error;
}

async function assertExactEditorProjectPointers(
  tx: Prisma.TransactionClient,
  userId: string,
  projectId: string,
  pointers: {
    activeJobId?: string | null;
    activeExportJobId?: string | null;
    latestVideoId?: string | null;
  },
): Promise<void> {
  for (const field of ["activeJobId", "activeExportJobId"] as const) {
    const jobId = pointers[field];
    if (!jobId) continue;
    const exactJob = await tx.videoJob.findFirst({
      where: { id: jobId, userId, projectId },
      select: { id: true },
    });
    if (!exactJob) throw invalidProjectPointer(field);
  }
  if (pointers.latestVideoId) {
    const exactVideo = await tx.video.findFirst({
      where: { id: pointers.latestVideoId, userId, projectId },
      select: { id: true },
    });
    if (!exactVideo) throw invalidProjectPointer("latestVideoId");
  }
}

export function editorProjectResponse(project: NonNullable<ProjectRow>) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    draft: project.draftJson ? JSON.parse(project.draftJson) : null,
    draftRevision: project.draftRevision,
    activeJobId: project.activeJobId,
    activeExportJobId: project.activeExportJobId,
    latestVideoId: project.latestVideoId,
    brandProfileRevisionId: project.brandProfileRevisionId,
    hasPersistedVisualPin: Boolean(project.projectLookJson || project.brandProfileRevisionId),
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
    where: { id: projectId, userId, status: { not: "archived" } },
  });
  return project ? editorProjectResponse(project) : null;
}

export async function getEditorProjectWithMediaState(
  userId: string,
  projectId: string,
  opts: { now?: Date; rendersRoot?: string } = {},
) {
  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId, status: { not: "archived" } },
  });
  if (!project) return null;

  const activeJobId = project.activeExportJobId ?? project.activeJobId;
  if (!activeJobId) {
    return { ...editorProjectResponse(project), previewMediaState: null };
  }

  const job = await prisma.videoJob.findFirst({
    where: { id: activeJobId, userId, projectId, status: "done" },
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

/** Create a project.
 *
 *  `tx` lets a caller enlist this create in an OUTER interactive transaction:
 *  Hero Script's send-to-editor creates the project and marks the Script "sent"
 *  as one unit, so a Script that disappears mid-handoff rolls the project back
 *  instead of orphaning it. Callers that omit `tx` keep the previous behavior
 *  byte-for-byte — this function opens its own transaction, as before. */
export async function createEditorProject(
  userId: string,
  input: {
    title?: unknown;
    draft?: unknown;
    status?: unknown;
    brandProfileRevisionId?: unknown;
    /** Only meaningful with `brandProfileRevisionId`: the owner's AI-image
     * decision at pin time (#430). Omitted or null creates the pin WITHOUT the
     * managed-image grandfather clause — the look still applies. */
    brandVisualPinAdmission?: PinAdmission;
  } = {},
  tx?: Prisma.TransactionClient,
) {
  const draftJson = encodeEditorProjectDraft(input.draft);
  const assetFence = await prepareEditorProjectBrandAsset(userId, draftJson);
  const status = normalizeEditorProjectStatus(input.status) ?? "draft";
  const requestedRevisionId = typeof input.brandProfileRevisionId === "string"
    ? input.brandProfileRevisionId.trim()
    : "";
  const create = async (client: Prisma.TransactionClient) => {
    if (requestedRevisionId) {
      const ownedRevision = await client.brandProfileRevision.findFirst({
        where: { id: requestedRevisionId, brandProfile: { userId } },
        select: { id: true },
      });
      if (!ownedRevision) {
        const error = new Error("invalid_brand_profile_revision");
        (error as { code?: string }).code = "invalid_brand_profile_revision";
        throw error;
      }
    }
    const created = await client.editorProject.create({
      data: {
        userId,
        title: sanitizeEditorProjectTitle(input.title),
        status,
        draftJson: draftJson ?? null,
        brandProfileRevisionId: requestedRevisionId || null,
        lastOpenedAt: new Date(),
        // A stamp without a pin admits nothing, so it is only written when this
        // create actually persists a Revision pin (#430).
        ...brandVisualPinAdmissionFields(
          requestedRevisionId ? input.brandVisualPinAdmission : null,
        ),
      },
    });
    await advanceEditorProjectBrandAsset(client, userId, assetFence);
    return created;
  };
  const project = tx ? await create(tx) : await prisma.$transaction(create);
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
    draftRevision?: unknown;
    expectedDraftRevision?: unknown;
  },
) {
  const data: {
    title?: string;
    draftJson?: string | null;
    draftRevision?: number | { increment: number };
    status?: string;
    activeJobId?: string | null;
    activeExportJobId?: string | null;
    latestVideoId?: string | null;
    lastOpenedAt?: Date;
  } = {};

  const hasDraftRevision = Object.prototype.hasOwnProperty.call(input, "draftRevision");
  let draftRevision: number | undefined;
  if (hasDraftRevision) {
    draftRevision = parseEditorProjectDraftRevision(input.draftRevision) ?? undefined;
    if (draftRevision === undefined || !("draft" in input)) {
      const err = new Error("invalid_draft_revision");
      (err as { code?: string }).code = "invalid_draft_revision";
      throw err;
    }
  }

  const hasExpectedDraftRevision = Object.prototype.hasOwnProperty.call(input, "expectedDraftRevision");
  let expectedDraftRevision: number | undefined;
  if (hasExpectedDraftRevision) {
    expectedDraftRevision = parseExpectedEditorProjectDraftRevision(input.expectedDraftRevision) ?? undefined;
    if (
      expectedDraftRevision === undefined
      || draftRevision === undefined
      || draftRevision <= expectedDraftRevision
    ) {
      const err = new Error("invalid_draft_revision");
      (err as { code?: string }).code = "invalid_draft_revision";
      throw err;
    }
  }

  let draftJsonForAsset: string | null | undefined;
  if ("title" in input) data.title = sanitizeEditorProjectTitle(input.title);
  if ("draft" in input) {
    draftJsonForAsset = encodeEditorProjectDraft(input.draft);
    data.draftJson = draftJsonForAsset ?? null;
    data.draftRevision = draftRevision ?? { increment: 1 };
  }
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

  const assetFence = "draft" in input
    ? await prepareEditorProjectBrandAsset(userId, draftJsonForAsset)
    : null;
  await observeEditorProjectBrandAssetVerificationStep("after-asset-prepare");
  const projectWriteMiss = new Error("editor_project_write_miss");
  let project: NonNullable<ProjectRow> | null = null;
  try {
    project = await withTransientSqliteRetry(() => prisma.$transaction(async (tx) => {
      await assertExactEditorProjectPointers(tx, userId, projectId, data);
      const updated = await tx.editorProject.updateMany({
        where: {
          id: projectId,
          userId,
          status: { not: "archived" },
          ...(expectedDraftRevision !== undefined
            ? { draftRevision: expectedDraftRevision }
            : draftRevision !== undefined
              ? { draftRevision: { lt: draftRevision } }
              : {}),
        },
        data,
      });
      if (updated.count !== 1) throw projectWriteMiss;
      await observeEditorProjectBrandAssetVerificationStep("after-project-cas");
      await advanceEditorProjectBrandAsset(tx, userId, assetFence);
      return tx.editorProject.findFirst({ where: { id: projectId, userId } });
    }), {
      onRetry: ({ attempt, delayMs }) => {
        console.warn(`[editor-project] transient SQLite timeout; retry ${attempt} in ${delayMs}ms`);
      },
    });
  } catch (error) {
    if (error !== projectWriteMiss) throw error;
    const current = await getEditorProject(userId, projectId);
    if (!current) return null;
    if (draftRevision !== undefined) {
      const err = new Error("stale_revision");
      (err as { code?: string; project?: typeof current }).code = "stale_revision";
      (err as { code?: string; project?: typeof current }).project = current;
      throw err;
    }
    return null;
  }
  return project ? editorProjectResponse(project) : null;
}

export async function archiveEditorProject(userId: string, projectId: string) {
  const updated = await prisma.editorProject.updateMany({
    where: { id: projectId, userId, status: { not: "archived" } },
    data: {
      status: "archived",
      activeJobId: null,
      activeExportJobId: null,
      latestVideoId: null,
    },
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

/** Keep durable Export pinned to the latest preview the project has accepted.
 * Legacy projects without an active preview remain exportable, but once an
 * activeJobId exists an older preview must never be allowed to overwrite it —
 * unless sourceJobId is itself a newer, finished `create` render of the same
 * project (e.g. a b-roll re-render child), in which case it IS the current
 * render and is accepted too. */
export async function assertCurrentEditorExportSource(
  userId: string,
  projectId: string,
  sourceJobId: string,
): Promise<void> {
  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId, status: { not: "archived" } },
    select: { id: true, activeJobId: true },
  });
  if (!project) {
    const error = new Error("project_not_found");
    (error as { code?: string }).code = "project_not_found";
    throw error;
  }
  if (project.activeJobId && project.activeJobId !== sourceJobId) {
    const [activeJob, sourceJob] = await Promise.all([
      prisma.videoJob.findUnique({ where: { id: project.activeJobId }, select: { createdAt: true } }),
      prisma.videoJob.findUnique({
        where: { id: sourceJobId },
        select: { projectId: true, status: true, type: true, createdAt: true },
      }),
    ]);
    const isCurrentProjectRender = Boolean(
      activeJob
      && sourceJob
      && sourceJob.projectId === project.id
      && sourceJob.status === "done"
      && sourceJob.type === "create"
      && sourceJob.createdAt.getTime() >= activeJob.createdAt.getTime(),
    );
    if (!isCurrentProjectRender) {
      const error = new Error("stale_export_source");
      (error as { code?: string }).code = "stale_export_source";
      throw error;
    }
  }
}
