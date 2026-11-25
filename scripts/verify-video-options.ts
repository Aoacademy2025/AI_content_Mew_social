//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-video-options.ts
import { getVideoOptions, VIDEO_OPTIONS_FETCH_TIMEOUT_MS } from "../src/lib/mcp/video-options";
import type { PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

type MockAvatar = {
  avatar_id: string;
  avatar_name: string;
  preview_image_url?: string;
  is_public?: boolean;
  supported_api_engines?: Array<"avatar_iii" | "avatar_iv" | "avatar_v">;
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
      if (path === "/api/heygen/my-avatars") return { avatars: opts.avatars ?? [{ avatar_id: "av1", avatar_name: "Host", preview_image_url: "p.jpg", supported_api_engines: ["avatar_iii", "avatar_iv"] }] } as T;
      if (path === "/api/elevenlabs/voices") {
        if (opts.failVoices) throw new Error("GET /api/elevenlabs/voices → 500: boom");
        return { voices: [{ voice_id: "v1", name: "Rachel" }] } as T;
      }
      throw new Error("unexpected " + path);
    },
    post: async <T>() => ({} as T),
    patch: async <T>() => ({} as T),
  };
}

async function main() {
  const u = { heygenKey: "k", elevenlabsKey: "k", heygenAvatarId: "av1", geminiVoiceName: "Aoede", elevenlabsVoiceId: "v1" };
  const requestedPaths: string[] = [];
  const o = await getVideoOptions(mock({ requestedPaths }), u);
  assert(o.broll.options.map(item => item.value).join(",") === "stock,hero-ai-image,automix,external", "all four media source options");
  assert(o.broll.default === "stock", "omitted source remains stock compatibility default");
  assert(o.broll.next.includes("prepare_video_job") && o.broll.next.includes("create_video_job({quoteId})") && !o.broll.next.includes("ส่ง confirmationUrl ให้ผู้ใช้ยืนยัน"), "source selection routes to create without a browser round-trip (HERO-85)");
  assert(o.broll.unavailableTools.includes("ยังสร้างหรือค้นหาสื่อนี้ไม่ได้"), "unavailable external capabilities are disclosed");
  assert(o.broll.renderDisclosure.includes("นาทีเรนเดอร์") && o.broll.options[0].detail.includes("เครดิตส่วนเกิน"), "stock still discloses render usage");
  assert(o.broll.options[3].detail.includes("เครื่องมือภายนอกของคุณอาจมีค่าใช้จ่าย"), "external tools can have separate charges");
  const moodTracks = "byMood" in o.music
    ? o.music.byMood.flatMap((bucket) => bucket.tracks)
    : [];
  assert(moodTracks.some((m) => m.bgmFile === "/music/chill.mp3" && m.title === "Lofi-RnB-Laid Back"), "music mapped to bgmFile path");
  assert(moodTracks.some((m) => m.bgmFile === "/api/music/user-1.wav" && m.title === "Cinematic-Dramatic Custom"), "user uploaded music mapped to api music bgmFile path");
  assert(Array.isArray(o.avatars) && (o.avatars as { avatarId: string; supportedEngines: string[] }[])[0].avatarId === "av1", "avatars mapped");
  assert(requestedPaths.includes("/api/heygen/my-avatars") && !requestedPaths.includes("/api/heygen/avatars"), "MCP uses the fast own-avatar catalog, not the huge public catalog");
  assert(o.savedAvatarId === "av1", "saved avatar id surfaced");
  assert(Array.isArray(o.voices.gemini) && o.voices.gemini.length > 0, "gemini voices present (static)");
  assert(Array.isArray(o.voices.elevenlabs) && (o.voices.elevenlabs as { voiceId: string }[])[0].voiceId === "v1", "elevenlabs voices mapped");
  assert(JSON.stringify(o.avatarModes) === JSON.stringify(["none", "full", "bookend", "bookend-both"]), "avatarModes enum");
  assert((o.avatars as { avatarId: string; supportedEngines: string[] }[])[0].supportedEngines.join(",") === "avatar_iii,avatar_iv", "private look exposes supported engines");
  const unknownCapabilities = await getVideoOptions(mock({ avatars: [{ avatar_id: "unknown-capabilities", avatar_name: "Unknown" }] }), u);
  assert(!("supportedEngines" in (unknownCapabilities.avatars as object[])[0]), "MCP preserves unknown capability metadata instead of publishing a known-empty list");
  assert(o.avatarEngines.map((e) => e.value).join(",") === "avatar_iii,avatar_iv,avatar_v", "MCP exposes explicit engine choices");
  assert(o.avatarBilling.route === "BYOK" && o.avatarBilling.disclosure.includes("ไม่รวมอยู่ในเครดิต HERO"), "MCP discloses external HeyGen billing");

  // no-key user → needsKey, not a crash
  const o2 = await getVideoOptions(mock(), { heygenKey: null, elevenlabsKey: null, heygenAvatarId: null, geminiVoiceName: null, elevenlabsVoiceId: null });
  assert((o2.avatars as { needsKey?: boolean }).needsKey === true && (o2.voices.elevenlabs as { needsKey?: boolean }).needsKey === true, "no key → needsKey (not crash)");

  // section failure degrades gracefully
  const o3 = await getVideoOptions(mock({ failVoices: true }), u);
  assert(!!(o3.voices.elevenlabs as { error?: string; note?: string }).error && !! (o3.voices.elevenlabs as { error?: string; note?: string }).note?.includes("voiceId"), "failing voices → {error,note} (saved voiceId still usable), whole tool still returns");

  // Defensive filtering keeps public avatars out even if an upstream route regresses,
  // and duplicate private looks do not inflate MCP context.
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
  assert(!compactAvatars.some((avatar) => avatar.isPublic), "MCP excludes public avatars even if upstream returns them");
  assert(new Set(compactAvatars.map((avatar) => avatar.avatarId)).size === compactAvatars.length, "duplicate avatar ids are removed");
  assert(compactAvatars.length === 10, "all private custom avatars remain selectable");
  assert(compact.avatarsMeta.totalAvailable === 10 && compact.avatarsMeta.truncated === false, "avatar catalog metadata counts only private unique looks");
  assert(JSON.stringify(compact).length < 20_000, "get_video_options result stays comfortably below MCP client limits");

  const missingSaved = await getVideoOptions(mock({ avatars: manyAvatars }), {
    ...u,
    heygenAvatarId: "saved-not-returned-by-own-catalog",
  });
  const missingSavedAvatars = missingSaved.avatars as Array<{ avatarId: string; saved?: boolean; preview?: string | null }>;
  assert(!missingSavedAvatars.some((avatar) => avatar.avatarId === "saved-not-returned-by-own-catalog"), "unverified saved fallback is not exposed as a selectable private look");
  assert(missingSaved.avatarsMeta.totalAvailable === 10, "unverified saved fallback is excluded from catalog totals");

  // HERO-94 + Trending Style Packs: Styled Video Templates catalog + dynamic MANAGED_STOCK discovery
  assert(Array.isArray(o.templates) && o.templates.length === 13, "get_video_options exposes all 13 active Styled Video Templates");
  assert(
    o.templates.some((t) => t.id === "shop-review" && t.headlineHookStyle === "banner" && t.brollTransition === "cut")
      && o.templates.some((t) => t.id === "listicle-fast" && t.headlineHookStyle === "stat-burst" && t.statCards === true)
      && o.templates.some((t) => t.id === "ai-tech-doc" && t.headlineHookStyle === "stat-burst" && t.statCards === true)
      && o.templates.some((t) => t.id === "true-crime" && t.headlineHookStyle === "news" && t.musicMood === "ominous")
      && o.templates.some((t) => t.id === "self-growth" && t.headlineHookStyle === "viral" && t.musicMood === "epic")
      && typeof o.templatesHowToChoose === "string"
      && o.templatesHowToChoose.includes("templateId"),
    "templates expose full video-editing recipe metadata and Thai howToChoose",
  );

  const prevFlag = process.env.MANAGED_STOCK;
  const prevPexels = process.env.MANAGED_PEXELS_API_KEY;
  const prevPixabay = process.env.MANAGED_PIXABAY_API_KEY;
  try {
    process.env.MANAGED_STOCK = "0";
    delete process.env.MANAGED_PEXELS_API_KEY;
    delete process.env.MANAGED_PIXABAY_API_KEY;
    const offOpts = await getVideoOptions(mock(), u);
    const offStock = offOpts.broll.options.find((item) => item.value === "stock")!;
    const offAutomix = offOpts.broll.options.find((item) => item.value === "automix")!;
    assert(offOpts.broll.managedStock === false && offStock.needsStockKey === true && offAutomix.needsStockKey === true, "MANAGED_STOCK off → stock and automix require user stock key");
    assert(offAutomix.detail.includes("ต้องมีคีย์สต็อก"), "MANAGED_STOCK off → automix detail preserves legacy stock-key notice");

    process.env.MANAGED_STOCK = "1";
    process.env.MANAGED_PIXABAY_API_KEY = "team-pixabay-key";
    const onOpts = await getVideoOptions(mock(), u);
    const onStock = onOpts.broll.options.find((item) => item.value === "stock")!;
    const onAutomix = onOpts.broll.options.find((item) => item.value === "automix")!;
    assert(onOpts.broll.managedStock === true && onStock.needsStockKey === false && onAutomix.needsStockKey === false, "MANAGED_STOCK configured → stock and automix report needsStockKey: false");
    assert(onStock.detail.includes("คลังกลาง") && onAutomix.detail.includes("ไม่ต้องมีคีย์สต็อก"), "MANAGED_STOCK configured → detail copy states managed library needs no user stock key");
  } finally {
    if (prevFlag === undefined) delete process.env.MANAGED_STOCK; else process.env.MANAGED_STOCK = prevFlag;
    if (prevPexels === undefined) delete process.env.MANAGED_PEXELS_API_KEY; else process.env.MANAGED_PEXELS_API_KEY = prevPexels;
    if (prevPixabay === undefined) delete process.env.MANAGED_PIXABAY_API_KEY; else process.env.MANAGED_PIXABAY_API_KEY = prevPixabay;
  }

  // HERO-110: bounded per-call timeout guards slow upstream fetches without stalling get_video_options
  assert(VIDEO_OPTIONS_FETCH_TIMEOUT_MS === 5_000, "HERO-110: default per-call timeout is 5,000ms");
  {
    const observedSignals: Record<string, AbortSignal | undefined> = {};
    const makeHangingCaller = (hangPath: string, rejectLateAfterMs?: number): PipelineCaller => ({
      async get<T>(path: string, opts?: { retries?: number; signal?: AbortSignal }): Promise<T> {
        observedSignals[path] = opts?.signal;
        if (path === hangPath) {
          return new Promise<T>((_resolve, reject) => {
            if (rejectLateAfterMs !== undefined) {
              const t = setTimeout(() => reject(new Error("late upstream failure")), rejectLateAfterMs);
              t.unref?.();
            }
          });
        }
        return mock().get<T>(path);
      },
      post: async <T>() => ({} as T),
      patch: async <T>() => ({} as T),
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Hanging HeyGen avatar fetch degrades gracefully while music + voices still return
      const startHeygen = Date.now();
      const timedOutHeygen = await getVideoOptions(
        makeHangingCaller("/api/heygen/my-avatars", 80),
        u,
        [],
        { fetchTimeoutMs: 40 },
      );
      const heygenElapsed = Date.now() - startHeygen;
      assert(heygenElapsed < 300, `HERO-110: hanging HeyGen fetch returns promptly (${heygenElapsed}ms)`);
      assert(
        !Array.isArray(timedOutHeygen.avatars)
          && (timedOutHeygen.avatars as { error?: string; note?: string }).error === "timeout"
          && Boolean((timedOutHeygen.avatars as { note?: string }).note?.includes("savedAvatarId")),
        "HERO-110: hanging HeyGen fetch degrades to {error:'timeout', note} preserving savedAvatarId guidance",
      );
      assert(
        timedOutHeygen.avatarsMeta.selection === "avatar catalog unavailable" && timedOutHeygen.savedAvatarId === "av1",
        "HERO-110: hanging HeyGen preserves avatarsMeta fallback and savedAvatarId",
      );
      assert(
        "byMood" in timedOutHeygen.music && Array.isArray(timedOutHeygen.voices.elevenlabs),
        "HERO-110: hanging HeyGen does not disrupt healthy music or ElevenLabs sections",
      );
      assert(
        observedSignals["/api/heygen/my-avatars"]?.aborted === true,
        "HERO-110: timeout aborts the AbortSignal passed to caller.get",
      );

      // Hanging ElevenLabs voices fetch degrades gracefully with Thai voiceId fallback note
      const startEleven = Date.now();
      const timedOutEleven = await getVideoOptions(
        makeHangingCaller("/api/elevenlabs/voices"),
        u,
        [],
        { fetchTimeoutMs: 40 },
      );
      const elevenElapsed = Date.now() - startEleven;
      assert(elevenElapsed < 300, `HERO-110: hanging ElevenLabs fetch returns promptly (${elevenElapsed}ms)`);
      assert(
        !Array.isArray(timedOutEleven.voices.elevenlabs)
          && (timedOutEleven.voices.elevenlabs as { error?: string; note?: string }).error === "timeout"
          && Boolean((timedOutEleven.voices.elevenlabs as { note?: string }).note?.includes("voiceId")),
        "HERO-110: hanging ElevenLabs fetch degrades to {error:'timeout', note} preserving Thai voiceId fallback",
      );
      assert(
        "byMood" in timedOutEleven.music && Array.isArray(timedOutEleven.avatars),
        "HERO-110: hanging ElevenLabs does not disrupt healthy music or HeyGen sections",
      );

      // Hanging /api/music degrades gracefully while avatars + voices still return
      const startMusic = Date.now();
      const timedOutMusic = await getVideoOptions(
        makeHangingCaller("/api/music"),
        u,
        [],
        { fetchTimeoutMs: 40 },
      );
      const musicElapsed = Date.now() - startMusic;
      assert(musicElapsed < 300, `HERO-110: hanging /api/music fetch returns promptly (${musicElapsed}ms)`);
      assert(
        !("byMood" in timedOutMusic.music)
          && (timedOutMusic.music as { error?: string; note?: string }).error === "timeout"
          && Boolean((timedOutMusic.music as { note?: string }).note?.includes("bgmFile")),
        "HERO-110: hanging /api/music degrades to {error:'timeout', note} preserving bgmFile mood guidance",
      );
      assert(
        Array.isArray(timedOutMusic.avatars) && Array.isArray(timedOutMusic.voices.elevenlabs),
        "HERO-110: hanging /api/music does not disrupt healthy HeyGen or ElevenLabs sections",
      );

      // Wait past late rejection window to verify no unhandled rejection leaks
      await new Promise((r) => setTimeout(r, 100));
      assert(unhandled.length === 0, "HERO-110: late upstream rejection after timeout causes no unhandledRejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  console.log(`\n${passed} assertions passed ✅`);
}

main().catch((e) => { console.error(e); process.exit(1); });
