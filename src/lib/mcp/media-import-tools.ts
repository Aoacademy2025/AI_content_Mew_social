import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGatedTool, type GatingPrincipal } from "@/lib/mcp/tool-gating";
import { editToolFailure, type EditToolRunner } from "@/lib/mcp/edit-tools";
import { mcpPublicOrigin } from "@/lib/mcp/tools";
import {
  MAX_BATCH_UPLOAD_LINKS,
  UPLOAD_KINDS,
  UPLOAD_KIND_MAX_BYTES,
  UPLOAD_TOKEN_TTL_MS,
  issueUploadTokens,
  type UploadKind,
} from "@/lib/media-import/imports";
import { admissionRefusal } from "@/lib/mcp/media-import-copy";
import { prisma } from "@/lib/prisma";
import { ACTIVE_STYLE_PACK_IDS, isActiveStylePackId } from "@/lib/style-pack-catalog";
import {
  analyzeUploadedFootageItems,
  planStoryDirectorWithVisionModel,
} from "@/lib/story-director-analyzer.server";
import {
  buildStoryDirectorPlan,
  type StoryDirectorModelTier,
  type StoryVoiceMode,
} from "@/lib/story-director-planner";
import {
  STORY_DIRECTOR_FLASH_CREDITS,
  STORY_DIRECTOR_NEON_CREDITS,
} from "@/lib/credit-costs";
import { refundCredits, spendCredits } from "@/lib/credits";
import { KeyRequiredError, resolveGeminiKey } from "@/lib/gemini-key";

// The PUT route imports the admission copy from here (Task 11); it lives in media-import-copy.ts.
export { admissionRefusal };

/**
 * Task 11 + Story Director V2:
 *   - `create_upload_url`: mint single/batch upload PUT URLs
 *   - `inspect_footage_pack`: 0-credit "Bring-Your-Own-Agent-Brain" tool returning 1fps
 *     Timestamped Contact Sheet JPEG images directly to the customer's MCP agent (e.g. Claude Opus 5.5)
 *   - `analyze_footage_pack`: optional server-side Story Director planner
 *
 * Agent-neutral (G13/G14): flat primitive / primitive-array inputs, zero oneOf/anyOf/allOf,
 * every refusal `{ error, code, message (Thai), next }`.
 */

export const MCP_MEDIA_IMPORT_TOOL_NAMES = [
  "create_upload_url",
  "inspect_footage_pack",
  "analyze_footage_pack",
] as const;

const STORY_TEMPLATE_IDS = [...ACTIVE_STYLE_PACK_IDS] as [
  (typeof ACTIVE_STYLE_PACK_IDS)[number],
  ...(typeof ACTIVE_STYLE_PACK_IDS)[number][],
];

export const inspectFootagePackInputShape = {
  uploadIds: z.array(z.string()).describe(
    "รายการ uploadId (1–16 รายการ) จาก create_upload_url ที่อัปโหลด PUT เสร็จแล้ว ระบบจะส่งแผ่นภาพ Contact Sheet รายวินาที (มีเลขวินาที 0.2s, 1.2s... กำกับทุกช่อง) กลับเป็นรูปภาพให้เอเจนต์ของคุณดูและเลือกช่วงเวลา inSec..outSec เองได้ฟรี 0 เครดิต AI",
  ),
} satisfies z.ZodRawShape;

