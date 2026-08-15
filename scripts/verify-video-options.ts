//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-video-options.ts
import { getVideoOptions } from "../src/lib/mcp/video-options";
import type { PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

type MockAvatar = {
  avatar_id: string;
  avatar_name: string;
  preview_image_url?: string;
  is_public?: boolean;
};

function mock(opts: { failVoices?: boolean; avatars?: MockAvatar[]; requestedPaths?: string[] } = {}): PipelineCaller {
  return {
    async get<T>(path: string): Promise<T> {
      opts.requestedPaths?.push(path);
      if (path === "/api/music") {
        return {
          tracks: [{ id: "m1", title: "Lofi-RnB-Laid Back", filename: "chill.mp3" }],
          userTracks: [{ id: "um1", title: "Cinematic-Dramatic Custom", filename: "user-1.wav" }],
        } as T;
      }
      if (path === "/api/heygen/my-avatars") return { avatars: opts.avatars ?? [{ avatar_id: "av1", avatar_name: "Host", preview_image_url: "p.jpg" }] } as T;
      if (path === "/api/elevenlabs/voices") {
        if (opts.failVoices) throw new Error("GET /api/elevenlabs/voices → 500: boom");
        return { voices: [{ voice_id: "v1", name: "Rachel" }] } as T;
      }
      throw new Error("unexpected " + path);
    },
    post: async () => ({} as any),
    patch: async () => ({} as any),
  };
}

async function main() {
  const u = { heygenKey: "k", elevenlabsKey: "k", heygenAvatarId: "av1", geminiVoiceName: "Aoede", elevenlabsVoiceId: "v1" };
  const requestedPaths: string[] = [];
  const o = await getVideoOptions(mock({ requestedPaths }), u);
  const moodTracks = "byMood" in o.music
    ? o.music.byMood.flatMap((bucket) => bucket.tracks)
    : [];
  assert(moodTracks.some((m) => m.bgmFile === "/music/chill.mp3" && m.title === "Lofi-RnB-Laid Back"), "music mapped to bgmFile path");
  assert(moodTracks.some((m) => m.bgmFile === "/api/music/user-1.wav" && m.title === "Cinematic-Dramatic Custom"), "user uploaded music mapped to api music bgmFile path");
  assert(Array.isArray(o.avatars) && (o.avatars as any[])[0].avatarId === "av1", "avatars mapped");
  assert(requestedPaths.includes("/api/heygen/my-avatars") && !requestedPaths.includes("/api/heygen/avatars"), "MCP uses the fast own-avatar catalog, not the huge public catalog");
  assert(o.savedAvatarId === "av1", "saved avatar id surfaced");
  assert(Array.isArray(o.voices.gemini) && o.voices.gemini.length > 0, "gemini voices present (static)");
  assert(Array.isArray(o.voices.elevenlabs) && (o.voices.elevenlabs as any[])[0].voiceId === "v1", "elevenlabs voices mapped");
  assert(JSON.stringify(o.avatarModes) === JSON.stringify(["none", "full", "bookend", "bookend-both"]), "avatarModes enum");

  // no-key user → needsKey, not a crash
  const o2 = await getVideoOptions(mock(), { heygenKey: null, elevenlabsKey: null, heygenAvatarId: null, geminiVoiceName: null, elevenlabsVoiceId: null });
  assert((o2.avatars as any).needsKey === true && (o2.voices.elevenlabs as any).needsKey === true, "no key → needsKey (not crash)");

  // section failure degrades gracefully
  const o3 = await getVideoOptions(mock({ failVoices: true }), u);
  assert((o3.voices.elevenlabs as any).error && (o3.voices.elevenlabs as any).note?.includes("voiceId"), "failing voices → {error,note} (saved voiceId still usable), whole tool still returns");

  // A real HeyGen account can expose thousands of public avatars and duplicate custom
  // avatars. MCP tool results must stay small enough for Claude Code/Codex to consume.
  const manyAvatars: MockAvatar[] = [
    ...Array.from({ length: 10 }, (_, i) => ({
      avatar_id: `custom-${i}`,
      avatar_name: `Custom ${i}`,
      preview_image_url: `custom-${i}.webp`,
      is_public: false,
    })),
    { avatar_id: "custom-3", avatar_name: "Custom 3 duplicate", is_public: false },
    ...Array.from({ length: 250 }, (_, i) => ({
      avatar_id: `public-${i}`,
      avatar_name: `Public ${i}`,
      preview_image_url: `public-${i}.webp`,
      is_public: true,
    })),
  ];
  const compact = await getVideoOptions(mock({ avatars: manyAvatars }), {
    ...u,
    heygenAvatarId: "public-249",
  });
  const compactAvatars = compact.avatars as Array<{ avatarId: string; isPublic?: boolean; saved?: boolean }>;
  assert(compactAvatars.length <= 24, "large HeyGen catalog is bounded for MCP context");
  assert(compactAvatars[0]?.avatarId === "public-249" && compactAvatars[0]?.saved === true, "saved avatar is first even when it is late in the provider catalog");
  assert(new Set(compactAvatars.map((avatar) => avatar.avatarId)).size === compactAvatars.length, "duplicate avatar ids are removed");
  assert(compactAvatars.filter((avatar) => !avatar.isPublic).length === 10, "all custom avatars are preferred before public examples");
  assert(compact.avatarsMeta.totalAvailable === 260 && compact.avatarsMeta.truncated === true, "avatar catalog metadata reports unique total and truncation");
  assert(JSON.stringify(compact).length < 20_000, "get_video_options result stays comfortably below MCP client limits");

  const missingSaved = await getVideoOptions(mock({ avatars: manyAvatars }), {
    ...u,
    heygenAvatarId: "saved-not-returned-by-own-catalog",
  });
  const missingSavedAvatars = missingSaved.avatars as Array<{ avatarId: string; saved?: boolean; preview?: string | null }>;
  assert(
    missingSavedAvatars[0]?.avatarId === "saved-not-returned-by-own-catalog"
      && missingSavedAvatars[0]?.saved === true
      && missingSavedAvatars[0]?.preview === null,
    "saved default remains the first selectable option when the provider own-avatar endpoint omits it",
  );
  assert(missingSaved.avatarsMeta.totalAvailable === 261, "saved fallback is included in catalog totals");

  console.log(`\n${passed} assertions passed ✅`);
}

main().catch((e) => { console.error(e); process.exit(1); });
