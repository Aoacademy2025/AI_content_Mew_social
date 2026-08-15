import type { PipelineCaller } from "@/lib/mcp/pipeline-client";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { moodBuckets, moodMenu, type BgmTrack } from "@/lib/mcp/bgm-resolve";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : "failed" }; }
}

const MCP_AVATAR_OPTION_LIMIT = 24;

type McpAvatarOption = {
  avatarId: string;
  name: string;
  preview: string | null;
  isPublic: boolean;
  saved: boolean;
};

function compactAvatarCatalog(
  avatars: Omit<McpAvatarOption, "saved">[],
  savedAvatarId: string | null,
  limit: number = MCP_AVATAR_OPTION_LIMIT,
) {
  const unique = [...new Map(avatars.map((avatar) => [avatar.avatarId, avatar])).values()];
  const saved = savedAvatarId ? unique.find((avatar) => avatar.avatarId === savedAvatarId) : undefined;
  // HeyGen's own-avatar group endpoint can omit a still-generation-ready saved
  // default (notably some Instant Avatar variants). Keep that known-good ID in
  // the MCP menu even when provider metadata/preview is unavailable.
  const savedOption = saved ?? (savedAvatarId ? {
    avatarId: savedAvatarId,
    name: "Saved avatar (default)",
    preview: null,
    isPublic: false,
  } : undefined);
  const privateAvatars = unique.filter((avatar) => !avatar.isPublic && avatar.avatarId !== savedAvatarId);
  const publicAvatars = unique.filter((avatar) => avatar.isPublic && avatar.avatarId !== savedAvatarId);
  const options = [
    ...(savedOption ? [{ ...savedOption, saved: true }] : []),
    ...privateAvatars.map((avatar) => ({ ...avatar, saved: false })),
    ...publicAvatars.map((avatar) => ({ ...avatar, saved: false })),
  ].slice(0, limit);

  return {
    options,
    meta: {
      totalAvailable: unique.length + (savedAvatarId && !saved ? 1 : 0),
      returned: options.length,
      truncated: unique.length + (savedAvatarId && !saved ? 1 : 0) > options.length,
      selection: "saved avatar first, then the user's own avatars",
    },
  };
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
  // Fetch the (slow, external) sources concurrently so the wizard isn't blocked ~30s+ serially.
  const [music, avatars, elevenlabs] = await Promise.all([
    safe(async () => {
      const r = await caller.get<{
        tracks: { id: string; title: string; filename: string }[];
        userTracks?: { id: string; title: string; filename: string }[];
      }>("/api/music");
      const allTracks: BgmTrack[] = [
        ...(r.tracks ?? []).map((t) => ({ title: t.title, bgmFile: `/music/${t.filename}` })),
        ...(r.userTracks ?? []).map((t) => ({ title: t.title, bgmFile: `/api/music/${t.filename}` })),
      ];
      // Present music as MOODS, not filenames — in chat the user can't see a dropdown.
      // Ask them a vibe, then pass it (mood word / title / path) as bgmFile; the server
      // resolves it (see bgm-resolve.ts). create_video_job also accepts a mood word directly.
      return {
        byMood: moodBuckets(allTracks),
        howToChoose: `ถาม user ว่าอยากได้เพลงแนวไหน (${moodMenu()}) แล้วส่งเป็น bgmFile ตอน create_video_job — ส่งชื่อแนว ("ชิล"/"ดราม่า"), ชื่อเพลง, หรือ path ก็ได้ ระบบ resolve ให้. ไม่อยากได้เพลงก็ไม่ต้องส่ง bgmFile`,
      };
    }),
    user.heygenKey
      ? safe(async () => {
          // The full /api/heygen/avatars endpoint includes HeyGen's entire public
          // catalog (~1,000+ rows and tens of seconds on real accounts). MCP only
          // needs the user's generation-ready looks, which is also what editor v2
          // uses. The compaction below remains a fail-safe for unusually large own
          // catalogs and duplicate provider rows.
          const r = await caller.get<{ avatars: { avatar_id: string; avatar_name: string; preview_image_url?: string; is_public?: boolean }[] }>("/api/heygen/my-avatars");
          return (r.avatars ?? []).map((a) => ({
            avatarId: a.avatar_id,
            name: a.avatar_name,
            preview: a.preview_image_url ?? null,
            isPublic: a.is_public === true,
          }));
        })
      : Promise.resolve({ needsKey: true }),
    user.elevenlabsKey
      ? (async () => {
          try {
            const r = await caller.get<{ voices: { voice_id: string; name: string }[] }>("/api/elevenlabs/voices");
            return (r.voices ?? []).map((v) => ({ voiceId: v.voice_id, name: v.name }));
          } catch (e) {
            // A voices-list failure (e.g. a TTS-only ElevenLabs key returns 401 on /v1/voices)
            // does NOT mean the key is broken — TTS with the saved/given voiceId may still work.
            return { error: e instanceof Error ? e.message : "failed", note: "ดึงรายชื่อเสียง ElevenLabs ไม่ได้ (key อาจมีสิทธิ์แค่ TTS ไม่มีสิทธิ์ list) — voiceId ที่เซฟไว้/ผู้ใช้ใส่เองยังใช้สร้างเสียงได้" };
          }
        })()
      : Promise.resolve({ needsKey: true }),
  ]);

  const compactAvatars = Array.isArray(avatars)
    ? compactAvatarCatalog(avatars, user.heygenAvatarId)
    : null;

  return {
    music,
    avatars: compactAvatars?.options ?? avatars,
    avatarsMeta: compactAvatars?.meta ?? {
      totalAvailable: null,
      returned: 0,
      truncated: false,
      selection: "avatar catalog unavailable",
    },
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
