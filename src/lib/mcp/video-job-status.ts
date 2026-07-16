export const VIDEO_JOB_INFLIGHT_STATUSES = ["queued", "processing", "waiting_provider"] as const;

export function toPublicVideoJobStatus(status: string): string {
  return status === "waiting_provider" ? "processing" : status;
}
