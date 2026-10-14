import { externalMediaPlan, mediaWindows, previewWindowOwner } from "./external-media";
import type { WindowEdit } from "./broll-rerender";
import type { PendingEditWindowEdit } from "./mcp/pending-edit-draft";
import type { VideoJobPreviewData } from "./mcp/video-job";
export type OwnedImportView = { status: string; errorCode: string | null; resultSrc: string | null; durationMs: number | null; purpose: string | null };
export type PendingWindowMedia = { index: number; status: "ready" | "pending" | "failed"; error?: string; edit?: WindowEdit };
/** One owner-resolved projection used by both clients and final-export validation. */
export function resolvePendingWindowMedia(rootPreview: VideoJobPreviewData | null, edits: PendingEditWindowEdit[], imports: Map<string, OwnedImportView>): PendingWindowMedia[] {
  return edits.map(edit => {
    const style = { ...(edit.transition ? { transition: edit.transition } : {}), ...(edit.fit ? { fit: edit.fit } : {}) };
    if (edit.importId) {
      const row = imports.get(edit.importId);
      if (!row || !["broll_image", "broll_video"].includes(row.purpose ?? "") || row.status === "failed") return { index: edit.index, status: "failed", error: row?.errorCode ?? "import_missing" };
      if (row.status !== "ready") return { index: edit.index, status: "pending" };
      if (!row.resultSrc || !/^\/api\/stocks\/[\w.-]+\.mp4$/.test(row.resultSrc)) return { index: edit.index, status: "failed", error: "import_missing" };
      return { index: edit.index, status: "ready", edit: { index: edit.index, src: row.resultSrc, enabled: true, replacementKind: "upload", ...(row.purpose === "broll_image" ? { stillImage: true } : {}), ...(row.durationMs && row.durationMs > 0 ? { clipDuration: row.durationMs / 1000 } : {}), ...style } };
    }
    if (edit.replacementKind === "style") return { index: edit.index, status: "ready", edit: { index: edit.index, ...style } };
    const original = mediaWindows(rootPreview?.config)[edit.index];
    if (edit.replacementKind !== "original" || !rootPreview || !original) return { index: edit.index, status: "failed", error: "original_unavailable" };
    // Resetting an empty external original hides the slot; the immutable requirement remains.
    if ((!original.src && original.brollEnabled === false) || externalMediaPlan(rootPreview.config)?.slots[edit.index]?.required || previewWindowOwner(rootPreview, edit.index) === "presenter") return { index: edit.index, status: "ready", edit: { index: edit.index, enabled: false, ...style } };
    if (typeof original.src !== "string" || !original.src) return { index: edit.index, status: "failed", error: "original_unavailable" };
    return { index: edit.index, status: "ready", edit: { index: edit.index, src: original.src, enabled: true, ...(original.stillImage === true ? { stillImage: true } : {}), ...(typeof original.clipDuration === "number" ? { clipDuration: original.clipDuration } : {}), ...style } };
  });
}
