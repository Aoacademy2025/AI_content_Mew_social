import type { V2JobState } from "./useV2Job";

/** Convert a completed export result back into a native preview job without polling the
 * stale source output. Returns null for pre-snapshot rows so callers can use legacy resume. */
export function restorePostExportEditorState(
  current: V2JobState,
  fallbackSourceJobId: string | null,
): V2JobState | null {
  const snapshot = current.output?.editSnapshot;
  const sourceJobId = current.output?.sourceJobId ?? fallbackSourceJobId;
  if (!snapshot || !sourceJobId) return null;
  return {
    ...current,
    phase: "done",
    jobId: sourceJobId,
    jobType: "create",
    currentStep: null,
    progress: 100,
    queuePosition: null,
    errorMessage: null,
    errorCode: null,
    errorProvider: null,
    output: {
      version: 2,
      videoUrl: snapshot.videoUrl,
      preview: snapshot.preview,
      editSnapshot: snapshot,
    },
  };
}
