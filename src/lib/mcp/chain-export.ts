import type { Prisma, VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createVideoJob, parseVideoJobOutput } from "@/lib/mcp/video-job";
import { assertCurrentEditorExportSource, createEditorProject } from "@/lib/editor-projects";
import { createEditorExportSnapshot } from "@/lib/editor-export-snapshot";
import {
  buildBurnConfig,
  RENDER_FPS,
  resolvedMcpSubtitleDesignFromInput,
  v2SubConfigToHeroDesign,
  type OrchCaption,
  type ResolvedMcpSubtitleJobInput,
} from "@/lib/mcp/orchestrator-steps";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";

/**
 * T8 (ADR 0063): an MCP video is an Agent-created Project — a Preview Mode job followed by
 * ONE server-chained `mode:"export"` job.
 *
 * The chain lives entirely in job data (no schema change):
 *  - the preview is a `type:"create"` row whose inputJson carries `mcpChainExport: true`;
 *  - its export is the row under the unique `(userId, idempotencyKey)` pair with key
 *    `mcp-chain:<previewJobId>`. That unique index is both the link and the idempotency
 *    guarantee: every enqueue attempt (finish, status read, watchdog) is a no-op once a row
 *    exists under the key, whatever its status.
 *  - A permanent refusal (or, for T10, a cancel) is a terminal marker row under the same key,
 *    so recovery never enqueues after it.
 */

export const MCP_CHAIN_IDEMPOTENCY_PREFIX = "mcp-chain:";

/** Draft marker on an Agent-created Project (`EditorProject.draftJson.createdVia`). */
export const MCP_PROJECT_CREATED_VIA = "mcp";

export function mcpChainExportKey(previewJobId: string): string {
  return `${MCP_CHAIN_IDEMPOTENCY_PREFIX}${previewJobId}`;
}

/** Caller-supplied keys may never claim the server's chain namespace. */
export function isReservedMcpChainIdempotencyKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith(MCP_CHAIN_IDEMPOTENCY_PREFIX);
}

/** R-T8-6: evaluated at create time only. Chain-following never reads this flag. */
export function mcpEditorProjectEnabledFor(user: { email?: string | null }): boolean {
  return isInternalAiBetaEnabledFor(user, process.env.MCP_EDITOR_PROJECT_PUBLIC === "1");
}

function jobInput(inputJson: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(inputJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The only rows that ever trigger a chain: MCP-marked `type:"create"` previews. Web
 *  previews, B-roll re-renders and exports never carry the marker or are not `create`. */
export function isMcpChainPreview(job: { type: string; inputJson: string }): boolean {
  return job.type === "create" && jobInput(job.inputJson)?.mcpChainExport === true;
}

function isExportOf(row: { type: string; inputJson: string }, previewJobId: string): boolean {
  if (row.type !== "export") return false;
  const input = jobInput(row.inputJson);
  return input?.mode === "export" && input.sourceJobId === previewJobId;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

// ── create ────────────────────────────────────────────────────────────────────────────────

export type CreateMcpVideoJobResult =
  | { kind: "reserved_key" }
  | { kind: "created"; job: VideoJob; projectId: string | null };

/**
 * create_video_job's persistence step. Flag off: exactly PR-A's `createVideoJob` call.
 * Flag on: an EditorProject (draft `{createdVia:"mcp"}`) plus a Preview Mode job marked for
 * the server-chained export. A P2002 (duplicate idempotencyKey) is rethrown for the route to
 * map, after removing the project this attempt created.
 */
export async function createMcpVideoJob(
  user: { id: string; email?: string | null },
  input: Record<string, unknown>,
  idempotencyKey: string | undefined,
  opts: { title?: string } = {},
): Promise<CreateMcpVideoJobResult> {
  if (isReservedMcpChainIdempotencyKey(idempotencyKey)) return { kind: "reserved_key" };
  if (!mcpEditorProjectEnabledFor(user)) {
    return { kind: "created", job: await createVideoJob(user.id, input, idempotencyKey), projectId: null };
  }

  const project = await createEditorProject(user.id, {
    title: opts.title,
    draft: { createdVia: MCP_PROJECT_CREATED_VIA },
  });
  let job: VideoJob;
  try {
    job = await createVideoJob(
      user.id,
      { ...input, previewMode: true, mcpChainExport: true },
      idempotencyKey,
      { projectId: project.id },
    );
  } catch (error) {
    await prisma.editorProject.deleteMany({ where: { id: project.id, userId: user.id } }).catch(() => {});
    throw error;
  }
  try {
    await prisma.editorProject.updateMany({
      where: { id: project.id, userId: user.id },
      data: { activeJobId: job.id, status: "rendering", lastOpenedAt: new Date() },
    });
  } catch {
    // The job is queued and linked by projectId; the preview's finish sets activeJobId anyway.
    console.warn(`[mcp-chain] could not mark project rendering for job ${job.id}`);
  }
  return { kind: "created", job, projectId: project.id };
}

// ── chain lookup ──────────────────────────────────────────────────────────────────────────

const CHAIN_ROW_SELECT = {
  id: true,
  userId: true,
  type: true,
  status: true,
  currentStep: true,
  progress: true,
  outputJson: true,
  errorMessage: true,
  errorCode: true,
  errorProvider: true,
  reservationRefundPending: true,
  fundingState: true,
  inputJson: true,
  idempotencyKey: true,
  projectId: true,
} satisfies Prisma.VideoJobSelect;

export type McpChainRow = Prisma.VideoJobGetPayload<{ select: typeof CHAIN_ROW_SELECT }>;

export type McpChain = {
  preview: McpChainRow;
  /** The export (or terminal marker) under the chain key. */
  exportJob: McpChainRow | null;
  /** A row under the chain key that is not an export of this preview (never written by the
   *  server; only a caller that used the reserved prefix through another surface). */
  conflict: boolean;
};

function chainKeyRow(userId: string, previewJobId: string) {
  return prisma.videoJob.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey: mcpChainExportKey(previewJobId) } },
    select: CHAIN_ROW_SELECT,
  });
}

