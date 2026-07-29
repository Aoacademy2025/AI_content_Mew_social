import { fetchWithBudget } from "@/lib/fetch-budget";

export type ImageDownloadRetryOptions = {
  timeoutMs?: number;
  retries?: number;
  wallClockMs?: number;
};

export function fetchImageResponseWithRetry(
  url: string,
  options: ImageDownloadRetryOptions = {},
): Promise<Response> {
  return fetchWithBudget(
    url,
    {
      cache: "no-store",
      redirect: "error",
    },
    {
      provider: "runpod-image",
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: options.retries ?? 2,
      wallClockMs: options.wallClockMs ?? 100_000,
    },
  );
}
