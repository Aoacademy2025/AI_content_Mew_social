import type { PipelineCaller } from "@/lib/mcp/pipeline-client";
import { GEMINI_VOICES } from "@/lib/gemini-voices";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : "failed" }; }
}

export async function getVideoOptions(
  caller: PipelineCaller,
  user: {
    heygenKey: string | null;
    elevenlabsKey: string | null;
    heygenAvatarId: string | null;
    geminiVoiceName: string | null;
    elevenlabsVoiceId: string | null;
  },
) {
  const music = await safe(async () => {
    const r = await caller.get<{ tracks: { id: string; title: string; filename: string }[] }>("/api/music");
    return (r.tracks ?? []).map((t) => ({ id: t.id, title: t.title, bgmFile: `/music/${t.filename}` }));
  });

  const avatars = user.heygenKey
    ? await safe(async () => {
        const r = await caller.get<{ avatars: { avatar_id: string; avatar_name: string; preview_image_url?: string }[] }>("/api/heygen/avatars");
        return (r.avatars ?? []).map((a) => ({ avatarId: a.avatar_id, name: a.avatar_name, preview: a.preview_image_url ?? null }));
      })
    : { needsKey: true };

  const elevenlabs = user.elevenlabsKey
    ? await safe(async () => {
        const r = await caller.get<{ voices: { voice_id: string; name: string }[] }>("/api/elevenlabs/voices");
        return (r.voices ?? []).map((v) => ({ voiceId: v.voice_id, name: v.name }));
      })
    : { needsKey: true };

  return {
    music,
    avatars,
    savedAvatarId: user.heygenAvatarId ?? null,
    avatarModes: ["none", "full", "bookend", "bookend-both"] as const,
    voices: {
      gemini: GEMINI_VOICES,
      elevenlabs,
      savedGemini: user.geminiVoiceName ?? "Aoede",
      savedElevenlabs: user.elevenlabsVoiceId ?? null,
    },
    subtitleModes: ["sentence", "1", "2", "3", "4"] as const,
    subtitlePositions: ["top", "middle", "bottom"] as const,
  };
}
