// brand-script-tools.ts — Upstream Brand Library & Hero Script MCP tools (HERO-96).
//
// Exposes two agent-neutral upstream tools on `/api/[transport]` so an MCP client
// can go Topic -> Brand-aligned Hero Script -> Video -> Atomic Batch Edit -> Export
// without manual copy-paste from the web workspace:
//   - `list_brand_profiles`: owner-scoped active/published Brand Profiles (writing
//     + visual/StylePack summary).
//   - `generate_hero_script`: end-to-end Hero Script generation reusing the exact
//     entitlement, rolling-window/slot reservation, AI input-caps, and managed
//     Gemini / OpenRouter provider pipeline from `src/lib/hero-script.server.ts`.
//
// Invariants:
//   - G13: flat primitive inputs + string-only enums (zero nested objects, zero unions).
//   - G14: every in-band failure returns `{ error, code, message (Thai), next }` with `error === code`.
//   - Privacy: audit args omit raw topic/script prose (log lengths & flags only).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { User } from "@prisma/client";
import { z } from "zod";
import { HERO_SCRIPT_LOCKED_MESSAGE } from "@/lib/hero-script-access";
import { resolveHeroScriptAccess } from "@/lib/hero-script-rollout.server";
import {
  listActiveBrandProfilesDetailedForMcp,
  type McpBrandProfileDetail,
} from "@/lib/brand-profile-library.server";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import {
  isOpenRouterAuthError,
  isOpenRouterCreditError,
  OPENROUTER_CREDIT_MESSAGE,
  OPENROUTER_UNAVAILABLE_MESSAGE,
} from "@/lib/openrouter";
import {
  HOOK_FORMULAS,
  STORY_STRUCTURES,
  isValidHookFormulaKey,
  isValidStoryStructureKey,
} from "@/lib/viral-frameworks";
import {
  buildGeneratePrompt,
  buildHooksPrompt,
  type BrandProfileForPrompt,
} from "@/lib/prompts/hero-script";
import {
  MODEL_UNAVAILABLE_MESSAGE,
  PRO_TIER_TEXT_CALL_COST,
  assembleScriptForHandoff,
  bannedWordWarning,
  canCreateScript,
  countScriptsInWindow,
  createScriptWithinCap,
  findBannedWord,
  generateValidatedJson,
  generateWithBannedWordGuard,
  heroScriptModel,
  heroScriptProvider,
  isModelUnavailableError,
  repairHooksResponse,
  reserveScriptGeneration,
  resolveHeroScriptBrandProfile,
  resolveLlmTriad,
  settleScriptGeneration,
  stripEchoedHook,
  validateGenerateResponse,
  validateTopic,
  wordBudgetForDuration,
  type GenerateScriptResult,
  type HeroScriptModelTier,
} from "@/lib/hero-script.server";

export const MCP_BRAND_SCRIPT_TOOL_NAMES = [
  "list_brand_profiles",
  "generate_hero_script",
] as const;

export type McpBrandScriptToolName = (typeof MCP_BRAND_SCRIPT_TOOL_NAMES)[number];

export type BrandScriptToolFailure = {
  error: string;
  code: string;
  message: string;
  next: string;
};

function fail(code: string, message: string, next: string): BrandScriptToolFailure {
  return { error: code, code, message, next };
}

function nonEmptyEnum(values: readonly string[]): [string, ...string[]] {
  if (values.length === 0) throw new Error("MCP brand/script tool enum cannot be empty");
  return [values[0], ...values.slice(1)];
}

export const HERO_SCRIPT_DURATION_ENUM = ["30", "60", "90"] as const;
const HOOK_FORMULA_ENUM = nonEmptyEnum(HOOK_FORMULAS.map((f) => f.key));
const STORY_STRUCTURE_ENUM = nonEmptyEnum(STORY_STRUCTURES.map((s) => s.key));

export const listBrandProfilesInputShape = {} satisfies z.ZodRawShape;

