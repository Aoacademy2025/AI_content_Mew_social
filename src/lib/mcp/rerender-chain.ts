import { prisma } from "@/lib/prisma";
import { isMcpHeldRoot, isRetryableMcpChainEnqueueError, REFUSAL_COPY } from "@/lib/mcp/chain-export";
import { mcpExportKey } from "@/lib/mcp/chain-key";
import { enqueueEditorExport } from "@/lib/editor-export-enqueue";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";
import { INTERNAL_JOB_FAILURE_CODE } from "@/lib/mcp/video-job";
import {
  loadPendingEditState,
  savePendingEditDraft,
  toBurnConfig,
  toEditorSnapshotDraft,
  type PendingEditState,
} from "@/lib/mcp/pending-edit-draft";

/**
 * T13 (ADR 0064/0065, G19/G21): the hop from an MCP B-roll re-render to the Held Preview's export.
 *
 * `export_video` with window edits enqueues a free `broll-rerender` of the project's current
 * base (`mcp-rerender:<root>:<rev>`) carrying `mcpExportAfterRerender: true`. When that
 * re-render is done (it is then the project's `activeJobId`), this hop:
 *  1. rebases the Pending Edit Draft onto it — `baseJobId` = the re-render (G21: the web Post
 *     phase then loads the draft for it), dropping exactly the window edits it applied — then
 *  2. enqueues the export from it, keyed `mcp-export:<root>:<rev after the rebase>`, so a later
 *     `export_video` at that revision replays it.
 *
 * Every trigger runs the same idempotent hop: the orchestrator's finish (the normal path), the
 * worker watchdog sweep (`recoverLostMcpRerenderExports`, after a restart or a deploy drain) and
 * get_video_status / export_video (on read). An export of the re-render that already exists —
 * a real one or a refusal marker — ends it. Nothing here charges: the export is flagged
 * `mcpMustBeFree` and burns onto a re-render the render route recorded as free (G4).
 */

export type McpRerenderHopResult =
  | { kind: "not_applicable" }
  /** The project moved on to another render; this re-render is no longer the base. */
  | { kind: "superseded" }
  /** A transient condition (deploy drain, busy database, a concurrent draft write): retried later. */
  | { kind: "deferred"; reason: "busy" | "stale" }
  | { kind: "exists"; exportJobId: string }
  | { kind: "enqueued"; exportJobId: string }
  /** A permanent refusal, recorded as a failed export marker under the export key. */
  | { kind: "refused"; code: string; exportJobId: string };

