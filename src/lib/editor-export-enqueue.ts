import type { VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createVideoJob,
  parseVideoJobOutput,
  VIDEO_JOB_INFLIGHT_STATUSES,
} from "@/lib/mcp/video-job";
import { assertCurrentEditorExportSource } from "@/lib/editor-projects";
import { validateWindowEdits } from "@/lib/broll-rerender";
import { createDurableExportWithStagedLogo } from "@/lib/logo-export.server";
import { createEditorExportSnapshot } from "@/lib/editor-export-snapshot";
import { normalizeHeadlineHook } from "@/lib/headline-hook";
import { projectHasAdmittedPersistedPin } from "@/lib/project-look.server";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";

/**
 * T5 (ADR 0064): the editor's two follow-up job enqueues — the durable Export and the free
 * per-window B-roll re-render — extracted from the web jobs route so the route and the MCP
 * chain (ADR 0063 auto chain now, the Held Preview tools next) create exactly the same rows.
 *
 * Contract shared by both functions:
 *  - A refusal the route answers in-band comes back as `{ ok: false, status, error, message? }`
 *    with the route's existing status / code / Thai copy.
 *  - Everything else is THROWN unchanged for the caller to map: the coded
 *    `project_not_found` / `stale_export_source` from `assertCurrentEditorExportSource`,
 *    a duplicate idempotency key (Prisma P2002, the caller replays), BrandAssetError from logo
 *    staging, RenderDeployDrainError, and any database error.
 *  - `rootJobId` (G7) links a job spawned after an MCP Held Preview to that root: the input
 *    carries `mcpRootJobId` and `mcpMustBeFree: true` (G4 — the render route fails such a job
 *    instead of charging it). The root must be the caller's job on the source's project.
 */

export type EditorEnqueueUser = {
  id: string;
  plan: string;
  email?: string | null;
};

export type EditorEnqueueRefusal = {
  ok: false;
  status: number;
  error: string;
  message?: string;
};

export type EditorEnqueueResult = { ok: true; job: VideoJob } | EditorEnqueueRefusal;

const MAX_INFLIGHT_JOBS = 3;

function refuse(status: number, error: string, message?: string): EditorEnqueueRefusal {
  return { ok: false, status, error, ...(message ? { message } : {}) };
}

const SOURCE_NOT_FOUND_MESSAGE = "ไม่พบวิดีโอต้นฉบับ";
const TOO_MANY_JOBS_MESSAGE = "มีงานค้างอยู่หลายชิ้นแล้ว — รอให้เสร็จก่อนค่อยสั่งใหม่";
const STALE_PENDING_REVISION_MESSAGE = "AI agent แก้ไขคลิปนี้ไปแล้วระหว่างที่คุณกำลังแก้ — กรุณาโหลดฉบับล่าสุดแล้วลองใหม่";

async function inflightCapReached(userId: string): Promise<boolean> {
  const inflight = await prisma.videoJob.count({ where: { userId, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } });
  return inflight >= MAX_INFLIGHT_JOBS;
}

/** G7: the root must be this user's job on the same project as the job being spawned. */
async function rootBelongsToProject(userId: string, rootJobId: string, projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  const root = await prisma.videoJob.findFirst({
    where: { id: rootJobId, userId, projectId },
    select: { id: true },
  });
  return !!root;
}

function rootLinkInput(rootJobId: string | undefined): Record<string, unknown> {
  return rootJobId ? { mcpRootJobId: rootJobId, mcpMustBeFree: true } : {};
}

/**
 * The durable Export (`mode:"export"`). The burn config plus an optional native editor
 * snapshot draft are validated and joined to the server-owned preview of `sourceJobId`; the
 * worker then owns the burn, the Gallery save and the project transition.
 *
 * - `projectTransition: "always"` (web): the project moves to `exporting` right after the job
 *   is durable; a failure of that write propagates.
 * - `projectTransition: "while_in_flight"` (MCP chain): the write re-checks the export is
 *   still in flight in the same transaction and never fails the enqueue (ADR 0063 A2).
 */