export const analyzeFootagePackInputShape = {
  uploadIds: z.array(z.string()).describe(
    "รายการ uploadId (1–16 รายการ) จาก create_upload_url (kind: video หรือ image) ที่อัปโหลด PUT เสร็จแล้ว เพื่อวิเคราะห์เสียงพูด ใบหน้า จังหวะบีต และวางแผนตัดต่อ",
  ),
  brief: z.string().optional().describe(
    "โจทย์เล่าเรื่องสั้น ๆ 1–2 บรรทัด เช่น 'น้องโซนิคเป็นดรัมเมเยอร์สีชมพู + แข่งวิ่งได้ 3 เหรียญ'",
  ),
  templateId: z.enum(STORY_TEMPLATE_IDS).optional().describe(
    "เทมเพลตผู้กำกับที่ต้องการ เช่น event-mission-vlog, proud-moment-highlight หรือ product-beat-showcase (ไม่ระบุ = เลือกให้อัตโนมัติตามโจทย์)",
  ),
  voiceMode: z.enum(["real-moments", "tts"]).optional().describe(
    "โหมดเสียง: real-moments = เล่าด้วยเสียงจริงในคลิป+เพลง+ป้ายอารมณ์สไตล์ TikTok Vlog (ค่าเริ่มต้น), tts = ให้ AI พากย์บรรยาย",
  ),
  useServerAi: z.boolean().optional().describe(
    "true = ให้เซิร์ฟเวอร์ใช้ Vision AI ส่องดู Contact Sheet แทนเอเจนต์ (หัก 6 หรือ 19 เครดิต), false (ค่าเริ่มต้น) = วิเคราะห์เมทาดาทาพื้นฐานฟรี (แนะนำเรียก inspect_footage_pack เพื่อใช้ AI ของคุณดูภาพเองฟรี)",
  ),
  modelTier: z.enum(["neon", "flash"]).optional().describe(
    "เมื่อ useServerAi=true: neon = Gemini 4 Neon แม่นพิเศษ (19 เครดิต, ค่าเริ่มต้น), flash = Gemini 3.8 Flash ประหยัด (6 เครดิต)",
  ),
  targetDurationSec: z.number().int().optional().describe(
    "ความยาวเป้าหมายเป็นวินาที (8–90; ไม่ระบุ = คำนวณตามจำนวนฟุตเทจอัตโนมัติ)",
  ),
} satisfies z.ZodRawShape;

export const createUploadUrlInputShape = {
  kind: z.enum(UPLOAD_KINDS).describe(
    "ชนิดไฟล์: image = รูป B-roll (jpg/png/webp ≤ 20 MB), video = วิดีโอ B-roll (mp4/mov/webm ≤ 200 MB), presenter = คลิปพิธีกรแนวตั้ง (mp4/mov/webm ≤ 500 MB)",
  ),
  count: z.number().int().min(1).max(MAX_BATCH_UPLOAD_LINKS).optional().describe(
    `จำนวนลิงก์อัปโหลดที่ต้องการในครั้งเดียว (1–${MAX_BATCH_UPLOAD_LINKS}, ค่าเริ่มต้น 1) — ใช้เมื่อต้องอัปโหลดไฟล์ B-roll หลายช่วงพร้อมกัน จะได้รายการใน uploads[]`,
  ),
} satisfies z.ZodRawShape;

const ACCEPTS: Record<UploadKind, string> = {
  image: "jpg, png, webp",
  video: "mp4, mov, webm",
  presenter: "mp4, mov, webm (แนวตั้ง)",
};