export const generateHeroScriptInputShape = {
  topic: z
    .string()
    .describe("หัวข้อหรือไอเดียคลิปที่ต้องการให้เขียนสคริปต์ไวรัล (สูงสุด 300 ตัวอักษร)"),
  durationSec: z
    .enum(HERO_SCRIPT_DURATION_ENUM)
    .optional()
    .describe("ความยาวเป้าหมายของคลิปเป็นวินาที (\"30\", \"60\" หรือ \"90\" — ค่าเริ่มต้น \"60\")"),
  brandProfileId: z
    .string()
    .optional()
    .describe("รหัสโปรไฟล์แบรนด์จาก list_brand_profiles เพื่อดึงนิช กลุ่มเป้าหมาย โทนเสียง คำต้องห้าม และสไตล์ CTA"),
  hookFormula: z
    .enum(HOOK_FORMULA_ENUM)
    .optional()
    .describe("สูตรประโยคเปิดคลิป (hook) ที่ต้องการบังคับใช้; ไม่ส่ง = ให้ระบบเลือกสูตรที่เหมาะกับหัวข้อที่สุด"),
  structure: z
    .enum(STORY_STRUCTURE_ENUM)
    .optional()
    .describe("โครงเรื่องที่ต้องการบังคับใช้ (list / pas / story-lesson / how-to / myth-bust); ไม่ส่ง = ให้ระบบเลือกโครงที่เหมาะที่สุด"),
  saveToLibrary: z
    .boolean()
    .optional()
    .describe("บันทึกสคริปต์ลงคลัง Hero Script ของบัญชีหรือไม่ (ค่าเริ่มต้น true)"),
} satisfies z.ZodRawShape;

export type ListBrandProfilesResult = {
  ok: true;
  count: number;
  profiles: McpBrandProfileDetail[];
  next: string;
};

export async function listBrandProfilesTool(userId: string): Promise<ListBrandProfilesResult> {
  const profiles = await listActiveBrandProfilesDetailedForMcp(userId);
  return {
    ok: true,
    count: profiles.length,
    profiles,
    next:
      profiles.length > 0
        ? "นำ id จาก profiles[] ไปส่งเป็น brandProfileId ใน generate_hero_script (ดึงนิช/กลุ่มเป้าหมาย/โทนเสียง/คำต้องห้าม/สไตล์ CTA) หรือใน create_video_job / prepare_video_job (ดึงสไตล์แบรนด์ของวิดีโอ)"
        : "ยังไม่มีโปรไฟล์แบรนด์ที่เปิดใช้งาน — สร้างโปรไฟล์แบรนด์ในเว็บที่ studio.heroaiengine.com/brands หรือเรียก generate_hero_script / create_video_job โดยไม่ต้องส่ง brandProfileId",
  };
}

export type GenerateHeroScriptArgs = {
  topic?: unknown;
  durationSec?: unknown;
  brandProfileId?: unknown;
  hookFormula?: unknown;
  structure?: unknown;
  saveToLibrary?: unknown;
};

export type GenerateHeroScriptSuccess = {
  ok: true;
  scriptId: string | null;
  savedToLibrary: boolean;
  topic: string;
  durationSec: 30 | 60 | 90;
  hookFormula: string;
  structure: string;
  hookText: string;
  bodyText: string;
  ctaText: string;
  fullScript: string;
  brandProfileId: string | null;
  warning?: string;
  next: string;
};

function parseDurationSec(raw: unknown): 30 | 60 | 90 | null {
  if (raw === undefined) return 60;
  if (raw === 30 || raw === "30") return 30;
  if (raw === 60 || raw === "60") return 60;
  if (raw === 90 || raw === "90") return 90;
  return null;
}

function mapProviderFailure(
  error: unknown,
  tier: HeroScriptModelTier,
): BrandScriptToolFailure | null {
  const provider = heroScriptProvider();
  const where = `mcp.generate_hero_script: provider=${provider} model=${heroScriptModel(tier, provider)}`;

  if (isOpenRouterCreditError(error)) {
    console.error(`[hero-script] provider credit/allowance exhausted (${where})`);
    return fail(
      "provider_credit",
      OPENROUTER_CREDIT_MESSAGE,
      "รอสักครู่แล้วลองเรียก generate_hero_script อีกครั้ง หรือพิมพ์สคริปต์เองแล้วส่งให้ create_video_job",
    );
  }
  if (isOpenRouterAuthError(error)) {
    console.error(`[hero-script] provider credential rejected/missing (${where})`);
    return fail(
      "provider_unavailable",
      OPENROUTER_UNAVAILABLE_MESSAGE,
      "แจ้งทีมงานตรวจสอบการตั้งค่า AI หรือพิมพ์สคริปต์เองแล้วส่งให้ create_video_job",
    );
  }
  if (isModelUnavailableError(error)) {
    console.error(`[hero-script] model unavailable (${where})`);
    return fail(
      "model_unavailable",
      MODEL_UNAVAILABLE_MESSAGE,
      "ลองใหม่อีกครั้งในอีกสักครู่ หรือพิมพ์สคริปต์เองแล้วส่งให้ create_video_job",
    );
  }
  return null;
}

