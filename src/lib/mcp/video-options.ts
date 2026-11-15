import { EXTERNAL_MEDIA_DISCLOSURE, currentQuotePricing } from "./video-quote";
import type { PipelineCaller } from "@/lib/mcp/pipeline-client";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { moodBuckets, moodMenu, type BgmTrack } from "@/lib/mcp/bgm-resolve";
import { HEYGEN_EXTERNAL_COST_DISCLOSURE, HEYGEN_ENGINE_LABELS, type HeyGenAvatarEngine } from "@/lib/heygen-avatar-engine";
import { DEFAULT_V2_SUB, V2_QUICK_STYLES } from "@/app/(dashboard)/video-editor/_v2/subtitle-style";
import type { McpActiveBrandProfileSummary } from "@/lib/brand-profile-library.server";
import { isManagedStockConfiguredFromEnv } from "@/lib/managed-stock";
import { activeStylePacks } from "@/lib/style-pack-catalog";

export const MEDIA_SOURCE_QUESTION = "อยากใช้ภาพประกอบแบบไหน: สต็อก, Hero AI Image, AutoMix หรือให้ AI ที่คุณคุยอยู่สร้าง/หาภาพและวิดีโอแล้วนำเข้าให้?";
export const MEDIA_TOOL_UNAVAILABLE = "เครื่องมือที่เชื่อมต่ออยู่ยังสร้างหรือค้นหาสื่อนี้ไม่ได้ คุณส่งไฟล์/ลิงก์ให้ผม หรือเลือกแหล่งสื่ออื่นได้";

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
  supportedEngines?: HeyGenAvatarEngine[];
};

