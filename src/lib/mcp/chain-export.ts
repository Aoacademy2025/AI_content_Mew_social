import type { Prisma, VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { INTERNAL_JOB_FAILURE_CODE, createVideoJob, parseVideoJobOutput } from "@/lib/mcp/video-job";
import { assertCurrentEditorExportSource, createEditorProject } from "@/lib/editor-projects";
import { enqueueEditorExport } from "@/lib/editor-export-enqueue";
import {
  buildBurnConfig,
  RENDER_FPS,
  resolvedMcpSubtitleDesignFromInput,
  v2SubConfigToHeroDesign,
  type OrchCaption,
  type ResolvedMcpSubtitleJobInput,
} from "@/lib/mcp/orchestrator-steps";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import { RenderDeployDrainError } from "@/lib/render-deploy-drain";
import { isTransientDbError } from "@/lib/prisma-transient-retry";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  MCP_CHAIN_IDEMPOTENCY_PREFIX,
  isReservedMcpChainIdempotencyKey,
  mcpChainExportKey,
  mcpExportKey,
  mcpRerenderKey,
} from "@/lib/mcp/chain-key";

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
 *
 * T5 (ADR 0064): a Held Preview is the other kind of MCP root — a `type:"create"` row whose
 * inputJson carries `mcpHold: true`. It never chains: every trigger (the orchestrator's finish
 * hook, get_video_status, the watchdog) skips it, and the agent exports it later through the
 * Pending Edit Draft. Every job spawned after it carries `inputJson.mcpRootJobId` and is keyed
 * `mcp-rerender:<root>:<rev>` / `mcp-export:<root>:<rev>` (G7).
 */

export {
  MCP_CHAIN_IDEMPOTENCY_PREFIX,
  mcpChainExportKey,
  mcpExportKey,
  mcpRerenderKey,
  isReservedMcpChainIdempotencyKey,
};

/** Draft marker on an Agent-created Project (`EditorProject.draftJson.createdVia`). */
export const MCP_PROJECT_CREATED_VIA = "mcp";

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
 *  previews, B-roll re-renders and exports never carry the marker or are not `create`.
 *  A Held Preview (`mcpHold`) never chains, even if it also carried the chain marker. */
export function isMcpChainPreview(job: { type: string; inputJson: string }): boolean {
  if (job.type !== "create") return false;
  const input = jobInput(job.inputJson);
  return input?.mcpChainExport === true && input.mcpHold !== true;
}

/** T5 (G6): an MCP Held Preview — the root of an agent's edit-before-export chain. */
export function isMcpHeldRoot(job: { type: string; inputJson: string }): boolean {
  return job.type === "create" && jobInput(job.inputJson)?.mcpHold === true;
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

/** `hold` needs the Agent-created Project; without the MCP Editor Project flag it is refused. */
export class McpHoldNotEnabledError extends Error {
  readonly code = "feature_not_enabled";

  constructor() {
    super("mcp hold requires the MCP Editor Project flag");
    this.name = "McpHoldNotEnabledError";
  }
}

/**
 * create_video_job's persistence step. Flag off: exactly PR-A's `createVideoJob` call.
 * Flag on: an EditorProject (draft `{createdVia:"mcp"}`) plus a Preview Mode job marked for
 * the server-chained export — or, with `hold` (T5, G6), marked as a Held Preview that never
 * chains. A P2002 (duplicate idempotencyKey) is rethrown for the route to map, after
 * removing the project this attempt created.
 */
export async function createMcpVideoJob(
  user: { id: string; email?: string | null },
  input: Record<string, unknown>,
  idempotencyKey: string | undefined,
  opts: { title?: string; hold?: boolean } = {},
): Promise<CreateMcpVideoJobResult> {
  if (isReservedMcpChainIdempotencyKey(idempotencyKey)) return { kind: "reserved_key" };
  if (!mcpEditorProjectEnabledFor(user)) {
    if (opts.hold) throw new McpHoldNotEnabledError();
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
      opts.hold
        ? { ...input, previewMode: true, mcpHold: true }
        : { ...input, previewMode: true, mcpChainExport: true },
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

/** ADR 0063 auto chain: a preview and the export (or marker) under `mcp-chain:<preview>`. */
export type McpAutoChain = {
  kind: "auto";
  preview: McpChainRow;
  /** The export (or terminal marker) under the chain key. */
  exportJob: McpChainRow | null;
  /** A row under the chain key that is not an export of this preview (never written by the
   *  server; only a caller that used the reserved prefix through another surface). */
  conflict: boolean;
};

/** T5 (G6/G8): a Held Preview and its newest descendant (`inputJson.mcpRootJobId`), if any. */
export type McpHeldChain = {
  kind: "held";
  root: McpChainRow;
  /** Newest job spawned after the root (B-roll re-render or export), by createdAt. */
  latest: McpChainRow | null;
  // Absent on a held chain; declared so auto-chain field reads type-check on the union.
  preview?: never;
  exportJob?: never;
  conflict?: never;
};

export type McpChain = McpAutoChain | McpHeldChain;

function chainKeyRow(userId: string, previewJobId: string) {
  return prisma.videoJob.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey: mcpChainExportKey(previewJobId) } },
    select: CHAIN_ROW_SELECT,
  });
}