/**
 * Owner-scoped: the chain of `jobId` when it is an MCP chain preview or that preview's
 * chained export, else null. Another user's id resolves to null (never "exists").
 */
export async function resolveMcpChain(userId: string, jobId: string): Promise<McpChain | null> {
  const row = await prisma.videoJob.findFirst({ where: { id: jobId, userId }, select: CHAIN_ROW_SELECT });
  if (!row) return null;
  let preview: McpChainRow | null = null;
  if (isMcpChainPreview(row)) {
    preview = row;
  } else if (row.type === "export") {
    const sourceJobId = jobInput(row.inputJson)?.sourceJobId;
    if (
      typeof sourceJobId === "string"
      && row.idempotencyKey === mcpChainExportKey(sourceJobId)
      && isExportOf(row, sourceJobId)
    ) {
      const source = await prisma.videoJob.findFirst({
        where: { id: sourceJobId, userId },
        select: CHAIN_ROW_SELECT,
      });
      if (source && isMcpChainPreview(source)) preview = source;
    }
  }
  if (!preview) return null;
  const keyed = await chainKeyRow(userId, preview.id);
  if (keyed && !isExportOf(keyed, preview.id)) return { preview, exportJob: null, conflict: true };
  return { preview, exportJob: keyed, conflict: false };
}

// ── terminal markers ──────────────────────────────────────────────────────────────────────

