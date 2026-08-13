import type { PreviewBatch, PreviewItem } from "./types";

/** Shared request/recovery seam for Brand Look Preview.
 * Lifted verbatim out of the old single-file /brands page: a preview or reroll
 * that already reserved allowance must never be charged twice, so every entry
 * point resolves through the caller-supplied requestId. */

export async function responseJson(response: Response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error || "ดำเนินการไม่สำเร็จ");
  return value;
}

export const TERMINAL_PREVIEW_STATUSES = new Set(["completed", "partial", "failed"]);

export class DefinitivePreviewRequestError extends Error {}

export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

async function previewRequestError(response: Response): Promise<never> {
  const value = await response.json().catch(() => ({}));
  throw new DefinitivePreviewRequestError(value.message || value.error || "ดำเนินการไม่สำเร็จ");
}

async function responseIsDefinitiveFailure(response: Response): Promise<boolean> {
  if (response.status < 500) return true;
  const value = await response.clone().json().catch(() => null) as { definitive?: unknown } | null;
  return value?.definitive === true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function recoverPreviewByRequestId(
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch }> {
  const discoveryDeadline = Date.now() + 30_000;
  let batch: PreviewBatch | null = null;
  while (!batch && Date.now() < discoveryDeadline) {
    const response = await fetch(
      `/api/brand-library/preview-batches?requestId=${encodeURIComponent(requestId)}`,
      { cache: "no-store" },
    );
    if (response.ok) batch = (await responseJson(response)).batch as PreviewBatch;
    else if (response.status !== 404) await responseJson(response);
    if (!batch) await delay(750);
  }
  if (!batch) {
    throw new DefinitivePreviewRequestError(
      "ไม่พบงานทดลองภาพจากคำขอเดิม ระบบไม่ได้หักเครดิต กรุณากดทดลอง 3 ภาพอีกครั้ง",
    );
  }
  onProgress(batch);

  if (!TERMINAL_PREVIEW_STATUSES.has(batch.status)) {
    const resumeController = new AbortController();
    const resumeTimeout = window.setTimeout(() => resumeController.abort(), 12_000);
    try {
      const response = await fetch("/api/brand-library/preview-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
        signal: resumeController.signal,
      });
      if (response.ok) {
        batch = (await responseJson(response)).batch as PreviewBatch;
        onProgress(batch);
      } else if (response.status !== 404 && response.status < 500) {
        await responseJson(response);
      }
    } catch (error) {
      if (!(resumeController.signal.aborted || error instanceof TypeError)) throw error;
    } finally {
      window.clearTimeout(resumeTimeout);
    }
  }

  const completionDeadline = Date.now() + 15 * 60_000;
  while (!TERMINAL_PREVIEW_STATUSES.has(batch.status) && Date.now() < completionDeadline) {
    await delay(2_000);
    const response = await fetch(
      `/api/brand-library/preview-batches/${encodeURIComponent(batch.id)}`,
      { cache: "no-store" },
    );
    batch = (await responseJson(response)).batch as PreviewBatch;
    onProgress(batch);
  }
  if (!TERMINAL_PREVIEW_STATUSES.has(batch.status)) {
    throw new Error("งานทดลองภาพยังดำเนินอยู่ สามารถกลับมาดูผลจากคำขอเดิมได้โดยไม่หักสิทธิ์ซ้ำ");
  }
  return { batch };
}

export async function postPreviewWithRecovery(
  endpoint: string,
  body: Record<string, unknown>,
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, requestId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (await responseIsDefinitiveFailure(response)) {
        return await previewRequestError(response);
      }
      if (response.status >= 500) {
        return recoverPreviewByRequestId(requestId, onProgress);
      }
    }
    const value = await responseJson(response) as { batch: PreviewBatch };
    if (TERMINAL_PREVIEW_STATUSES.has(value.batch.status)) return value;
    onProgress(value.batch);
  } catch (error) {
    if (!(controller.signal.aborted || error instanceof TypeError)) throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  return recoverPreviewByRequestId(requestId, onProgress);
}

async function recoverRerollByRequestId(
  itemId: string,
  batchId: string,
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch; item: PreviewItem }> {
  const discoveryDeadline = Date.now() + 30_000;
  let item: PreviewItem | null = null;
  while (!item && Date.now() < discoveryDeadline) {
    const response = await fetch(
      `/api/brand-library/preview-items/${encodeURIComponent(itemId)}/reroll?requestId=${encodeURIComponent(requestId)}`,
      { cache: "no-store" },
    );
    if (response.ok) item = (await responseJson(response)).item as PreviewItem;
    else if (response.status !== 404) await responseJson(response);
    if (!item) await delay(750);
  }
  if (!item) {
    throw new DefinitivePreviewRequestError(
      "ไม่พบงานลองภาพใหม่จากคำขอเดิม ระบบไม่ได้หักเครดิตและภาพเดิมยังอยู่ กรุณากดลองใหม่",
    );
  }

  const completionDeadline = Date.now() + 15 * 60_000;
  let batch = (await responseJson(await fetch(
    `/api/brand-library/preview-batches/${encodeURIComponent(batchId)}`,
    { cache: "no-store" },
  ))).batch as PreviewBatch;
  onProgress(batch);
  while (!TERMINAL_PREVIEW_STATUSES.has(batch.status) && Date.now() < completionDeadline) {
    await delay(2_000);
    batch = (await responseJson(await fetch(
      `/api/brand-library/preview-batches/${encodeURIComponent(batchId)}`,
      { cache: "no-store" },
    ))).batch as PreviewBatch;
    onProgress(batch);
  }
  if (!TERMINAL_PREVIEW_STATUSES.has(batch.status)) {
    throw new Error("งานลองภาพใหม่ยังดำเนินอยู่ ระบบจะกลับมาติดตาม request เดิมโดยไม่หักซ้ำ");
  }
  return { batch, item: batch.items.find((candidate) => candidate.id === itemId) ?? item };
}

export async function postRerollWithRecovery(
  itemId: string,
  batchId: string,
  requestId: string,
  onProgress: (batch: PreviewBatch) => void,
): Promise<{ batch: PreviewBatch; item: PreviewItem }> {
  const endpoint = `/api/brand-library/preview-items/${encodeURIComponent(itemId)}/reroll`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (await responseIsDefinitiveFailure(response)) {
        return await previewRequestError(response);
      }
      if (response.status >= 500) return recoverRerollByRequestId(itemId, batchId, requestId, onProgress);
    }
    const value = await responseJson(response) as { item: PreviewItem };
    const batch = (await responseJson(await fetch(
      `/api/brand-library/preview-batches/${encodeURIComponent(batchId)}`,
      { cache: "no-store" },
    ))).batch as PreviewBatch;
    onProgress(batch);
    if (TERMINAL_PREVIEW_STATUSES.has(batch.status)) return { batch, item: value.item };
  } catch (error) {
    if (!(controller.signal.aborted || error instanceof TypeError)) throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  return recoverRerollByRequestId(itemId, batchId, requestId, onProgress);
}
