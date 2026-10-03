// `waiting_import` (T14, A10): a create job whose presenter clip is still being imported by the
// Media Import lane. It is in flight (counts toward the per-user cap, can be canceled, keeps the
// deploy drain waiting) but the worker never claims it — claimNextRunnableJob only takes
// `queued` and due `waiting_provider` rows — so it holds no render slot until the import is
// ready and settleClipImportJob moves it to `queued`.
export const VIDEO_JOB_INFLIGHT_STATUSES = ["queued", "processing", "waiting_provider", "waiting_import"] as const;

export function toPublicVideoJobStatus(status: string): string {
  if (status === "waiting_provider") return "processing";
  if (status === "waiting_import") return "queued";
  return status;
}