const USE_NEXT: Record<UploadKind, string> = {
  image: "ส่ง uploadId ให้ inspect_footage_pack หรือ replace_broll_window",
  video: "ส่ง uploadId ให้ inspect_footage_pack หรือ replace_broll_window",
  presenter: "ส่ง uploadId เป็น clipUploadId ของ create_video_job",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function uploadLinkOrigin(): URL | null {
  let origin: URL;
  try {
    origin = new URL(mcpPublicOrigin());
  } catch {
    return null;
  }
  if (origin.protocol === "https:") return origin;
  if (origin.protocol === "http:" && process.env.NODE_ENV !== "production" && LOOPBACK_HOSTS.has(origin.hostname)) return origin;
  return null;
}

const UPLOAD_UNAVAILABLE = editToolFailure(
  "upload_unavailable",
  "ตอนนี้ระบบยังสร้างลิงก์อัปโหลดที่ปลอดภัยไม่ได้",
  "ส่งลิงก์สาธารณะ (https) ของไฟล์แทน หรือแจ้งทีมงานให้ตรวจการตั้งค่า",
);

export async function createUploadUrlTool(userId: string, args: { kind: UploadKind; count?: number }) {
  const origin = uploadLinkOrigin();
  if (!origin) {
    console.error("[mcp-uploads] public origin is not https; upload links are disabled");
    return UPLOAD_UNAVAILABLE;
  }
  if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > MAX_BATCH_UPLOAD_LINKS)) {
    return editToolFailure(
      "invalid_input",
      `count ต้องเป็นจำนวนเต็มตั้งแต่ 1 ถึง ${MAX_BATCH_UPLOAD_LINKS}`,
      `เรียก create_upload_url โดยระบุ count ระหว่าง 1 ถึง ${MAX_BATCH_UPLOAD_LINKS}`,
    );
  }
  const issued = await issueUploadTokens(userId, args.kind, args.count ?? 1);
  if (!issued.ok) return admissionRefusal(issued.code, undefined, issued.retryAfterSeconds);
  const uploads = issued.items.map((item) => ({
    uploadId: item.importId,
    uploadUrl: new URL(`/api/mcp-uploads/${item.token}`, origin).toString(),
  }));
  const first = uploads[0];
  return {
    uploadId: first.uploadId,
    uploadUrl: first.uploadUrl,
    ...(args.count !== undefined ? { count: uploads.length, uploads } : {}),
    method: "PUT",
    kind: issued.kind,
    accepts: ACCEPTS[issued.kind],
    maxBytes: UPLOAD_KIND_MAX_BYTES[issued.kind],
    expiresAt: issued.expiresAt.toISOString(),
    next: `อัปโหลดไฟล์ด้วย HTTP PUT ไปที่ uploadUrl ภายใน ${UPLOAD_TOKEN_TTL_MS / 60_000} นาที — ส่งไบต์ของไฟล์เป็น body ตรงๆ (ไม่ใช่ multipart) ลิงก์ใช้ได้ครั้งเดียว จากนั้น${USE_NEXT[issued.kind]}`,
  };
}

const GATE_NEXT = "ส่งลิงก์สาธารณะ (https) ของไฟล์แทน หรือใช้ create_video_job / get_video_status ตามปกติ";
const RUN_NEXT = "ลองเรียก create_upload_url อีกครั้ง";
const ANALYZE_RUN_NEXT = "ตรวจสอบ uploadIds ว่าอัปโหลดเสร็จแล้ว แล้วลองเรียกใหม่อีกครั้ง";

