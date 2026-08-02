import { authenticatedFetch } from "@/lib/authenticated-fetch";

export type VideoAccountDefaultsPatch = {
  heygenAvatarId?: string;
  elevenlabsVoiceId?: string;
  ttsProvider?: string;
  geminiVoiceName?: string;
};

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizePatch(patch: VideoAccountDefaultsPatch): VideoAccountDefaultsPatch {
  const normalized: VideoAccountDefaultsPatch = {};
  if (typeof patch.heygenAvatarId === "string") normalized.heygenAvatarId = patch.heygenAvatarId.trim();
  if (typeof patch.elevenlabsVoiceId === "string") normalized.elevenlabsVoiceId = patch.elevenlabsVoiceId.trim();
  if (typeof patch.ttsProvider === "string") normalized.ttsProvider = patch.ttsProvider.trim();
  if (typeof patch.geminiVoiceName === "string") normalized.geminiVoiceName = patch.geminiVoiceName.trim();
  return normalized;
}

export async function saveVideoAccountDefaults(
  patch: VideoAccountDefaultsPatch,
  fetcher: Fetcher = authenticatedFetch,
): Promise<Record<string, unknown> & { ok: true }> {
  const response = await fetcher("/api/user/video-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalizePatch(patch)),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || data?.ok !== true) {
    throw new Error("บันทึกค่าเริ่มต้นไม่สำเร็จ");
  }
  return data as Record<string, unknown> & { ok: true };
}