export async function enqueueEditorExport(input: {
  user: EditorEnqueueUser;
  brandVisualAccess: { canUse: boolean };
  sourceJobId: string | undefined;
  subtitleOverlayConfig: unknown;
  /** The editor's native draft (`undefined` = none); becomes the export's editSnapshot. */
  editorSnapshot?: unknown;
  idempotencyKey: string;
  idempotencyFingerprint?: string | null;
  exportScript?: string;
  exportSceneCount?: number;
  rootJobId?: string;
  /** ADR 0063 auto chain marker, carried on the chained export's input. */
  mcpChainExport?: boolean;
  /** The in-flight cap (3) applies to customer-ordered work; the auto chain skips it. */
  inflightCap?: boolean;
  projectTransition?: "always" | "while_in_flight";
  /**
   * T6 (ADR 0064, G12): the Pending Edit Draft revision this export applies (MCP export_video).
   * Carried on the export's input; the worker clears the draft on success only while the
   * project is still at this revision.
   */
  pendingEditRevision?: number;
  /**
   * T8 (ADR 0064, G21): the web Post phase's CAS guard. When the editor loaded a Pending Edit
   * Draft, it sends back the revision it loaded; a mismatch here means the MCP agent changed the
   * draft while the web was editing, so the export is refused (`stale_revision`) rather than
   * silently overwriting or racing the agent's edit. Independent of `pendingEditRevision` above
   * (which only drives the G12 clear-on-export and is set by the MCP `export_video` tool) so this
   * guard never changes behaviour for that caller.
   */
  expectedPendingRevision?: number;
}): Promise<EditorEnqueueResult> {
  const { user, sourceJobId, brandVisualAccess } = input;
  if (!sourceJobId) return refuse(400, "invalid_source", SOURCE_NOT_FOUND_MESSAGE);
  const rawOverlay = input.subtitleOverlayConfig;
  if (!rawOverlay || typeof rawOverlay !== "object" || Array.isArray(rawOverlay)) {
    return refuse(400, "invalid_export", "ข้อมูลซับสำหรับส่งออกไม่ถูกต้อง");
  }
  const rawLogoOverlay = (rawOverlay as Record<string, unknown>).logoOverlay;
  const subtitleOverlayConfig: Record<string, unknown> = { ...rawOverlay };
  delete subtitleOverlayConfig.logoOverlay;

  const srcJob = await prisma.videoJob.findUnique({
    where: { id: sourceJobId },
    select: {
      userId: true,
      status: true,
      outputJson: true,
      projectId: true,
      contentPreflightId: true,
      projectVisualContextJson: true,
    },
  });
  if (!srcJob || srcJob.userId !== user.id) return refuse(404, "source_not_found", SOURCE_NOT_FOUND_MESSAGE);
  if (srcJob.status !== "done") return refuse(400, "source_not_ready", "วิดีโอต้นฉบับยังไม่พร้อม");
  if (!srcJob.projectId) return refuse(400, "project_required", "โปรเจกต์นี้ยังไม่พร้อมสำหรับส่งออกแบบทำงานเบื้องหลัง");
  const sourceProjectId = srcJob.projectId;
  await assertCurrentEditorExportSource(user.id, sourceProjectId, sourceJobId);
  const parsed = parseVideoJobOutput(srcJob.outputJson);
  if (!parsed?.preview) return refuse(400, "source_not_exportable", "วิดีโอต้นฉบับไม่มีข้อมูลสำหรับแก้ซับ/ส่งออก");
  const editSnapshot = input.editorSnapshot === undefined
    ? undefined
    : createEditorExportSnapshot({
        draft: input.editorSnapshot,
        sourcePreview: parsed.preview,
        videoUrl: subtitleOverlayConfig.videoUrl,
      });
  if (input.editorSnapshot !== undefined && !editSnapshot) {
    return refuse(400, "invalid_editor_snapshot", "ข้อมูลสถานะล่าสุดของหน้าตัดต่อไม่ถูกต้อง");
  }

  const rawHeadlineHook = subtitleOverlayConfig.headlineHook;
  if (rawHeadlineHook !== undefined) {
    const overlayDurationFrames = Number(subtitleOverlayConfig.durationInFrames);
    const overlayDurationMs = Number.isFinite(overlayDurationFrames) && overlayDurationFrames > 0
      ? (overlayDurationFrames / 30) * 1_000
      : 0;
    const headlineHook = normalizeHeadlineHook(
      rawHeadlineHook,
      Math.max(parsed.preview.audioDurationMs, overlayDurationMs),
    );
    if (!headlineHook) {
      return refuse(400, "invalid_headline_hook", "ข้อมูลพาดหัวเปิดคลิปไม่ถูกต้อง");
    }
    if (headlineHook.enabled) subtitleOverlayConfig.headlineHook = headlineHook;
    else delete subtitleOverlayConfig.headlineHook;
  }

  if (input.rootJobId && !(await rootBelongsToProject(user.id, input.rootJobId, sourceProjectId))) {
    return refuse(404, "source_not_found", SOURCE_NOT_FOUND_MESSAGE);
  }
  // T8 (ADR 0064, G21): once a loaded draft's revision is confirmed still current, it becomes
  // the export's `pendingEditRevision` too — reusing the SAME G12 clear-on-match trigger the MCP
  // `export_video` tool drives (orchestrator.ts), rather than adding a second clear path. The web
  // never sends `pendingEditRevision` itself; only the MCP tool does.
  let effectivePendingEditRevision = input.pendingEditRevision;
  if (typeof input.expectedPendingRevision === "number") {
    const currentProject = await prisma.editorProject.findFirst({
      where: { id: sourceProjectId, userId: user.id },
      select: { pendingEditRevision: true },
    });
    if (!currentProject || currentProject.pendingEditRevision !== input.expectedPendingRevision) {
      return refuse(409, "stale_revision", STALE_PENDING_REVISION_MESSAGE);
    }
    effectivePendingEditRevision = input.expectedPendingRevision;
  }
  if (input.inflightCap !== false && (await inflightCapReached(user.id))) {
    return refuse(429, "too_many_jobs", TOO_MANY_JOBS_MESSAGE);
  }

  const projectVisualPin = srcJob.projectVisualContextJson
    ? {
        contentPreflightId: srcJob.contentPreflightId,
        projectVisualContextJson: srcJob.projectVisualContextJson,
      }
    : null;
  const job = await createDurableExportWithStagedLogo({
    staging: {
      userId: user.id,
      plan: user.plan,
      // R12: the logo overlay stays a PRO/BUSINESS-plan feature. Wave 1b
      // opened PINNING to every plan, so the bare pin no longer implies
      // funded logo use — this reads the ADMITTED predicate, exactly
      // like the render path below.
      brandVisualAllowed: brandVisualAccess.canUse
        || await projectHasAdmittedPersistedPin({ userId: user.id, projectId: sourceProjectId }),
      projectId: sourceProjectId,
      rawLogoOverlay: rawLogoOverlay,
    },
    createDurableJob: async (trustedLogo) => {
      if (trustedLogo) subtitleOverlayConfig.logoOverlay = trustedLogo;
      return createVideoJob(
        user.id,
        {
          mode: "export",
          sourceJobId,
          subtitleOverlayConfig,
          ...(editSnapshot ? { editSnapshot } : {}),
          exportScript: input.exportScript,
          exportSceneCount: input.exportSceneCount,
          ...(input.mcpChainExport ? { mcpChainExport: true } : {}),
          ...rootLinkInput(input.rootJobId),
          ...(typeof effectivePendingEditRevision === "number" ? { mcpPendingEditRevision: effectivePendingEditRevision } : {}),
        },
        input.idempotencyKey,
        {
          projectId: sourceProjectId,
          type: "export",
          idempotencyFingerprint: input.idempotencyFingerprint ?? null,
          projectVisualPin,
        },
      );
    },
    afterDurableJobCreated: input.projectTransition === "while_in_flight"
      ? undefined
      : async (durableJob) => {
          await prisma.editorProject.updateMany({
            where: { id: sourceProjectId, userId: user.id },
            data: { activeExportJobId: durableJob.id, status: "exporting", lastOpenedAt: new Date() },
          });
        },
  });

  if (input.projectTransition === "while_in_flight") {
    try {
      // ADR 0063 fix round 1 (A2): re-check the export's own status in the SAME transaction as
      // the project write. A concurrent cancel can already have canceled this just-created
      // export; an unconditional write would land the project on "exporting" pointing at a
      // terminal job. The export's own cancel/finish path re-settles the project either way.
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.videoJob.findUnique({ where: { id: job.id }, select: { status: true } });
        if (fresh && (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes(fresh.status)) {
          await tx.editorProject.updateMany({
            where: { id: sourceProjectId, userId: user.id },
            data: { activeExportJobId: job.id, status: "exporting", lastOpenedAt: new Date() },
          });
        }
      });
    } catch {
      // The export's own finish/fail transition re-links the project; never lose the job here.
      console.warn(`[editor-export] could not mark project exporting for job ${job.id}`);
    }
  }
  return { ok: true, job };
}