async function loadVerifiedReadyImports(userId: string, rawUploadIds: string[], maxCount = 16) {
  if (!Array.isArray(rawUploadIds) || rawUploadIds.length === 0 || rawUploadIds.length > maxCount) {
    return {
      ok: false as const,
      failure: editToolFailure(
        "invalid_input",
        `ต้องส่ง uploadIds อย่างน้อย 1 รายการ และไม่เกิน ${maxCount} รายการ`,
        "เรียก create_upload_url เพื่ออัปโหลดไฟล์ก่อน แล้วส่ง uploadIds เข้ามาใหม่",
      ),
    };
  }
  const cleanIds = rawUploadIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);
  if (cleanIds.length !== rawUploadIds.length) {
    return {
      ok: false as const,
      failure: editToolFailure("invalid_input", "พบ uploadId ที่ว่างหรือรูปแบบไม่ถูกต้อง", ANALYZE_RUN_NEXT),
    };
  }

  const rows = await prisma.mediaImport.findMany({
    where: { userId, id: { in: cleanIds } },
    select: { id: true, status: true, purpose: true, resultSrc: true, durationMs: true, errorCode: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const missingIds = cleanIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    return {
      ok: false as const,
      failure: editToolFailure(
        "import_not_found",
        `ไม่พบไฟล์อัปโหลดของบัญชีนี้ (${missingIds.slice(0, 3).join(", ")})`,
        "สร้างลิงก์ใหม่ด้วย create_upload_url แล้วอัปโหลดไฟล์ด้วย HTTP PUT ก่อนเรียกซ้ำ",
      ),
    };
  }

  const pendingIds = cleanIds.filter((id) => {
    const r = byId.get(id)!;
    return r.status !== "ready" && r.status !== "failed";
  });
  if (pendingIds.length > 0) {
    return {
      ok: false as const,
      failure: editToolFailure(
        "imports_pending",
        `ไฟล์อัปโหลดยังประมวลผลไม่เสร็จ (${pendingIds.length} รายการ)`,
        "รอประมาณ 3–5 วินาทีให้ระบบประมวลผลไฟล์เสร็จ แล้วลองเรียกซ้ำอีกครั้ง",
      ),
    };
  }

  const failedIds = cleanIds.filter((id) => byId.get(id)?.status === "failed" || !byId.get(id)?.resultSrc);
  if (failedIds.length > 0) {
    return {
      ok: false as const,
      failure: editToolFailure(
        "import_failed",
        `ไฟล์อัปโหลดบางรายการใช้งานไม่ได้ (${failedIds.slice(0, 3).join(", ")})`,
        "ขอลิงก์ใหม่ด้วย create_upload_url แล้วอัปโหลดไฟล์ mp4/mov/jpg/png ที่สมบูรณ์อีกครั้ง",
      ),
    };
  }

  const orderedItems = cleanIds.map((id, idx) => {
    const r = byId.get(id)!;
    return {
      id: r.id,
      src: r.resultSrc!,
      filename: `CLIP_${idx}`,
      stillImage: r.purpose === "broll_image",
      durationSec: r.durationMs ? r.durationMs / 1000 : 5,
    };
  });

  return { ok: true as const, cleanIds, orderedItems };
}

/**
 * 0-Credit Client-Brain Inspection Tool (`inspect_footage_pack`).
 * Returns structured clip metadata + 1fps Timestamped Contact Sheets so the customer's own
 * multimodal AI (e.g. Claude Opus 5.5, Sonnet 5.5, Cursor, GPT-5.6) can visually inspect
 * every second of every clip and send exact `storyEdlJson` into `create_video_job` at 0 AI credit cost!
 */
export async function inspectFootagePackTool(
  userId: string,
  args: { uploadIds: string[] },
) {
  const verified = await loadVerifiedReadyImports(userId, args.uploadIds, 16);
  if (!verified.ok) return { kind: "error" as const, payload: verified.failure };

  const analyzed = await analyzeUploadedFootageItems(verified.orderedItems, {
    includeContactSheets: true,
    apiKey: null, // 0 server LLM calls!
  });

  const summaryPayload = {
    ok: true,
    creditsCharged: 0,
    clipCount: analyzed.length,
    clips: analyzed.map((c, clipIndex) => ({
      clipIndex,
      uploadId: c.id ?? verified.cleanIds[clipIndex],
      durationSec: c.durationSec,
      stillImage: Boolean(c.stillImage),
      hasAudio: Boolean(c.hasAudio),
      hasSpeechOrCheer: Boolean(c.hasSpeechOrCheer),
      faceBoxes: c.faceBoxes ?? [],
      sampledTimestampsSec: c.sampledTimestampsSec ?? [],
    })),
    howToDirectWithYourOwnAi:
      "ดูรูป Contact Sheet ที่แนบมา (แต่ละช่องมีเลขวินาทีสีเหลืองกำกับมุมซ้ายบน) คัดเฉพาะช่วงวินาทีที่เห็นตัวเอกชัด ไม่ติดคนบัง แล้วส่ง JSON String เข้าพารามิเตอร์ storyEdlJson ของ create_video_job รูปแบบ: {\"headline\":\"...\",\"subheadline\":\"...\",\"mission1Label\":\"...\",\"mission2Label\":\"...\",\"checklistItems\":[\"...\"],\"peakSticker\":\"...\",\"blooperTitle\":\"...\",\"shots\":[{\"clipIndex\":0,\"inSec\":0.2,\"outSec\":3.0,\"role\":\"cold-open\",\"keepClipAudio\":true,\"slowMo\":false,\"captionText\":\"...\"}]} พร้อม storyUploadIds, storyVoiceMode ('real-moments' หรือ 'tts') และ dualTikTokExport: true",
  };

  const images = analyzed
    .filter((c) => Boolean(c.contactSheetBase64))
    .map((c) => ({
      type: "image" as const,
      data: c.contactSheetBase64!,
      mimeType: "image/jpeg" as const,
    }));

  return {
    kind: "ok" as const,
    summaryPayload,
    images,
  };
}

export async function analyzeFootagePackTool(
  userId: string,
  args: {
    uploadIds: string[];
    brief?: string;
    templateId?: string;
    voiceMode?: StoryVoiceMode;
    useServerAi?: boolean;
    modelTier?: StoryDirectorModelTier;
    targetDurationSec?: number;
  },
) {
  if (args.templateId !== undefined && !isActiveStylePackId(args.templateId)) {
    return editToolFailure(
      "invalid_input",
      "templateId ไม่ถูกต้อง",
      "เรียก get_video_options เพื่อดูรายการ templates ที่ใช้งานได้",
    );
  }
  if (
    args.targetDurationSec !== undefined
    && (!Number.isInteger(args.targetDurationSec) || args.targetDurationSec < 8 || args.targetDurationSec > 90)
  ) {
    return editToolFailure(
      "invalid_input",
      "targetDurationSec ต้องเป็นจำนวนเต็มระหว่าง 8 ถึง 90 วินาที",
      "ปรับ targetDurationSec ให้อยู่ในช่วง 8–90 แล้วเรียก analyze_footage_pack ใหม่",
    );
  }

  const verified = await loadVerifiedReadyImports(userId, args.uploadIds, 20);
  if (!verified.ok) return verified.failure;

  const voiceMode: StoryVoiceMode = args.voiceMode ?? "real-moments";
  const modelTier: StoryDirectorModelTier = args.modelTier ?? "neon";

  if (args.useServerAi === true) {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { geminiKey: true, plan: true },
    });
    let apiKey: string | null = null;
    let geminiMode: "managed" | "byok" = "managed";
    try {
      if (dbUser) {
        const res = resolveGeminiKey(dbUser);
        apiKey = res.key;
        geminiMode = res.mode;
      }
    } catch (e) {
      if (!(e instanceof KeyRequiredError)) throw e;
    }

    if (!apiKey) {
      return editToolFailure(
        "key_required",
        "ยังไม่มีคีย์ AI สำหรับวิเคราะห์บนเซิร์ฟเวอร์",
        "เรียก inspect_footage_pack แทนเพื่อให้โมเดล AI ของคุณดูภาพ Contact Sheet เองฟรี 0 เครดิต",
      );
    }

    const creditAction = modelTier === "neon" ? "story-director-neon" : "story-director-flash";
    const creditCost = modelTier === "neon" ? STORY_DIRECTOR_NEON_CREDITS : STORY_DIRECTOR_FLASH_CREDITS;
    const shouldCharge = geminiMode === "managed" && process.env.CREDITS_LIVE === "1";
    let spent:
      | { fromGranted: number; fromPurchased: number; promotionalDebits: { grantId: string; amount: number }[] }
      | null = null;

    if (shouldCharge) {
      const spendRes = await spendCredits(userId, creditCost, creditAction);
      if (!spendRes.ok) {
        return editToolFailure(
          "insufficient_credits",
          `เครดิตไม่เพียงพอสำหรับ useServerAi (${creditCost} เครดิต · คงเหลือ ${spendRes.balanceAfter} เครดิต)`,
          "เรียก inspect_footage_pack แทนเพื่อให้ AI ของคุณดูภาพ Contact Sheet และจัดช็อตเองฟรี 0 เครดิต",
        );
      }
      spent = {
        fromGranted: spendRes.fromGranted,
        fromPurchased: spendRes.fromPurchased,
        promotionalDebits: spendRes.promotionalDebits,
      };
    }

    try {
      const analyzed = await analyzeUploadedFootageItems(verified.orderedItems, {
        includeContactSheets: true,
        apiKey,
      });
      const plan = await planStoryDirectorWithVisionModel({
        apiKey,
        modelTier,
        voiceMode,
        brief: args.brief,
        templateId: args.templateId ?? null,
        targetDurationSec: args.targetDurationSec,
        clips: analyzed,
        creditsCharged: spent ? creditCost : 0,
      });
      return {
        ok: true,
        creditsCharged: spent ? creditCost : 0,
        modelUsed: plan.modelUsed,
        clipCount: analyzed.length,
        plan: {
          templateId: plan.templateId,
          thaiTemplateLabel: plan.thaiTemplateLabel,
          voiceMode: plan.voiceMode,
          bpm: plan.bpm,
          targetDurationSec: plan.targetDurationSec,
          headline: plan.headline,
          subheadline: plan.subheadline,
          script: plan.script,
          momentCaptions: plan.momentCaptions,
          storyboardCards: plan.storyboardCards,
          storyOverlaysCount: plan.storyOverlays.length,
          dualTikTokExport: plan.dualTikTokExport,
        },
        next: "ส่ง create_video_job พร้อม storyUploadIds, storyVoiceMode, templateId และ dualTikTokExport: true เพื่อเรนเดอร์คลิป",
      };
    } catch (err) {
      if (spent) {
        await refundCredits(
          userId,
          spent.fromGranted,
          spent.fromPurchased,
          `${creditAction}:refund`,
          spent.promotionalDebits,
        ).catch(() => {});
      }
      return editToolFailure(
        "vision_failed",
        err instanceof Error ? err.message : "วิเคราะห์ภาพบนเซิร์ฟเวอร์ไม่สำเร็จ",
        "เรียก inspect_footage_pack เพื่อให้ AI ของคุณดูภาพ Contact Sheet เองโดยตรง",
      );
    }
  }

  const analyzed = await analyzeUploadedFootageItems(verified.orderedItems);
  const plan = buildStoryDirectorPlan({
    brief: args.brief,
    voiceMode,
    templateId: args.templateId ?? null,
    clips: analyzed,
    targetDurationSec: args.targetDurationSec,
  });

  return {
    ok: true,
    creditsCharged: 0,
    clipCount: analyzed.length,
    clips: analyzed.map((c, index) => ({
      index,
      uploadId: c.id ?? verified.cleanIds[index],
      durationSec: c.durationSec,
      stillImage: Boolean(c.stillImage),
      hasAudio: Boolean(c.hasAudio),
      hasSpeechOrCheer: Boolean(c.hasSpeechOrCheer),
      isLivePhotoCadence: Boolean(c.isLivePhotoCadence),
      faceDetected: Boolean(c.faceBoxes && c.faceBoxes.length > 0),
    })),
    plan: {
      templateId: plan.templateId,
      thaiTemplateLabel: plan.thaiTemplateLabel,
      voiceMode: plan.voiceMode,
      bpm: plan.bpm,
      targetDurationSec: plan.targetDurationSec,
      headline: plan.headline,
      subheadline: plan.subheadline,
      script: plan.script,
      momentCaptions: plan.momentCaptions,
      storyboardCards: plan.storyboardCards,
      storyOverlaysCount: plan.storyOverlays.length,
      dualTikTokExport: plan.dualTikTokExport,
    },
    next: "หากเอเจนต์ของคุณรองรับการดูรูปภาพ แนะนำให้เรียก inspect_footage_pack เพื่อดู Contact Sheet รายวินาทีด้วยตาตัวเองฟรี 0 เครดิต แล้วส่ง storyEdlJson เข้า create_video_job เพื่อความแม่นยำสูงสุด",
  };
}

