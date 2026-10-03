// `waiting_import` (T14, A10): a create job whose presenter clip is still being imported by the
// Media Import lane. It is in flight (counts toward the per-user cap, can be canceled, keeps the
// deploy drain waiting while its import can still finish — PR-B fix round 1, SEC-A5) but the
// worker never claims it — claimNextRunnableJob only takes `queued` and due `waiting_provider`
// rows — so it holds no render slot until the import is ready and settleClipImportJob moves it
// to `queued`.
export const VIDEO_JOB_INFLIGHT_STATUSES = ["queued", "processing", "waiting_provider", "waiting_import"] as const;

export function toPublicVideoJobStatus(status: string): string {
  if (status === "waiting_provider") return "processing";
  if (status === "waiting_import") return "queued";
  return status;
}

/**
 * The presenter MediaImport id a `waiting_import` clip job carries (`input.clipImportId`, written
 * only by the server). Pure, so the cancel core and the deploy drain read it without importing
 * the clip-job module.
 */
export function clipImportIdOf(inputJson: string | null | undefined): string | null {
  if (typeof inputJson !== "string" || !inputJson.includes("clipImportId")) return null;
  try {
    const value = (JSON.parse(inputJson) as { clipImportId?: unknown } | null)?.clipImportId;
    return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}