function compactAvatarCatalog(
  avatars: Omit<McpAvatarOption, "saved">[],
  savedAvatarId: string | null,
  limit: number = MCP_AVATAR_OPTION_LIMIT,
) {
  const unique = [...new Map(
    avatars.filter((avatar) => !avatar.isPublic).map((avatar) => [avatar.avatarId, avatar]),
  ).values()];
  const saved = savedAvatarId ? unique.find((avatar) => avatar.avatarId === savedAvatarId) : undefined;
  const privateAvatars = unique.filter((avatar) => !avatar.isPublic && avatar.avatarId !== savedAvatarId);
  const options = [
    ...(saved ? [{ ...saved, saved: true }] : []),
    ...privateAvatars.map((avatar) => ({ ...avatar, saved: false })),
  ].slice(0, limit);

  return {
    options,
    meta: {
      totalAvailable: unique.length,
      returned: options.length,
      truncated: unique.length > options.length,
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
  // The caller's active brands (T4): the route looks these up (brand-profile-library.server
  // is a DB/server module this pure, caller+plain-fields function never imports) and passes
  // them through so get_video_options stays easy to unit test without a database.
  subtitleBrands: McpActiveBrandProfileSummary[] = [],
) {
  const managedStock = isManagedStockConfiguredFromEnv();
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
          // MCP uses the same completed private-look catalog as editor v2. The
          // compaction below remains a fail-safe for duplicate or unusually large
          // private catalogs and rejects any accidental public row defensively.
          const r = await caller.get<{ avatars: { avatar_id: string; avatar_name: string; preview_image_url?: string; is_public?: boolean; supported_api_engines?: HeyGenAvatarEngine[] }[] }>("/api/heygen/my-avatars");
          return (r.avatars ?? []).map((a) => ({
            avatarId: a.avatar_id,
            name: a.avatar_name,
            preview: a.preview_image_url ?? null,
            isPublic: a.is_public === true,
            ...(a.supported_api_engines ? { supportedEngines: a.supported_api_engines } : {}),
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

  const templates = activeStylePacks().map((pack) => ({
    id: pack.id,
    thaiLabel: pack.thaiLabel,
    tagline: pack.tagline,
    pacing: pack.pacing,
    musicMood: pack.musicMood,
    subtitlePreset: pack.subtitle.preset,
    headlineHookStyle: pack.headlineHookPreset,
    highlightKeywords: pack.highlightKeywords,
    statCards: pack.statCards,
    sfxMode: pack.sfxMode,
    punchZoom: pack.punchZoom,
    brollTransition: pack.brollTransition,
  }));

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
    avatarEngines: Object.entries(HEYGEN_ENGINE_LABELS).map(([value, label]) => ({ value, label })),
    avatarBilling: {
      route: "BYOK",
      disclosure: `ใช้ HeyGen API key ของคุณ · ${HEYGEN_EXTERNAL_COST_DISCLOSURE}`,
    },
    voices: {
      gemini: GEMINI_VOICES,
      elevenlabs,
      savedGemini: user.geminiVoiceName ?? "Aoede",
      savedElevenlabs: user.elevenlabsVoiceId ?? null,
    },
    templates,
    templatesHowToChoose:
      "มี 2 แนวทางหลัก: (1) สไตล์สำเร็จรูป 1 คลิก — เลือก templateId คู่กับ brollSource (\"stock\" | \"hero-ai-image\" | \"automix\") ตอน create_video_job หรือ prepare_video_job ระบบจะตั้งโทนฟุตเทจสต็อกหรือรูปแบบภาพ+แนวเล่าเรื่อง+ชุดสีของ AI พร้อมซับ พาดหัว โทนเสียง SFX ซูมจังหวะ การตัดภาพ และเพลงให้อัตโนมัติโดยไม่ต้องไล่ถามสไตล์ย่อยซ้ำ (ค่าที่ระบุแยกเองจะทับเทมเพลตเสมอ; งานที่ hold ไว้ใช้ apply_video_template เปลี่ยนเทมเพลตทั้งชุดได้) (2) สื่อเฉพาะทางของผู้ใช้ — เลือก brollSource: \"external\" (ส่งคู่กับ templateId ได้เพื่อให้ซับ/พาดหัว/เพลงเข้าชุด) ระบบจะพักงานแบบ hold โดยใช้ 0 เครดิตสร้างภาพ Hero เพื่อให้เติมภาพ/วิดีโอเข้า windows[] ผ่าน batch_edit_video หรือ replace_broll_window ก่อน export_video",
    subtitleModes: ["sentence", "1", "2", "3", "4"] as const,
    subtitlePositions: ["top", "middle", "bottom"] as const,
    // Resolution order: explicit args → templateId defaults → Brand Subtitle Style → default below.
    subtitle: {
      sizeRange: [30, 160] as const,
      default: DEFAULT_V2_SUB.fontSize,
      styles: V2_QUICK_STYLES.map((style) => ({ id: style.key, label: style.label, desc: style.desc })),
      howToChoose: "ไม่ต้องระบุ subtitleSize/subtitleStyle/subtitleColor/subtitleAccentColor ก็ได้ — ใช้ค่าจาก templateId (ถ้าเลือก) หรือสไตล์ของแบรนด์ (ถ้ามี) หรือค่าเริ่มต้น",
      brands: subtitleBrands,
    },
    broll: {
      default: "stock" as const,
      managedStock,
      howToChoose: MEDIA_SOURCE_QUESTION,
      next: "เลือกแหล่ง → เรียก create_video_job เพื่อเริ่มงานอัตโนมัติได้ทันทีโดยไม่ต้องยืนยันในเบราว์เซอร์ (หรือเรียก prepare_video_job เพื่อดูใบประเมินวงเงินก่อน → ผู้ใช้ตกลงในแชท → create_video_job({quoteId}) ได้ทันทีโดยไม่ต้องเปิด confirmationUrl)",
      pricing: currentQuotePricing(),
      renderDisclosure: "ทุกแหล่งยังใช้นาทีเรนเดอร์ตามแผนหรือ Hero credits ส่วนเกิน ดูวงเงินจริงในใบยืนยัน",
      unavailableTools: MEDIA_TOOL_UNAVAILABLE,
      options: [
        {
          value: "stock",
          title: "วิดีโอสต็อก",
          detail: managedStock
            ? "Pexels · Pixabay คัดตามโทน templateId ใช้คลังกลางของระบบได้ทันที ไม่ต้องมีคีย์สต็อก ไม่มีเครดิตสร้างภาพ; ยังใช้นาทีเรนเดอร์/เครดิตส่วนเกิน"
            : "Pexels · Pixabay คัดตามโทน templateId ไม่มีเครดิตสร้างภาพ; ยังใช้นาทีเรนเดอร์/เครดิตส่วนเกิน (ต้องมีคีย์สต็อก Pexels หรือ Pixabay)",
          needsStockKey: !managedStock,
        },
        {
          value: "hero-ai-image",
          title: "Hero AI Image",
          detail: "ภาพ AI ทุกช่วงตามสไตล์ภาพและชุดสีของ templateId ใช้ Hero credits หรือสิทธิ์ทดลองตามใบยืนยัน ไม่ต้องมีคีย์สต็อก",
          needsStockKey: false,
        },
        {
          value: "automix",
          title: "AutoMix",
          detail: managedStock
            ? "วิดีโอสต็อก + ภาพสต็อก + ภาพ AI ตามสไตล์ templateId และสัดส่วนแนะนำ ใช้คลังกลางของระบบได้ทันที ไม่ต้องมีคีย์สต็อก"
            : "วิดีโอสต็อก + ภาพสต็อก + ภาพ AI ตามสไตล์ templateId และสัดส่วนแนะนำ ต้องมีคีย์สต็อก",
          needsStockKey: !managedStock,
        },
        {
          value: "external",
          title: "สื่อจากเครื่องมือของคุณ/ไฟล์/ลิงก์",
          detail: `${EXTERNAL_MEDIA_DISCLOSURE} · พักงานแบบ hold เพื่อให้เติมสื่อเข้า windows[] ผ่าน batch_edit_video หรือ replace_broll_window`,
          needsStockKey: false,
        },
      ],
    },
  };
}