export function registerMediaImportTools(
  server: McpServer,
  principal: GatingPrincipal,
  runTool: EditToolRunner,
): void {
  registerGatedTool(
    server,
    principal,
    "create_upload_url",
    {
      title: "Create Upload URL",
      description:
        "สร้างลิงก์ HTTP PUT แบบใช้ครั้งเดียว (อายุ 15 นาที) สำหรับอัปโหลดไฟล์จากเครื่องขึ้น HERO AI Studio โดยไม่ต้องมีลิงก์สาธารณะ รองรับ 3 ชนิด: image (รูป B-roll ≤ 20 MB), video (วิดีโอ B-roll ≤ 200 MB), presenter (คลิปพิธีกรแนวตั้ง ≤ 500 MB) ขอพร้อมกันหลายลิงก์ได้ด้วย count (สูงสุด 12)",
      inputSchema: createUploadUrlInputShape,
    },
    (args, extra) =>
      runTool("create_upload_url", extra, ({ userId }) => createUploadUrlTool(userId, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );

  registerGatedTool(
    server,
    principal,
    "inspect_footage_pack",
    {
      title: "Inspect Footage Pack (1fps Contact Sheets — 0 AI Credits)",
      description:
        "สกัดแผ่นภาพ Contact Sheet รายวินาที (มีเลขวินาที 0.2s, 1.2s... กำกับมุมซ้ายบนของทุกเฟรม) และข้อมูลเสียงพูดจากชุดไฟล์ uploadIds ส่งกลับเป็นรูปภาพให้โมเดล AI ของคุณ (เช่น Claude Opus 5.5 / Sonnet / GPT) เปิดดูด้วยตาตัวเองเพื่อคัดช่วง inSec..outSec ที่เห็นตัวเอกชัดและเขียน storyEdlJson ส่งเข้า create_video_job โดยไม่เสียเครดิต AI ฝั่งเซิร์ฟเวอร์ (0 เครดิต)",
      inputSchema: inspectFootagePackInputShape,
    },
    async (args, extra) => {
      let cachedImages: { type: "image"; data: string; mimeType: "image/jpeg" }[] = [];
      const res = await runTool(
        "inspect_footage_pack",
        extra,
        async ({ userId }) => {
          const out = await inspectFootagePackTool(userId, args);
          if (out.kind === "error") return out.payload;
          cachedImages = out.images;
          return out.summaryPayload;
        },
        args,
        { next: ANALYZE_RUN_NEXT },
      );
      if (cachedImages.length > 0) {
        return {
          ...res,
          content: [...(res.content ?? []), ...cachedImages],
        };
      }
      return res;
    },
    { next: GATE_NEXT },
  );

  registerGatedTool(
    server,
    principal,
    "analyze_footage_pack",
    {
      title: "Analyze Footage Pack (AI Story Director)",
      description:
        "วิเคราะห์ชุดคลิปวิดีโอ/รูปภาพที่อัปโหลดแล้ว (1–16 ไฟล์) เพื่อวางแผนตัดต่อสไตล์ AI Story Director รองรับทั้งการเรียกดูเมทาดาทาฟรี หรือตั้ง useServerAi=true ให้เซิร์ฟเวอร์ใช้ Gemini 4 Neon (19 เครดิต) / Gemini 3.8 Flash (6 เครดิต) ส่องภาพจัดลำดับช็อตให้",
      inputSchema: analyzeFootagePackInputShape,
    },
    (args, extra) =>
      runTool(
        "analyze_footage_pack",
        extra,
        ({ userId }) => analyzeFootagePackTool(userId, args),
        args,
        { next: ANALYZE_RUN_NEXT },
      ),
    { next: GATE_NEXT },
  );
}