async function writeMarkerRow(input: {
  userId: string;
  previewJobId: string;
  status: "failed" | "canceled";
  code: string;
  message: string;
}): Promise<{ created: boolean; id: string }> {
  try {
    const row = await prisma.videoJob.create({
      data: {
        userId: input.userId,
        type: "export",
        status: input.status,
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: input.previewJobId,
          mcpChainExport: true,
          mcpChainMarker: true,
        }),
        idempotencyKey: mcpChainExportKey(input.previewJobId),
        errorCode: input.code.slice(0, 80),
        errorMessage: input.message.slice(0, 1000),
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return { created: true, id: row.id };
  } catch (error) {
    if (errorCodeOf(error) === "P2002") {
      const row = await chainKeyRow(input.userId, input.previewJobId);
      if (row) return { created: false, id: row.id };
    }
    throw error;
  }
}

/**
 * Close a chain without an export: writes a terminal row under the chain key so neither
 * get_video_status nor the watchdog ever enqueues one afterwards. T10's cancel uses
 * `status:"canceled"`. A no-op when a row already holds the key (the caller then cancels
 * that row through the normal cancel path). Owner-scoped.
 */
export async function writeMcpChainTerminalMarker(input: {
  userId: string;
  previewJobId: string;
  status: "failed" | "canceled";
  code: string;
  message: string;
}): Promise<{ kind: "written" | "exists"; exportJobId: string } | { kind: "not_chain" }> {
  const preview = await prisma.videoJob.findFirst({
    where: { id: input.previewJobId, userId: input.userId },
    select: { id: true, type: true, inputJson: true },
  });
  if (!preview || !isMcpChainPreview(preview)) return { kind: "not_chain" };
  const marker = await writeMarkerRow(input);
  return { kind: marker.created ? "written" : "exists", exportJobId: marker.id };
}

// ── enqueue ───────────────────────────────────────────────────────────────────────────────

export type McpChainEnqueueResult =
  | { kind: "enqueued"; exportJobId: string }
  | { kind: "exists"; exportJobId: string }
  | { kind: "refused"; code: string; exportJobId: string }
  | { kind: "not_chain" }
  | { kind: "not_ready" }
  | { kind: "deferred"; reason: "render_maintenance" | "enqueue_failed" };

type ChainPreviewRow = {
  id: string;
  userId: string;
  inputJson: string;
  outputJson: string | null;
  projectId: string | null;
  contentPreflightId: string | null;
  projectVisualContextJson: string | null;
};

type ChainExportPlan =
  | {
      ok: true;
      projectId: string;
      input: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string };

/** Existing copy only (jobs route + orchestrator), keyed by the existing codes. */
const REFUSAL_COPY: Record<string, string> = {
  project_required: "โปรเจกต์นี้ยังไม่พร้อมสำหรับส่งออกแบบทำงานเบื้องหลัง",
  project_not_found: "ไม่พบโปรเจกต์",
  stale_export_source: "โปรเจกต์มีวิดีโอเวอร์ชันใหม่กว่า — กรุณากลับไปใช้เวอร์ชันล่าสุดแล้วส่งออกอีกครั้ง",
  source_not_exportable: "วิดีโอต้นฉบับไม่มีข้อมูลสำหรับแก้ซับ/ส่งออก",
  invalid_editor_snapshot: "ข้อมูลสถานะล่าสุดของหน้าตัดต่อไม่ถูกต้อง",
};

function refusal(code: keyof typeof REFUSAL_COPY): ChainExportPlan {
  return { ok: false, code, message: REFUSAL_COPY[code] };
}

/**
 * R-T8-4: the export's overlay and editorSnapshot come from the preview's persisted resolved
 * design (T4) and its captions — the same `buildBurnConfig` look the PR-A MCP burn uses, on
 * the preview's own (already paid) base, so the burn is free via isBurnAlreadyPaid.
 */
async function planChainExport(preview: ChainPreviewRow): Promise<ChainExportPlan> {
  if (!preview.projectId) return refusal("project_required");
  try {
    await assertCurrentEditorExportSource(preview.userId, preview.projectId, preview.id);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "project_not_found" || code === "stale_export_source") return refusal(code);
    throw error;
  }
  const output = parseVideoJobOutput(preview.outputJson);
  const sourcePreview = output?.preview;
  const baseVideoUrl = output?.videoUrl;
  if (!sourcePreview || !baseVideoUrl || !Array.isArray(sourcePreview.captions) || sourcePreview.captions.length === 0) {
    return refusal("source_not_exportable");
  }

  const previewInput = jobInput(preview.inputJson) ?? {};
  const { design, cardLen } = resolvedMcpSubtitleDesignFromInput(previewInput as ResolvedMcpSubtitleJobInput);
  const captions: OrchCaption[] = sourcePreview.captions.map((caption, index) => ({
    ...caption,
    tag: caption.tag === "hook" || caption.tag === "body" || caption.tag === "cta"
      ? caption.tag
      : (index === 0 ? "hook" : "body"),
  }));
  const subtitleOverlayConfig = buildBurnConfig(
    baseVideoUrl,
    captions,
    sourcePreview.audioDurationMs,
    v2SubConfigToHeroDesign(design),
    RENDER_FPS,
  );
  const editSnapshot = createEditorExportSnapshot({
    draft: {
      version: 1,
      captions,
      originalCaptions: captions,
      subtitleConfig: design,
      cardLen,
      captionOverrides: {},
    },
    sourcePreview,
    videoUrl: baseVideoUrl,
  });
  if (!editSnapshot) return refusal("invalid_editor_snapshot");

  const script = typeof previewInput.script === "string" ? previewInput.script.slice(0, 20_000) : "";
  return {
    ok: true,
    projectId: preview.projectId,
    input: {
      mode: "export",
      sourceJobId: preview.id,
      subtitleOverlayConfig,
      editSnapshot,
      ...(script.trim() ? { exportScript: script } : {}),
      mcpChainExport: true,
    },
  };
}

/**
 * Idempotently enqueue the chained export for a finished MCP chain preview. Callers: the
 * orchestrator right AFTER the preview's finish transaction committed (never inside
 * `onTransition`), get_video_status and the watchdog (lost-enqueue recovery).
 *
 * - The preview must be owned by `userId`, chain-marked and `done` (a read outside any
 *   transaction, so it can only succeed after the finish committed).
 * - No in-flight cap: this is the server finishing work the customer already ordered.
 * - A permanent refusal writes a failed marker under the chain key (existing codes/copy).
 * - Transient failures (deploy drain, SQLite) return `deferred`; a later poll or sweep retries.
 */