export async function generateHeroScriptTool(
  user: User,
  args: GenerateHeroScriptArgs,
): Promise<GenerateHeroScriptSuccess | BrandScriptToolFailure> {
  // 1. Entitlement & rollout check (mirrors requireHeroScriptUser).
  const access = await resolveHeroScriptAccess(user);
  if (!access.canUse) {
    if (access.reason === "payment_required") {
      return fail(
        "payment_required",
        "ฟีเจอร์เขียนสคริปต์ AI (Hero Script) ใช้ได้เฉพาะสมาชิกที่ชำระเงินแล้ว (ไม่รวมช่วงทดลองใช้) — อัปเกรดเพื่อใช้งาน",
        "อัปเกรดแผนที่ studio.heroaiengine.com/pricing หรือพิมพ์สคริปต์เองแล้วส่งให้ create_video_job",
      );
    }
    return fail(
      "feature_not_enabled",
      HERO_SCRIPT_LOCKED_MESSAGE,
      "อัปเกรดแผนที่ studio.heroaiengine.com/pricing หรือพิมพ์สคริปต์เองแล้วส่งให้ create_video_job",
    );
  }

  // 2. Upfront flat-input validation (before reserving any quota or calling providers).
  const topicCheck = validateTopic(args.topic);
  if (!topicCheck.ok) {
    return fail(
      "invalid_input",
      topicCheck.message,
      "ระบุ topic เป็นข้อความหัวข้อคลิปไม่เกิน 300 ตัวอักษร แล้วเรียก generate_hero_script อีกครั้ง",
    );
  }

  const durationSec = parseDurationSec(args.durationSec);
  if (durationSec === null) {
    return fail(
      "invalid_input",
      "ความยาวคลิป (durationSec) ต้องเป็น \"30\", \"60\" หรือ \"90\" วินาที",
      "ส่ง durationSec เป็น \"30\", \"60\" หรือ \"90\" แล้วเรียก generate_hero_script อีกครั้ง",
    );
  }

  let requestedHookFormula: string | null = null;
  if (args.hookFormula !== undefined) {
    if (typeof args.hookFormula !== "string" || !isValidHookFormulaKey(args.hookFormula.trim())) {
      return fail(
        "invalid_input",
        `ไม่รู้จัก hookFormula ที่ระบุ (ใช้ได้: ${HOOK_FORMULAS.map((f) => f.key).join(", ")})`,
        "เลือก hookFormula จากรายการที่รองรับ หรือเว้นว่างเพื่อให้ระบบเลือกอัตโนมัติ",
      );
    }
    requestedHookFormula = args.hookFormula.trim();
  }

  let requestedStructure: string | null = null;
  if (args.structure !== undefined) {
    if (typeof args.structure !== "string" || !isValidStoryStructureKey(args.structure.trim())) {
      return fail(
        "invalid_input",
        `ไม่รู้จัก structure ที่ระบุ (ใช้ได้: ${STORY_STRUCTURES.map((s) => s.key).join(", ")})`,
        "เลือก structure จากรายการที่รองรับ (list, pas, story-lesson, how-to, myth-bust) หรือเว้นว่าง",
      );
    }
    requestedStructure = args.structure.trim();
  }

  if (args.saveToLibrary !== undefined && typeof args.saveToLibrary !== "boolean") {
    return fail(
      "invalid_input",
      "saveToLibrary ต้องเป็นค่า boolean (true หรือ false)",
      "ส่ง saveToLibrary เป็น true หรือ false แล้วเรียก generate_hero_script อีกครั้ง",
    );
  }
  const saveToLibrary = args.saveToLibrary !== false;

  const capsCheck = checkAiInputCaps({ script: topicCheck.topic });
  if (!capsCheck.ok) {
    return fail(
      "invalid_input",
      capsCheck.message,
      "ย่อข้อความหัวข้อให้สั้นลงแล้วเรียก generate_hero_script อีกครั้ง",
    );
  }

  // 3. Optional Brand Profile resolution (owner-scoped + active/unfrozen check).
  let brandProfileId: string | null = null;
  let profile: BrandProfileForPrompt | null = null;
  let bannedWords: string[] = [];
  let ctaStyle = "follow";
  if (args.brandProfileId !== undefined) {
    if (typeof args.brandProfileId !== "string" || !args.brandProfileId.trim()) {
      return fail(
        "invalid_input",
        "brandProfileId ต้องเป็นรหัสโปรไฟล์แบรนด์ที่ไม่ว่าง",
        "เรียก list_brand_profiles เพื่อดูรหัสโปรไฟล์แบรนด์ที่ใช้ได้ หรือเว้น brandProfileId",
      );
    }
    brandProfileId = args.brandProfileId.trim();
    const resolvedBrand = await resolveHeroScriptBrandProfile(user.id, brandProfileId);
    if (!resolvedBrand.ok) {
      return fail(
        resolvedBrand.code === "UNAVAILABLE" ? "brand_profile_unavailable" : "invalid_input",
        resolvedBrand.message,
        "เรียก list_brand_profiles เพื่อเลือกโปรไฟล์แบรนด์ที่เปิดใช้งานของบัญชีนี้ หรือเว้น brandProfileId",
      );
    }
    profile = resolvedBrand.profile;
    bannedWords = resolvedBrand.bannedWords;
    ctaStyle = resolvedBrand.ctaStyle;
  }

  // 4. Rolling-window saved-script cap precheck before burning AI calls.
  if (saveToLibrary) {
    const preCap = canCreateScript(user.plan, await countScriptsInWindow(user.id));
    if (!preCap.allowed) {
      return fail(
        "quota_exceeded",
        preCap.message ?? "ครบโควต้าการบันทึกสคริปต์ตามแผนแล้ว",
        "อัปเกรดแผนที่ studio.heroaiengine.com/pricing หรือส่ง saveToLibrary: false เพื่อสร้างสคริปต์โดยไม่บันทึกลงคลัง",
      );
    }
  }

  // 5. Reserve finite ScriptGenerationUsage slot (no-op for unlimited paid/internal cohorts,
  //    enforced atomically for finite cohorts). Always settled on exit.
  const generationReserve = await reserveScriptGeneration(user.id, access.cohort);
  if (!generationReserve.allowed) {
    return fail(
      "quota_exceeded",
      generationReserve.message,
      "อัปเกรดแผนที่ studio.heroaiengine.com/pricing เพื่อเขียนสคริปต์ไม่จำกัด",
    );
  }

  let settled = false;
  const settle = async (succeeded: boolean) => {
    if (settled) return;
    settled = true;
    await settleScriptGeneration(user.id, generationReserve.reservationId, succeeded);
  };

  let activeTier: HeroScriptModelTier = "fast";
  try {
    // 6. Shared LLM triad: input caps + Gemini key (when provider=gemini) + AI text call meter
    //    (1 fast hooks call + PRO_TIER_TEXT_CALL_COST pro generate calls, matching web /hooks + /generate).
    const triad = await resolveLlmTriad(
      user.id,
      { script: topicCheck.topic },
      { count: 1 + PRO_TIER_TEXT_CALL_COST },
    );
    if (!triad.ok) {
      await settle(false);
      if (triad.status === 400) {
        return fail(
          "invalid_input",
          typeof triad.body.error === "string" ? triad.body.error : "ข้อมูลนำเข้าไม่ถูกต้อง",
          "ปรับหัวข้อให้สั้นลงแล้วเรียก generate_hero_script อีกครั้ง",
        );
      }
      if (triad.status === 409) {
        return fail(
          "missing_key",
          "ยังไม่ได้ตั้งค่า Gemini API key สำหรับเขียนสคริปต์",
          "ไปตั้งค่า Gemini API key ที่ studio.heroaiengine.com/settings แท็บ API Keys แล้วลองใหม่",
        );
      }
      if (triad.status === 429) {
        return fail(
          "rate_limited",
          typeof triad.body.message === "string"
            ? triad.body.message
            : "เรียกใช้งาน AI ถี่เกินกำหนดชั่วคราว กรุณารอสักครู่",
          "รอสักครู่แล้วเรียก generate_hero_script อีกครั้ง",
        );
      }
      return fail(
        "internal_error",
        "ไม่สามารถเตรียมระบบเขียนสคริปต์ได้ในขณะนี้",
        "ลองเรียก generate_hero_script อีกครั้ง",
      );
    }

    // 7. Step A (fast tier): generate 5 viral hooks and pick the requested or best hook.
    activeTier = "fast";
    const hooksBasePrompt = buildHooksPrompt({
      topic: topicCheck.topic,
      durationSec,
      profile,
    });
    const hooksPrompt = requestedHookFormula
      ? `${hooksBasePrompt}\nกติกาเพิ่มเติม: ต้องมีสูตร "${requestedHookFormula}" อยู่ในรายการ hooks อย่างน้อย 1 รายการเสมอ`
      : hooksBasePrompt;

    const hooksResult = await generateValidatedJson({
      apiKey: triad.apiKey,
      prompt: hooksPrompt,
      maxOutputTokens: 2048,
      tier: "fast",
      validate: (data) => {
        const repaired = repairHooksResponse(data);
        if (!repaired) return null;
        if (
          requestedHookFormula &&
          !repaired.hooks.some((hook) => hook.formula === requestedHookFormula)
        ) {
          return null;
        }
        return repaired;
      },
    });

    if (!hooksResult) {
      await settle(false);
      return fail(
        "ai_invalid_response",
        "AI ตอบประโยคเปิดคลิป (hook) ผิดรูปแบบ ลองใหม่อีกครั้ง",
        "เรียก generate_hero_script อีกครั้ง",
      );
    }

    const chosenHook = requestedHookFormula
      ? hooksResult.hooks.find((hook) => hook.formula === requestedHookFormula)!
      : (hooksResult.hooks.find((hook) => !findBannedWord(hook.text, bannedWords)) ??
        hooksResult.hooks[0]);

    // 8. Step B (pro tier): generate full body + CTA with banned-words retry guard.
    activeTier = "pro";
    const wordBudget = wordBudgetForDuration(durationSec);
    const generateBasePrompt = buildGeneratePrompt({
      topic: topicCheck.topic,
      durationSec,
      wordBudget,
      hookText: chosenHook.text,
      ctaStyle,
      profile,
    });
    const structureRule = requestedStructure
      ? `\nกติกาโครงเรื่องบังคับ: ต้องใช้โครงเรื่อง "${requestedStructure}" เท่านั้น (ใส่ "structure":"${requestedStructure}" ใน JSON)`
      : "";

    const guarded = await generateWithBannedWordGuard<GenerateScriptResult>({
      bannedWords,
      extractText: (res) => `${chosenHook.text}\n${res.bodyText}\n${res.ctaText}`,
      generate: (sternNote) =>
        generateValidatedJson({
          apiKey: triad.apiKey,
          prompt: `${generateBasePrompt}${structureRule}${sternNote ? `\n${sternNote}` : ""}`,
          maxOutputTokens: 4096,
          tier: "pro",
          validate: (data) => {
            const validated = validateGenerateResponse(data);
            if (!validated) return null;
            if (requestedStructure && validated.structure !== requestedStructure) {
              return null;
            }
            return validated;
          },
        }),
    });

    if (!guarded) {
      await settle(false);
      return fail(
        "ai_invalid_response",
        "AI ตอบเนื้อหาสคริปต์ผิดรูปแบบ ลองใหม่อีกครั้ง",
        "เรียก generate_hero_script อีกครั้ง",
      );
    }

    const bodyText = stripEchoedHook(guarded.result.bodyText, chosenHook.text);
    const ctaText = guarded.result.ctaText;
    const fullScript = assembleScriptForHandoff({
      hookText: chosenHook.text,
      bodyText,
      ctaText,
    });

    const survivingBannedWord = findBannedWord(fullScript, bannedWords);
    const warning =
      guarded.warning ??
      (survivingBannedWord ? bannedWordWarning(survivingBannedWord) : undefined);

    // 9. Persist to Script library (unless caller explicitly requested saveToLibrary: false).
    let scriptId: string | null = null;
    if (saveToLibrary) {
      const saved = await createScriptWithinCap(user.id, user.plan, {
        topic: topicCheck.topic,
        durationSec,
        hookFormula: chosenHook.formula,
        structure: guarded.result.structure,
        hookText: chosenHook.text,
        bodyText,
        ctaText,
        brandProfileId,
      });
      if (!saved.ok) {
        await settle(false);
        return fail(
          "quota_exceeded",
          saved.capCheck.message ?? "ครบโควต้าการบันทึกสคริปต์ตามแผนแล้ว",
          "อัปเกรดแผนที่ studio.heroaiengine.com/pricing หรือส่ง saveToLibrary: false เพื่อสร้างสคริปต์โดยไม่บันทึกลงคลัง",
        );
      }
      scriptId = saved.script.id;
    }

    await settle(true);

    return {
      ok: true,
      scriptId,
      savedToLibrary: saveToLibrary,
      topic: topicCheck.topic,
      durationSec,
      hookFormula: chosenHook.formula,
      structure: guarded.result.structure,
      hookText: chosenHook.text,
      bodyText,
      ctaText,
      fullScript,
      brandProfileId,
      ...(warning ? { warning } : {}),
      next: brandProfileId
        ? `แสดง fullScript ให้ผู้ใช้ตรวจและยืนยันก่อน แล้วส่ง script: fullScript และ brandProfileId: "${brandProfileId}" ไปที่ create_video_job หรือ prepare_video_job`
        : "แสดง fullScript ให้ผู้ใช้ตรวจและยืนยันก่อน แล้วส่ง script: fullScript ไปที่ create_video_job หรือ prepare_video_job",
    };
  } catch (error) {
    await settle(false);
    const mapped = mapProviderFailure(error, activeTier);
    if (mapped) return mapped;
    throw error;
  }
}

