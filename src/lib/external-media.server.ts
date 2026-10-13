import { prisma } from "./prisma";
import { externalMediaPlan, externalWindowStates, mediaWindows, isPresenterHookWindow, type ExternalWindowState } from "./external-media";
import { MAX_BROLL_WINDOW_EDITS, mergeWindowEdits, type WindowEdit } from "./broll-rerender";
import { parseVideoJobOutput } from "./mcp/video-job";
import { parsePendingEditDraft, type PendingEditDraft } from "./mcp/pending-edit-draft";
import { resolvePendingWindowMedia, type OwnedImportView } from "./pending-broll-media";

export async function ownedDraftImports(userId: string, draft: PendingEditDraft): Promise<Map<string, OwnedImportView>> {
  const ids = [...new Set(draft.windowEdits.flatMap(e => e.importId ? [e.importId] : []))];
  if (!ids.length) return new Map();
  const rows = await prisma.mediaImport.findMany({ where: { id: { in: ids }, userId, purpose: { in: ["broll_image", "broll_video"] } }, select: { id: true, status: true, errorCode: true, resultSrc: true, durationMs: true, purpose: true } });
  return new Map(rows.map(row => [row.id, row]));
}
/** Follow only server job lineage, never draftJson/overlay source flags or a caller's root ID. */
export async function externalMediaContext(userId: string, sourceJobId: string) {
  let id = sourceJobId;
  let projectId: string | null | undefined;
  const visited = new Set<string>();
  while (!visited.has(id)) {
    visited.add(id);
    const row = await prisma.videoJob.findFirst({ where: { id, userId } });
    if (!row || (projectId !== undefined && row.projectId !== projectId)) throw new Error("external_media_lineage_invalid");
    projectId = row.projectId;
    const quote = row.budgetQuoteId ? await prisma.mcpVideoQuote.findFirst({ where: { id: row.budgetQuoteId, userId }, select: { source: true, rootJobId: true } }) : null;
    // Quote-bound descendants resolve directly to their immutable root, even after
    // arbitrarily many free edit/export hops. A broken binding must never waive policy.
    if (quote?.source === "external") {
      const root = quote.rootJobId === row.id ? row : await prisma.videoJob.findFirst({ where: { id: quote.rootJobId ?? "", userId, projectId: row.projectId } });
      if (!root) throw new Error("external_media_lineage_invalid");
      return { root, preview: parseVideoJobOutput(root.outputJson)?.preview ?? null };
    }
    const input = JSON.parse(row.inputJson) as { sourceJobId?: string };
    if (!input.sourceJobId) return null;
    id = input.sourceJobId;
  }
  throw new Error("external_media_lineage_invalid");
}

