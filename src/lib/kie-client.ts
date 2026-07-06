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
  };
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
  });
  const data = await parseKieResponse<KieCreateTaskResponse>(res);
  const taskId = data.data?.taskId;
  if (data.code !== 200 || !taskId) throw new Error(`kie.ai createTask error: ${data.msg ?? data.code}`);
  return taskId;
}

// Poll /jobs/recordInfo until state is success/fail, returns resultUrls[0]
export async function kiePollResult(taskId: string, token: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < KIE_POLL_TIMEOUT_MS) {
    const res = await fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await parseKieResponse<KieRecordInfoResponse>(res);
    const state = data.data?.state;
    if (state === "success") {
      const resultJson = data.data?.resultJson ? JSON.parse(data.data.resultJson) : {};
      const url = resultJson.resultUrls?.[0];
      if (!url) throw new Error(`kie.ai task ${taskId} succeeded but has no resultUrls`);
      return url;
    }
    if (state === "fail") throw new Error(`kie.ai task ${taskId} failed: ${data.data?.failMsg ?? "unknown error"}`);
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