type Extra = { authInfo?: AuthInfo };
type ToolReply = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};
type RunTool = (
  toolName: string,
  extra: Extra,
  fn: (p: { userId: string; user: User }) => Promise<unknown>,
  args?: unknown,
  opts?: { next: string },
) => Promise<ToolReply>;

export function registerBrandScriptTools(server: McpServer, runTool: RunTool): void {
  server.registerTool(
    "list_brand_profiles",
    {
      title: "List brand profiles",
      description:
        "ดูรายการโปรไฟล์แบรนด์ที่เปิดใช้งานของบัญชีนี้ (id, ชื่อแบรนด์, นิช, กลุ่มเป้าหมาย, โทนเสียง, สไตล์ CTA, ภาษา, เทมเพลต stylePackId และสรุปภาพลักษณ์แบรนด์) เพื่อนำ brandProfileId ไปใช้กับ generate_hero_script หรือ create_video_job",
      inputSchema: listBrandProfilesInputShape,
    },
    async (_args, extra) =>
      runTool(
        "list_brand_profiles",
        extra,
        async (p) => listBrandProfilesTool(p.userId),
        undefined,
        { next: "เรียก list_brand_profiles อีกครั้ง หรือตั้งค่าโปรไฟล์แบรนด์ที่ studio.heroaiengine.com/brands" },
      ),
  );

  server.registerTool(
    "generate_hero_script",
    {
      title: "Generate Hero Script",
      description:
        "เขียนสคริปต์คลิปสั้นไวรัลจากหัวข้อ (topic) ด้วยระบบ Hero Script พร้อมเลือกสูตรประโยคเปิด (hookFormula) โครงเรื่อง (structure) ความยาว (30/60/90 วิ) และผูกโปรไฟล์แบรนด์ (brandProfileId จาก list_brand_profiles) ได้ในคำสั่งเดียว — คืนค่า hookText, bodyText, ctaText, fullScript และ scriptId สำหรับนำไปสร้างวิดีโอต่อด้วย create_video_job",
      inputSchema: generateHeroScriptInputShape,
    },
    async (args, extra) =>
      runTool(
        "generate_hero_script",
        extra,
        async (p) => generateHeroScriptTool(p.user, args),
        {
          topicChars: typeof args.topic === "string" ? args.topic.length : 0,
          durationSec: args.durationSec ?? "60",
          hasBrandProfile: Boolean(args.brandProfileId),
          hookFormula: args.hookFormula ?? null,
          structure: args.structure ?? null,
          saveToLibrary: args.saveToLibrary ?? true,
        },
        { next: "ตรวจหัวข้อและพารามิเตอร์แล้วเรียก generate_hero_script อีกครั้ง" },
      ),
  );
}