function jobInput(inputJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A finished-or-not MCP B-roll re-render whose export the server owes (server-set flag). */
export function isMcpExportAfterRerender(row: { type: string; inputJson: string }): boolean {
  if (row.type !== "create") return false;
  const input = jobInput(row.inputJson);
  return input?.mode === "broll-rerender"
    && input.mcpExportAfterRerender === true
    && typeof input.mcpRootJobId === "string";
}

/** An export (or refusal marker) of re-render `rerenderJobId`, linked to `rootJobId`. */
async function exportOfRerender(userId: string, projectId: string, rootJobId: string, rerenderJobId: string) {
  const rows = await prisma.videoJob.findMany({
    where: {
      userId,
      projectId,
      type: "export",
      inputJson: { contains: `"sourceJobId":${JSON.stringify(rerenderJobId)}` },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, inputJson: true },
  });
  return rows.find((row) => {
    const input = jobInput(row.inputJson);
    return input?.sourceJobId === rerenderJobId && input.mcpRootJobId === rootJobId;
  }) ?? null;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A permanent refusal: a failed export marker under the export key (never a charge). */
async function writeRefusalMarker(input: {
  userId: string;
  projectId: string;
  rootJobId: string;
  rerenderJobId: string;
  idempotencyKey: string;
  code: string;
  message: string;
}): Promise<McpRerenderHopResult> {
  try {
    const marker = await prisma.videoJob.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        type: "export",
        status: "failed",
        inputJson: JSON.stringify({
          mode: "export",
          sourceJobId: input.rerenderJobId,
          mcpRootJobId: input.rootJobId,
          mcpMustBeFree: true,
          mcpChainMarker: true,
        }),
        idempotencyKey: input.idempotencyKey,
        errorCode: input.code,
        errorMessage: input.message,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return { kind: "refused", code: input.code, exportJobId: marker.id };
  } catch (error) {
    if (errorCodeOf(error) !== "P2002") throw error;
    const existing = await prisma.videoJob.findUnique({
      where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
      select: { id: true },
    });
    if (!existing) throw error;
    return { kind: "exists", exportJobId: existing.id };
  }
}

/**
 * The hop for one finished re-render. Idempotent; safe to run from every trigger. Throws only
 * on an unexpected database error (callers use the `Safely` wrapper).
 */
export async function continueMcpRerenderChain(input: {
  userId: string;
  rerenderJobId: string;
}): Promise<McpRerenderHopResult> {
  const { userId } = input;
  const rerender = await prisma.videoJob.findFirst({
    where: { id: input.rerenderJobId, userId },
    select: { id: true, type: true, status: true, inputJson: true, projectId: true },
  });
  if (!rerender || rerender.status !== "done" || !rerender.projectId || !isMcpExportAfterRerender(rerender)) {
    return { kind: "not_applicable" };
  }
  const projectId = rerender.projectId;
  const rerenderInput = jobInput(rerender.inputJson) ?? {};
  const rootJobId = rerenderInput.mcpRootJobId as string;
  const root = await prisma.videoJob.findFirst({
    where: { id: rootJobId, userId, projectId },
    select: { id: true, type: true, status: true, inputJson: true, projectId: true },
  });
  if (!root || root.status !== "done" || !isMcpHeldRoot(root)) return { kind: "not_applicable" };

  const existing = await exportOfRerender(userId, projectId, root.id, rerender.id);
  if (existing) return { kind: "exists", exportJobId: existing.id };

  const project = await prisma.editorProject.findFirst({
    where: { id: projectId, userId },
    select: { activeJobId: true, pendingEditRevision: true },
  });
  if (!project || project.activeJobId !== rerender.id) return { kind: "superseded" };

  // 1. Rebase the draft onto the re-render. CAS; a concurrent hop that already rebased is a
  //    no-op here, so both converge on the same revision (and the same export key).
  const applied = new Set(
    (Array.isArray(rerenderInput.mcpAppliedDraftWindowEdits) ? rerenderInput.mcpAppliedDraftWindowEdits : [])
      .map((edit) => JSON.stringify(edit)),
  );
  let state: PendingEditState | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await loadPendingEditState(userId, root);
    if (!loaded.ok) {
      return writeRefusalMarker({
        userId, projectId, rootJobId: root.id, rerenderJobId: rerender.id,
        idempotencyKey: mcpExportKey(root.id, project.pendingEditRevision),
        code: loaded.code,
        message: REFUSAL_COPY[loaded.code] ?? GENERIC_ERROR_COPY,
      });
    }
    if (!loaded.state.stored || loaded.state.draft.baseJobId === rerender.id) {
      state = loaded.state;
      break;
    }
    const draft = {
      ...loaded.state.draft,
      baseJobId: rerender.id,
      windowEdits: loaded.state.draft.windowEdits.filter((edit) => !applied.has(JSON.stringify(edit))),
    };
    if (await savePendingEditDraft(userId, loaded.state.projectId, loaded.state.revision, draft)) {
      state = { ...loaded.state, revision: loaded.state.revision + 1, draft };
      break;
    }
  }
  if (!state) return { kind: "deferred", reason: "stale" };

  // 2. Export from the re-render at the rebased revision.
  const idempotencyKey = mcpExportKey(root.id, state.revision);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { kind: "not_applicable" };
  const rootInput = jobInput(root.inputJson) ?? {};
  const script = (state.base.preview.fullText?.trim()
    || (typeof rootInput.script === "string" ? rootInput.script.trim() : "")).slice(0, 20_000);

  // A concurrent trigger may have enqueued while this one rebased.
  const raced = await exportOfRerender(userId, projectId, root.id, rerender.id);
  if (raced) return { kind: "exists", exportJobId: raced.id };

  try {
    const result = await enqueueEditorExport({
      user,
      brandVisualAccess: await resolveBrandVisualAccess(user),
      sourceJobId: rerender.id,
      subtitleOverlayConfig: toBurnConfig(state.draft, state.base),
      editorSnapshot: toEditorSnapshotDraft(state.draft),
      idempotencyKey,
      ...(script ? { exportScript: script } : {}),
      exportSceneCount: state.draft.captions.length,
      rootJobId: root.id,
      // G12: clear the draft on success only when nothing is left pending in it — window
      // edits the agent added while the re-render ran stay for the next export_video.
      ...(state.draft.windowEdits.length === 0 ? { pendingEditRevision: state.revision } : {}),
      // The customer already ordered this export (export_video); the server finishes it.
      inflightCap: false,
      projectTransition: "while_in_flight",
    });
    if (!result.ok) {
      return writeRefusalMarker({
        userId, projectId, rootJobId: root.id, rerenderJobId: rerender.id, idempotencyKey,
        code: result.error, message: result.message ?? REFUSAL_COPY[result.error] ?? GENERIC_ERROR_COPY,
      });
    }
    return { kind: "enqueued", exportJobId: result.job.id };
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "P2002") {
      const row = await prisma.videoJob.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: { id: true },
      });
      if (row) return { kind: "exists", exportJobId: row.id };
    }
    if (code === "stale_export_source") return { kind: "superseded" };
    if (isRetryableMcpChainEnqueueError(error)) return { kind: "deferred", reason: "busy" };
    const refusalCode = code === "project_not_found" ? code : INTERNAL_JOB_FAILURE_CODE;
    if (refusalCode === INTERNAL_JOB_FAILURE_CODE) {
      // Class name only — an error message can carry script text or media paths.
      console.warn(`[mcp-chain] rerender export hop failed permanently for job ${rerender.id}: ${error instanceof Error ? error.name : typeof error}`);
    }
    return writeRefusalMarker({
      userId, projectId, rootJobId: root.id, rerenderJobId: rerender.id, idempotencyKey,
      code: refusalCode, message: REFUSAL_COPY[refusalCode] ?? GENERIC_ERROR_COPY,
    });
  }
}