export type ExternalMediaRefusal = { error: "external_media_required" | "window_locked_presenter_hook"; code: "external_media_required" | "window_locked_presenter_hook"; message: string; next: string; windowIndices: number[]; windows: ExternalWindowState[] };
export function requiredMediaFailure(windows: ExternalWindowState[]): ExternalMediaRefusal {
  const windowIndices = windows.filter(w => w.required && w.state !== "ready").map(w => w.index);
  return { error: "external_media_required", code: "external_media_required", message: `ต้องนำเข้าสื่อให้ครบก่อนส่งออก (ช่วง ${windowIndices.join(", ") || "ยังไม่มีแผนภาพ"})`, next: "เรียก get_edit_state แล้วใช้ replace_broll_window กับไฟล์/ลิงก์ของคุณในช่วงที่ระบุ รอ import พร้อม จากนั้น export_video อีกครั้ง หรืออัปเดต B-roll ในหน้า Editor ก่อนส่งออก", windowIndices, windows };
}
/** At MCP admission pending ready assets may satisfy slots; enqueue/burn require applied media. */
export async function validateExternalMediaExport(input: { userId: string; sourceJobId: string; draft?: PendingEditDraft; allowPending?: boolean; checkPending?: boolean }): Promise<ExternalMediaRefusal | null> {
  const context = await externalMediaContext(input.userId, input.sourceJobId);
  if (!context) return null; // Historical optional fill-yourself has no external quote policy.
  const rootConfig = context.preview?.config;
  const slots = externalMediaPlan(rootConfig)?.slots;
  if (!slots?.length || slots.length > MAX_BROLL_WINDOW_EDITS) return requiredMediaFailure([]);
  const source = await prisma.videoJob.findFirst({ where: { id: input.sourceJobId, userId: input.userId } });
  const preview = parseVideoJobOutput(source?.outputJson ?? null)?.preview;
  if (!preview) return requiredMediaFailure([]);
  let draft = input.draft;
  if (!draft && input.checkPending !== false && context.root.projectId) {
    const project = await prisma.editorProject.findFirst({ where: { id: context.root.projectId, userId: input.userId }, select: { pendingEditJson: true } });
    const stored = parsePendingEditDraft(project?.pendingEditJson ?? null);
    if (stored?.rootJobId === context.root.id) draft = stored;
  }
  const pending = draft ? resolvePendingWindowMedia(context.preview, draft.windowEdits, await ownedDraftImports(input.userId, draft)) : [];
  const edits = pending.flatMap(p => p.edit ? [p.edit] : []);
  const merged = mergeWindowEdits(mediaWindows(preview.config), edits);
  const effective = input.allowPending && !("error" in merged) ? { bgVideos: merged.bgVideos } : preview.config;
  const windows = externalWindowStates(rootConfig, effective);
  // A nonempty client-selected path is not proof of ownership/readiness. The same
  // MediaImport identity authorizes URL, upload-link and native web uploads.
  const effectiveWindows = mediaWindows(effective);
  const sources = windows.filter(w => w.required && w.state === "ready").map(w => String(effectiveWindows[w.index]?.src ?? ""));
  const owned = sources.length ? await prisma.mediaImport.findMany({ where: { userId: input.userId, resultSrc: { in: sources }, purpose: { in: ["broll_image", "broll_video"] }, status: "ready" }, select: { resultSrc: true } }) : [];
  const readySources = new Set(owned.map(row => row.resultSrc));
  for (const window of windows) {
    if (window.required && window.state === "ready" && !readySources.has(String(effectiveWindows[window.index]?.src))) {
      window.state = "failed"; window.importError = "import_missing";
    }
  }
  const current = mediaWindows(preview.config);
  for (const p of pending) {
    const w = windows.find(w => w.index === p.index);
    if (!w) continue;
    if (p.status !== "ready") { w.state = p.status; w.required = true; if (p.error) w.importError = p.error; }
    else if (!input.allowPending && p.edit && ((p.edit.src && p.edit.src !== current[p.index]?.src) || (p.edit.enabled !== undefined && p.edit.enabled !== (current[p.index]?.brollEnabled !== false)))) {
      w.state = "pending"; w.required = true;
    }
  }
  return windows.some(w => w.required && w.state !== "ready") || "error" in merged ? requiredMediaFailure(windows) : null;
}

/** External replacements must reference ready media owned by the editor, before rendering. */
export async function validateExternalWindowEdits(userId: string, sourceJobId: string, edits: WindowEdit[]): Promise<ExternalMediaRefusal | null> {
  const context = await externalMediaContext(userId, sourceJobId);
  if (!context) return null;
  const hook = context.preview && edits.find(e => (e.src || e.enabled === true)
    && isPresenterHookWindow(context.preview!, JSON.parse(context.root.inputJson).cutawayLayout, e.index));
  if (hook) return { error: "window_locked_presenter_hook", code: "window_locked_presenter_hook", message: "ช่วงเปิดคลิปเป็นคนพูด เลือกช่วง B-roll อื่น", next: "เรียก get_edit_state แล้วเลือกช่วง B-roll ที่ต้องใส่สื่อ", windowIndices: [hook.index], windows: [] };
  const sources = edits.flatMap(e => e.src ? [e.src] : []);
  const rows = sources.length ? await prisma.mediaImport.findMany({ where: { userId, status: "ready", purpose: { in: ["broll_image", "broll_video"] }, resultSrc: { in: sources } }, select: { resultSrc: true } }) : [];
  const owned = new Set(rows.map(r => r.resultSrc));
  const missing = edits.filter(e => e.src && !owned.has(e.src)).map(e => ({ index: e.index, required: true, owner: "broll" as const, state: "failed" as const, importError: "import_missing" }));
  return missing.length ? requiredMediaFailure(missing) : null;
}