/**
 * The B-roll window-edit rollout gate for a re-render of `srcJob`: a Brand Visual scene edit, or
 * the window-edit rollout (public flag, else internal testers). Shared with MCP
 * `replace_broll_window` (T13) so it refuses before importing anything.
 */
export function brollWindowEditEnabled(
  user: EditorEnqueueUser,
  srcJob: { projectId: string | null; contentPreflightId: string | null; projectVisualContextJson: string | null },
): boolean {
  const brandVisualSceneEdit = Boolean(
    srcJob.projectId && srcJob.contentPreflightId && srcJob.projectVisualContextJson,
  );
  return brandVisualSceneEdit
    || isInternalAiBetaEnabledFor(user, process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1");
}

/**
 * The free per-window B-roll re-render (`mode:"broll-rerender"`). Reuses the source job's TTS +
 * avatar and only swaps b-roll windows, so nothing new is fetched or charged here; the render
 * route's server-trusted `rerenderOf` skip is what makes the render itself free. Validates
 * shape + ownership, the rollout gate and the in-flight cap, then enqueues.
 */
export async function enqueueBrollRerender(input: {
  user: EditorEnqueueUser;
  sourceJobId: string | undefined;
  windowEdits: unknown;
  idempotencyKey: string;
  idempotencyFingerprint?: string | null;
  rootJobId?: string;
  /**
   * T13 (MCP export_video with window edits; needs `rootJobId`): when this re-render finishes,
   * the worker chains the Held Preview's export from it (`mcpExportAfterRerender`).
   * `appliedDraftWindowEdits` are the Pending Edit Draft entries this re-render applies; the
   * hop drops exactly those from the draft when it rebases the draft onto the re-render.
   */
  mcpExportAfter?: { appliedDraftWindowEdits: unknown[] };
}): Promise<EditorEnqueueResult> {
  const { user, sourceJobId } = input;
  if (!sourceJobId) return refuse(400, "invalid_source", SOURCE_NOT_FOUND_MESSAGE);
  const editsRes = validateWindowEdits(input.windowEdits);
  if ("error" in editsRes) return refuse(400, "invalid_edits", editsRes.error);

  const srcJob = await prisma.videoJob.findUnique({
    where: { id: sourceJobId },
    select: {
      userId: true,
      status: true,
      projectId: true,
      contentPreflightId: true,
      projectVisualContextJson: true,
      brandVisualAcceptanceJson: true,
    },
  });
  if (!srcJob || srcJob.userId !== user.id) return refuse(404, "source_not_found", SOURCE_NOT_FOUND_MESSAGE);
  if (srcJob.status !== "done") return refuse(400, "source_not_ready", "วิดีโอต้นฉบับยังไม่พร้อม (ยังเรนเดอร์ไม่เสร็จ)");
  if (!brollWindowEditEnabled(user, srcJob)) return refuse(404, "not_enabled");

  if (input.rootJobId && !(await rootBelongsToProject(user.id, input.rootJobId, srcJob.projectId))) {
    return refuse(404, "source_not_found", SOURCE_NOT_FOUND_MESSAGE);
  }
  if (await inflightCapReached(user.id)) return refuse(429, "too_many_jobs", TOO_MANY_JOBS_MESSAGE);

  // Inherit the SOURCE job's projectId (server-trusted — never a body projectId) so the
  // new job re-links the EditorProject on finish (finishJob sets activeJobId only when
  // job.projectId is set); otherwise reopening the project reverts to the pre-edit video.
  // srcJob.userId === user.id is already verified above, so this preserves the IDOR guard.
  const job = await createVideoJob(
    user.id,
    {
      mode: "broll-rerender",
      previewMode: true,
      sourceJobId,
      windowEdits: editsRes,
      ...rootLinkInput(input.rootJobId),
      ...(input.rootJobId && input.mcpExportAfter
        ? {
            mcpExportAfterRerender: true,
            mcpAppliedDraftWindowEdits: input.mcpExportAfter.appliedDraftWindowEdits,
          }
        : {}),
    },
    input.idempotencyKey,
    {
      projectId: srcJob.projectId,
      idempotencyFingerprint: input.idempotencyFingerprint ?? null,
      projectVisualPin: srcJob.projectVisualContextJson ? {
        contentPreflightId: srcJob.contentPreflightId,
        projectVisualContextJson: srcJob.projectVisualContextJson,
      } : null,
      brandVisualAcceptanceJson: srcJob.brandVisualAcceptanceJson,
    },
  );
  return { ok: true, job };
}