/** Never throws: the hop must never fail the re-render that just finished. */
export async function continueMcpRerenderChainSafely(input: {
  userId: string;
  rerenderJobId: string;
}): Promise<McpRerenderHopResult | null> {
  try {
    return await continueMcpRerenderChain(input);
  } catch (error) {
    console.warn(
      `[mcp-chain] rerender export hop failed for job ${input.rerenderJobId} (${error instanceof Error ? error.name : "unknown"}); recovery will retry`,
    );
    return null;
  }
}

// ── watchdog recovery ─────────────────────────────────────────────────────────────────────

const RERENDER_RECOVERY_LOOKBACK_MS = 24 * 60 * 60_000;
const RERENDER_RECOVERY_SCAN_LIMIT = 1_000;
const RERENDER_RECOVERY_BATCH = 50;

/**
 * Lost-hop recovery for the worker's sweep: every recently finished MCP re-render that owes an
 * export and has none gets the same idempotent hop. Returns the re-render ids whose hop this
 * sweep closed (enqueued or refused-with-marker).
 */
export async function recoverLostMcpRerenderExports(now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - RERENDER_RECOVERY_LOOKBACK_MS);
  const candidates = await prisma.videoJob.findMany({
    where: {
      status: "done",
      type: "create",
      inputJson: { contains: "\"mcpExportAfterRerender\":true" },
      finishedAt: { gte: since },
    },
    orderBy: { finishedAt: "desc" },
    take: RERENDER_RECOVERY_SCAN_LIMIT,
    select: { id: true, userId: true, type: true, inputJson: true },
  });
  const rerenders = candidates.filter(isMcpExportAfterRerender);
  if (rerenders.length === 0) return [];

  const exports = await prisma.videoJob.findMany({
    where: {
      type: "export",
      createdAt: { gte: since },
      inputJson: { contains: "\"mcpRootJobId\":" },
    },
    select: { userId: true, inputJson: true },
  });
  const covered = new Set(exports.map((row) => `${row.userId}\n${String(jobInput(row.inputJson)?.sourceJobId ?? "")}`));
  const missing = rerenders
    .filter((rerender) => !covered.has(`${rerender.userId}\n${rerender.id}`))
    .slice(0, RERENDER_RECOVERY_BATCH);

  const recovered: string[] = [];
  for (const rerender of missing) {
    const result = await continueMcpRerenderChainSafely({ userId: rerender.userId, rerenderJobId: rerender.id });
    if (result?.kind === "enqueued" || result?.kind === "refused") recovered.push(rerender.id);
  }
  return recovered;
}