export async function enqueueMcpChainExport(input: {
  previewJobId: string;
  userId: string;
}): Promise<McpChainEnqueueResult> {
  const preview = await prisma.videoJob.findFirst({
    where: { id: input.previewJobId, userId: input.userId },
    select: {
      id: true,
      userId: true,
      type: true,
      status: true,
      inputJson: true,
      outputJson: true,
      projectId: true,
      contentPreflightId: true,
      projectVisualContextJson: true,
    },
  });
  if (!preview || !isMcpChainPreview(preview)) return { kind: "not_chain" };
  if (preview.status !== "done") return { kind: "not_ready" };

  const existing = await chainKeyRow(preview.userId, preview.id);
  if (existing) return { kind: "exists", exportJobId: existing.id };

  const plan = await planChainExport(preview);
  if (!plan.ok) {
    const marker = await writeMarkerRow({
      userId: preview.userId,
      previewJobId: preview.id,
      status: "failed",
      code: plan.code,
      message: plan.message,
    });
    return marker.created
      ? { kind: "refused", code: plan.code, exportJobId: marker.id }
      : { kind: "exists", exportJobId: marker.id };
  }

  let exportJob: VideoJob;
  try {
    exportJob = await createVideoJob(preview.userId, plan.input, mcpChainExportKey(preview.id), {
      projectId: plan.projectId,
      type: "export",
      projectVisualPin: preview.projectVisualContextJson
        ? {
            contentPreflightId: preview.contentPreflightId,
            projectVisualContextJson: preview.projectVisualContextJson,
          }
        : null,
    });
  } catch (error) {
    if (errorCodeOf(error) === "P2002") {
      const row = await chainKeyRow(preview.userId, preview.id);
      if (row) return { kind: "exists", exportJobId: row.id };
    }
    const reason = (error as { name?: unknown } | null)?.name === "RenderDeployDrainError"
      ? "render_maintenance" as const
      : "enqueue_failed" as const;
    console.warn(`[mcp-chain] export enqueue deferred for job ${preview.id}: ${reason}`);
    return { kind: "deferred", reason };
  }

  try {
    // Same project transition the web export route makes after creating its durable job.
    await prisma.editorProject.updateMany({
      where: { id: plan.projectId, userId: preview.userId },
      data: { activeExportJobId: exportJob.id, status: "exporting", lastOpenedAt: new Date() },
    });
  } catch {
    // The export's own finish/fail transition re-links the project; never lose the job here.
    console.warn(`[mcp-chain] could not mark project exporting for job ${exportJob.id}`);
  }
  return { kind: "enqueued", exportJobId: exportJob.id };
}

/** Never throws: a chain enqueue must never fail (or refund) the preview that just finished. */
export async function enqueueMcpChainExportSafely(input: {
  previewJobId: string;
  userId: string;
}): Promise<McpChainEnqueueResult | null> {
  try {
    return await enqueueMcpChainExport(input);
  } catch {
    console.warn(`[mcp-chain] export enqueue failed for job ${input.previewJobId}; recovery will retry`);
    return null;
  }
}

// ── watchdog recovery ─────────────────────────────────────────────────────────────────────

/** Only recent previews are scanned; get_video_status recovers anything older on demand. */
const CHAIN_RECOVERY_LOOKBACK_MS = 24 * 60 * 60_000;
const CHAIN_RECOVERY_SCAN_LIMIT = 1_000;
const CHAIN_RECOVERY_BATCH = 50;

/**
 * Lost-enqueue recovery for the worker's sweep: every recently finished MCP chain preview
 * with no row under its chain key gets the same idempotent enqueue. Returns the preview ids
 * whose chain this sweep closed (enqueued or refused-with-marker).
 */
export async function recoverLostMcpChainExports(now: Date = new Date()): Promise<string[]> {
  const candidates = await prisma.videoJob.findMany({
    where: {
      status: "done",
      type: "create",
      inputJson: { contains: "\"mcpChainExport\":true" },
      finishedAt: { gte: new Date(now.getTime() - CHAIN_RECOVERY_LOOKBACK_MS) },
    },
    orderBy: { finishedAt: "desc" },
    take: CHAIN_RECOVERY_SCAN_LIMIT,
    select: { id: true, userId: true, type: true, inputJson: true },
  });
  const previews = candidates.filter(isMcpChainPreview);
  if (previews.length === 0) return [];

  const keyed = await prisma.videoJob.findMany({
    where: { idempotencyKey: { in: previews.map((preview) => mcpChainExportKey(preview.id)) } },
    select: { userId: true, idempotencyKey: true },
  });
  const held = new Set(keyed.map((row) => `${row.userId}\n${row.idempotencyKey}`));
  const missing = previews
    .filter((preview) => !held.has(`${preview.userId}\n${mcpChainExportKey(preview.id)}`))
    .slice(0, CHAIN_RECOVERY_BATCH);

  const recovered: string[] = [];
  for (const preview of missing) {
    const result = await enqueueMcpChainExportSafely({ previewJobId: preview.id, userId: preview.userId });
    if (result?.kind === "enqueued" || result?.kind === "refused") recovered.push(preview.id);
  }
  return recovered;
}
