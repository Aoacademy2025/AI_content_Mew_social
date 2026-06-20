//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-video-options.ts
import { getVideoOptions } from "../src/lib/mcp/video-options";
import type { PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

function mock(opts: { failVoices?: boolean } = {}): PipelineCaller {
  return {
    async get<T>(path: string): Promise<T> {
      if (path === "/api/music") {
        return {
          tracks: [{ id: "m1", title: "Chill", filename: "chill.mp3" }],
          userTracks: [{ id: "um1", title: "My Beat", filename: "user-1.wav" }],
        } as T;
      }
      if (path === "/api/heygen/avatars") return { avatars: [{ avatar_id: "av1", avatar_name: "Host", preview_image_url: "p.jpg" }] } as T;
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
  const o = await getVideoOptions(mock(), u);
  assert(Array.isArray(o.music) && (o.music as any[])[0].bgmFile === "/music/chill.mp3" && (o.music as any[])[0].title === "Chill", "music mapped to bgmFile path");
  assert(Array.isArray(o.music) && (o.music as any[]).some((m) => m.bgmFile === "/api/music/user-1.wav" && m.source === "user"), "user uploaded music mapped to api music bgmFile path");
  assert(Array.isArray(o.avatars) && (o.avatars as any[])[0].avatarId === "av1", "avatars mapped");
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

  console.log(`\n${passed} assertions passed ✅`);
}

main().catch((e) => { console.error(e); process.exit(1); });