/** How many newest root-linked rows are read to find the newest strictly-linked one. */
const HELD_DESCENDANT_SCAN = 20;

/** The newest job linked to `root` by `inputJson.mcpRootJobId` (same user, same project). */
async function latestHeldDescendant(userId: string, root: McpChainRow): Promise<McpChainRow | null> {
  if (!root.projectId) return null;
  const rows = await prisma.videoJob.findMany({
    where: {
      userId,
      projectId: root.projectId,
      inputJson: { contains: `"mcpRootJobId":${JSON.stringify(root.id)}` },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HELD_DESCENDANT_SCAN,
    select: CHAIN_ROW_SELECT,
  });
  // The substring filter narrows; the parsed field decides.
  return rows.find((candidate) => jobInput(candidate.inputJson)?.mcpRootJobId === root.id) ?? null;
}

/**
 * The preview a held chain currently shows: its newest finished B-roll re-render (a linked
 * `type:"create"` row), else the root itself.
 */
export async function currentHeldPreviewRow(userId: string, root: McpChainRow): Promise<McpChainRow> {
  if (!root.projectId) return root;
  const rows = await prisma.videoJob.findMany({
    where: {
      userId,
      projectId: root.projectId,
      type: "create",
      status: "done",
      inputJson: { contains: `"mcpRootJobId":${JSON.stringify(root.id)}` },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HELD_DESCENDANT_SCAN,
    select: CHAIN_ROW_SELECT,
  });
  return rows.find((candidate) => jobInput(candidate.inputJson)?.mcpRootJobId === root.id) ?? root;
}

/** A Held Preview root `row` is, or the root `row` is linked to (owner + project scoped). */
async function heldRootOf(userId: string, row: McpChainRow): Promise<McpChainRow | null> {
  if (isMcpHeldRoot(row)) return row;
  const rootJobId = jobInput(row.inputJson)?.mcpRootJobId;
  if (typeof rootJobId !== "string" || !rootJobId || !row.projectId) return null;
  const root = await prisma.videoJob.findFirst({
    where: { id: rootJobId, userId, projectId: row.projectId },
    select: CHAIN_ROW_SELECT,
  });
  return root && isMcpHeldRoot(root) ? root : null;
}

/**
 * Owner-scoped: the chain of `jobId`, else null. Another user's id resolves to null (never
 * "exists").
 *  - `auto`: `jobId` is an MCP chain preview or that preview's chained export (ADR 0063).
 *  - `held`: `jobId` is a Held Preview or any job linked to one by `mcpRootJobId` (T5).
 */
export async function resolveMcpChain(userId: string, jobId: string): Promise<McpChain | null> {
  const row = await prisma.videoJob.findFirst({ where: { id: jobId, userId }, select: CHAIN_ROW_SELECT });
  if (!row) return null;
  const heldRoot = await heldRootOf(userId, row);
  if (heldRoot) {
    return { kind: "held", root: heldRoot, latest: await latestHeldDescendant(userId, heldRoot) };
  }
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
  if (keyed && !isExportOf(keyed, preview.id)) return { kind: "auto", preview, exportJob: null, conflict: true };
  return { kind: "auto", preview, exportJob: keyed, conflict: false };
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
      subtitleOverlayConfig: ReturnType<typeof buildBurnConfig>;
      /** The editor-native draft `enqueueEditorExport` turns into the export's editSnapshot. */
      editorSnapshot: Record<string, unknown>;
      exportScript?: string;
    }
  | { ok: false; code: string; message: string };

/** Existing copy only (jobs route + orchestrator), keyed by the existing codes. T6 reuses it
 *  for export_video's refusals. */
export const REFUSAL_COPY: Record<string, string> = {
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
 * T5: the plan only builds the burn input; `enqueueEditorExport` (shared with the web jobs
 * route) validates it and creates the row.
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
  const script = typeof previewInput.script === "string" ? previewInput.script.slice(0, 20_000) : "";
  return {
    ok: true,
    subtitleOverlayConfig,
    editorSnapshot: {
      version: 1,
      captions,
      originalCaptions: captions,
      subtitleConfig: design,
      cardLen,
      captionOverrides: {},
    },
    ...(script.trim() ? { exportScript: script } : {}),
  };
}

function isRenderDeployDrain(error: unknown): boolean {
  if (error instanceof RenderDeployDrainError) return true;
  const named = error as { name?: unknown; code?: unknown } | null;
  return named?.name === "RenderDeployDrainError" || named?.code === "render_deploy_drain";
}

/**
 * Fix round 1 (L1): only the deploy-drain refusal and SQLite busy/locked/timeouts clear on
 * their own, so only they stay retryable by recovery (poll / watchdog). Every other error
 * fails the same way on each retry and would leave get_video_status at processing/85 forever.
 */
export function isRetryableMcpChainEnqueueError(error: unknown): boolean {
  return isRenderDeployDrain(error) || isTransientDbError(error);
}

/**
 * Retryable → `deferred` (no row). Anything else → a terminal failed marker under the chain
 * key with the existing `internal` code and generic copy. Settlement is untouched: the
 * preview's single charge stands exactly as the existing export-failure paths leave it.
 * If the marker write itself fails, the error propagates (enqueueMcpChainExportSafely → null)
 * and the next poll or sweep tries again.
 */
async function deferOrCloseChain(
  preview: { id: string; userId: string },
  error: unknown,
): Promise<McpChainEnqueueResult> {
  if (isRetryableMcpChainEnqueueError(error)) {
    const reason = isRenderDeployDrain(error) ? "render_maintenance" as const : "enqueue_failed" as const;
    console.warn(`[mcp-chain] export enqueue deferred for job ${preview.id}: ${reason}`);
    return { kind: "deferred", reason };
  }
  // Class name only — an error message can carry script text or media URLs.
  const errorName = error instanceof Error ? error.name : typeof error;
  console.warn(`[mcp-chain] export enqueue failed permanently for job ${preview.id}: ${errorName}`);
  const marker = await writeMarkerRow({
    userId: preview.userId,
    previewJobId: preview.id,
    status: "failed",
    code: INTERNAL_JOB_FAILURE_CODE,
    message: GENERIC_ERROR_COPY,
  });
  return marker.created
    ? { kind: "refused", code: INTERNAL_JOB_FAILURE_CODE, exportJobId: marker.id }
    : { kind: "exists", exportJobId: marker.id };
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
 * - Any other error closes the chain with a failed `internal` marker (fix round 1, L1).
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
      user: { select: { plan: true, email: true } },
    },
  });
  if (!preview || !isMcpChainPreview(preview)) return { kind: "not_chain" };
  if (preview.status !== "done") return { kind: "not_ready" };

  const existing = await chainKeyRow(preview.userId, preview.id);
  if (existing) return { kind: "exists", exportJobId: existing.id };

  let plan: ChainExportPlan;
  try {
    plan = await planChainExport(preview);
  } catch (error) {
    return deferOrCloseChain(preview, error);
  }
  if (!plan.ok) return closeChainRefused(preview, plan.code, plan.message);

  let exportJob: VideoJob;
  try {
    const result = await enqueueEditorExport({
      user: { id: preview.userId, plan: preview.user.plan, email: preview.user.email },
      // The chain overlay never carries a logo, so logo staging is a no-op for it.
      brandVisualAccess: { canUse: false },
      sourceJobId: preview.id,
      subtitleOverlayConfig: plan.subtitleOverlayConfig,
      editorSnapshot: plan.editorSnapshot,
      idempotencyKey: mcpChainExportKey(preview.id),
      exportScript: plan.exportScript,
      mcpChainExport: true,
      // No in-flight cap: this is the server finishing work the customer already ordered.
      inflightCap: false,
      projectTransition: "while_in_flight",
    });
    if (!result.ok) {
      return closeChainRefused(
        preview,
        result.error,
        REFUSAL_COPY[result.error] ?? result.message ?? GENERIC_ERROR_COPY,
      );
    }
    exportJob = result.job;
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "P2002") {
      const row = await chainKeyRow(preview.userId, preview.id);
      if (row) return { kind: "exists", exportJobId: row.id };
    }
    // The preview stopped being the project's current render between the plan and the
    // enqueue's own re-check: the same permanent refusal the plan would have written.
    if (code === "project_not_found" || code === "stale_export_source") {
      return closeChainRefused(preview, code, REFUSAL_COPY[code]);
    }
    return deferOrCloseChain(preview, error);
  }
  return { kind: "enqueued", exportJobId: exportJob.id };
}

/** A permanent refusal: a failed marker under the chain key with the existing code/copy. */
async function closeChainRefused(
  preview: { id: string; userId: string },
  code: string,
  message: string,
): Promise<McpChainEnqueueResult> {
  const marker = await writeMarkerRow({
    userId: preview.userId,
    previewJobId: preview.id,
    status: "failed",
    code,
    message,
  });
  return marker.created
    ? { kind: "refused", code, exportJobId: marker.id }
    : { kind: "exists", exportJobId: marker.id };
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
