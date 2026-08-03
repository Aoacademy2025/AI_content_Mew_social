// kie.ai API machinery (createTask/recordInfo polling + text-to-image model
// registry) — extracted verbatim from `src/app/api/videos/fetch-stock/route.ts`
// (Task 5, 2026-07-07). Route files can't export non-handler symbols, so this
// shared plumbing lives here for reuse by fetch-stock and Phase 2's new routes.

const KIE_API_BASE = "https://api.kie.ai/api/v1";
const KIE_POLL_INTERVAL_MS = 4_000;
const KIE_POLL_TIMEOUT_MS = 180_000;

interface KieCreateTaskResponse {
  code: number;
  msg?: string;
  data?: { taskId?: string };
}

interface KieRecordInfoResponse {
  code: number;
  msg?: string;
  data?: {
    taskId: string;
    state: "waiting" | "queuing" | "generating" | "success" | "fail";
    resultJson?: string;
    failMsg?: string;
    costTime?: number;
    creditsConsumed?: number;
  };
}

export type KieTaskSnapshot = {
  state: "waiting" | "queuing" | "generating" | "success" | "fail";
  resultUrl?: string;
  failMessage?: string;
  executionTimeMs?: number;
  creditsConsumed?: number;
};

/** Provider credential failures need operational action, not an endless customer retry loop. */
export function isKieAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unauthori[sz]ed|authentication failed|invalid (?:api )?key|status 401/iu.test(message);
}

export type KieCreditResponseResult =
  | { ok: true; credits?: number }
  | { ok: false; reason: "auth" | "provider"; providerCode: number | null };

/** kie.ai may return HTTP 200 with an auth failure in its JSON `code`; inspect both layers. */
export function interpretKieCreditResponse(
  httpStatus: number,
  body: unknown,
): KieCreditResponseResult {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const rawCode = record?.code;
  const providerCode = typeof rawCode === "number" && Number.isFinite(rawCode)
    ? rawCode
    : typeof rawCode === "string" && rawCode.trim() && Number.isFinite(Number(rawCode))
      ? Number(rawCode)
      : null;
  if (httpStatus === 401 || httpStatus === 403 || providerCode === 401 || providerCode === 403) {
    return { ok: false, reason: "auth", providerCode };
  }
  if (httpStatus >= 200 && httpStatus < 300 && providerCode === 200) {
    const credits = record && typeof record.data === "number" && Number.isFinite(record.data)
      ? record.data
      : undefined;
    return { ok: true, ...(credits !== undefined ? { credits } : {}) };
  }
  return { ok: false, reason: "provider", providerCode };
}

// อ่าน body เป็น text ก่อนเสมอ — kie.ai อาจตอบ body ว่างหรือ non-JSON เวลา error
// (เช่น 401/500 บางกรณี) ซึ่งทำให้ res.json() throw "Unexpected end of JSON input"
async function parseKieResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`kie.ai returned non-JSON response (status ${res.status}): ${text.slice(0, 300) || "(empty body)"}`);
  }
  if (!res.ok) throw new Error(`kie.ai request failed (status ${res.status}): ${text.slice(0, 300)}`);
  return data;
}

export async function kieCreateTask(model: string, input: Record<string, unknown>, token: string): Promise<string> {
  const res = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await parseKieResponse<KieCreateTaskResponse>(res);
  const taskId = data.data?.taskId;
  if (data.code !== 200 || !taskId) throw new Error(`kie.ai createTask error: ${data.msg ?? data.code}`);
  return taskId;
}

/** Fetch one durable task snapshot. Customer-facing job polling must never hold
 * a request open for the full provider timeout, so AI Studio uses this one-shot
 * form while older batch call sites may continue using kiePollResult. */
export async function kieGetTask(taskId: string, token: string): Promise<KieTaskSnapshot> {
  const res = await fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const response = await parseKieResponse<KieRecordInfoResponse>(res);
  const data = response.data;
  if (!data?.state) throw new Error(`kie.ai task ${taskId} returned no state`);

  let resultUrl: string | undefined;
  if (data.state === "success") {
    try {
      const parsed = data.resultJson ? JSON.parse(data.resultJson) as { resultUrls?: unknown } : {};
      const first = Array.isArray(parsed.resultUrls) ? parsed.resultUrls[0] : undefined;
      if (typeof first === "string" && first.trim()) resultUrl = first;
    } catch {
      throw new Error(`kie.ai task ${taskId} returned invalid resultJson`);
    }
    if (!resultUrl) throw new Error(`kie.ai task ${taskId} succeeded but has no resultUrls`);
  }

  return {
    state: data.state,
    resultUrl,
    failMessage: data.failMsg,
    executionTimeMs: Number.isFinite(data.costTime) ? Math.max(0, Math.round(data.costTime!)) : undefined,
    creditsConsumed: Number.isFinite(data.creditsConsumed) ? Math.max(0, Number(data.creditsConsumed)) : undefined,
  };
}

// Poll /jobs/recordInfo until state is success/fail, returns resultUrls[0]
export async function kiePollResult(taskId: string, token: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < KIE_POLL_TIMEOUT_MS) {
    const snapshot = await kieGetTask(taskId, token);
    if (snapshot.state === "success") return snapshot.resultUrl!;
    if (snapshot.state === "fail") throw new Error(`kie.ai task ${taskId} failed: ${snapshot.failMessage ?? "unknown error"}`);
    await new Promise((r) => setTimeout(r, KIE_POLL_INTERVAL_MS));
  }
  throw new Error(`kie.ai task ${taskId} timed out after ${KIE_POLL_TIMEOUT_MS}ms`);
}

// โมเดล text-to-image ที่เลือกได้จาก dropdown — ขนาดภาพ fix ที่ 9:16 เสมอ
export const KIE_IMAGE_MODELS = [
  "nano-banana-pro",
  "nano-banana-2",
  "gpt-image-2-text-to-image",
  "seedream/5-lite-text-to-image",
  "seedream/4.5-text-to-image",
  "flux-2/pro-text-to-image",
  "grok-imagine/text-to-image",
  "qwen2/text-to-image",
] as const;
export type KieImageModel = (typeof KIE_IMAGE_MODELS)[number];
export const DEFAULT_KIE_IMAGE_MODEL: KieImageModel = "gpt-image-2-text-to-image";

export function isKieImageModel(value: unknown): value is KieImageModel {
  return typeof value === "string" && (KIE_IMAGE_MODELS as readonly string[]).includes(value);
}

// แต่ละโมเดลรับ input shape ต่างกันเล็กน้อย — รวม prompt + aspect ratio (fix 9:16)
export function buildKieImageInput(model: KieImageModel, prompt: string): Record<string, unknown> {
  switch (model) {
    case "gpt-image-2-text-to-image":
      return { prompt, aspect_ratio: "9:16" };
    case "seedream/5-lite-text-to-image":
    case "seedream/4.5-text-to-image":
      return { prompt, aspect_ratio: "9:16", quality: "basic" };
    case "flux-2/pro-text-to-image":
      return { prompt, aspect_ratio: "9:16", resolution: "1K" };
    case "grok-imagine/text-to-image":
      return { prompt, aspect_ratio: "9:16" };
    case "qwen2/text-to-image":
      return { prompt, image_size: "9:16", output_format: "png" };
    case "nano-banana-pro":
    case "nano-banana-2":
    default:
      return { prompt, image_input: [], aspect_ratio: "9:16", resolution: "1K", output_format: "png" };
  }
}
