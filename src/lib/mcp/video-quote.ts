import { createHash } from "node:crypto";
import { elevenLabsSpeechModel } from "@/lib/elevenlabs-model";
import type { McpVideoQuote, User } from "@prisma/client";
import { prepareVideoJobInputSchema, type PrepareVideoJobInput } from "./create-video-input";
import { HERO_AI_IMAGE_CREDITS, creditCostFor } from "@/lib/credit-costs";
import { buildReceipt } from "@/app/(dashboard)/video-editor/_v2/receipt";
import { PRESET_WEIGHTS } from "@/app/(dashboard)/video-editor/_v2/mix-presets";

export const QUOTE_TTL_MS = 30 * 60 * 1000;
export const EXTERNAL_MEDIA_DISCLOSURE = "ไม่ใช้ Hero credits สำหรับการสร้างภาพ · การเรนเดอร์ยังใช้นาทีตามแผนหรือเครดิตส่วนเกิน · เครื่องมือภายนอกของคุณอาจมีค่าใช้จ่ายของตัวเอง";
export type QuoteSource = "stock" | "hero-ai-image" | "automix" | "external";
export type QuoteFailure = { error: string; code: string; message: string; next: string };
export function quoteFailure(code: string, message: string, next = "เรียก prepare_video_job เพื่อขอวงเงินใหม่ แล้วให้เจ้าของบัญชียืนยันใน Studio"): QuoteFailure {
  return { error: code, code, message, next };
}

/** Version changes whenever the meaning of a displayed term changes. Prices come from billing. */
export function currentQuotePricing() {
  return { version: 1, perImageCredits: HERO_AI_IMAGE_CREDITS, minuteCreditRate: creditCostFor("minute"), minuteQuotaLive: process.env.MINUTE_QUOTA === "1", creditsLive: process.env.CREDITS_LIVE === "1" };
}
export type QuotePricing = ReturnType<typeof currentQuotePricing>;

export function stableQuoteJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableQuoteJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableQuoteJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function quoteHash(value: unknown): string { return createHash("sha256").update(stableQuoteJson(value)).digest("hex"); }

/** Idempotency identifies a transport retry, never different approved work. */
export function normalizeQuoteInput(input: PrepareVideoJobInput): Omit<PrepareVideoJobInput, "idempotencyKey"> {
  const parsed = prepareVideoJobInputSchema.parse(input);
  delete parsed.idempotencyKey;
  delete parsed.quoteId;
  return { ...parsed, brollSource: parsed.brollSource ?? "stock" };
}

export function buildQuoteReceipt(input: {
  source: QuoteSource; durationSeconds: number; exactDuration: boolean;
  remainingMinutes: number; totalMinutes: number; availableCredits: number; reservedCredits: number;
  trialImageAllowance: { remaining: number; limit: number } | null;
  hasAvatar: boolean; avatarEngine?: PrepareVideoJobInput["avatarEngine"]; voiceProvider?: string;
  noAutomaticBroll?: boolean; pricing: QuotePricing;
}) {
  const usesAi = !input.noAutomaticBroll && (input.source === "hero-ai-image" || input.source === "automix");
  const model = buildReceipt({
    estSec: input.durationSeconds, exactDuration: input.exactDuration,
    remainingMinutes: input.remainingMinutes, totalMinutes: input.totalMinutes,
    usesAi, presetWeights: input.source === "hero-ai-image" ? { video: 0, photo: 0, ai: 1 } : PRESET_WEIGHTS.recommended,
    perImageCredits: input.pricing.perImageCredits, minuteCreditRate: input.pricing.minuteCreditRate,
    creditBalance: input.availableCredits, reservedCredits: input.reservedCredits,
    starterImageAllowance: usesAi ? input.trialImageAllowance : null,
    hasAvatar: input.hasAvatar, avatarEngine: input.avatarEngine, insufficientCreditBehavior: "block",
  });
  const imageCountCeiling = usesAi && input.trialImageAllowance
    ? Math.min(model.estimatedAiImages, input.trialImageAllowance.remaining) : model.estimatedAiImages;
  return {
    source: input.source, durationSeconds: input.durationSeconds, exactDuration: input.exactDuration,
    imageCountCeiling, imageCreditCeiling: model.estCredits,
    includedRenderMinutes: model.estMinutes - model.overflowMinutes,
    renderMinutesCeiling: model.estMinutes, renderCreditCeiling: model.overflowCredits,
    totalHeroCreditCeiling: model.totalEstimatedCredits,
    availableCredits: input.availableCredits, reservedCredits: input.reservedCredits,
    projectedRemainingCredits: input.availableCredits - model.totalEstimatedCredits,
    trialImageAllowance: usesAi ? input.trialImageAllowance : null,
    pricing: input.pricing,
    // AutoMix may use only its disclosed mix; this is never authority to add paid images.
    stockMixApproved: input.source === "automix",
    externalCharges: [
      ...(input.source === "external" ? [EXTERNAL_MEDIA_DISCLOSURE] : []),
      ...(input.hasAvatar ? model.lines.filter((line) => line.key === "avatar-cost").map((line) => line.text) : []),
      ...(input.voiceProvider === "elevenlabs" ? ["ElevenLabs ใช้ API key ของคุณ และอาจมีค่าใช้จ่ายจาก ElevenLabs แยกต่างหาก"] : []),
    ],
  };
}
export type QuoteReceipt = ReturnType<typeof buildQuoteReceipt> & { incremental?: boolean; retainedRootJobId?: string; checkpointRevision?: number; cumulativeHeroCreditCeiling?: number };
export type VideoQuoteView = QuoteReceipt & { quoteId: string; status: string; expiresAt: string; approvedAt: string | null; rootJobId: string | null; editorUrl?: string | null; confirmationUrl: string; next: string };
export type VideoQuoteReply = VideoQuoteView | QuoteFailure;

export function quoteStatus(row: Pick<McpVideoQuote, "status" | "expiresAt">, now = new Date()) {
  return (row.status === "draft" || row.status === "approved") && row.expiresAt <= now ? "expired" : row.status;
}

/** Until the consuming provider seam accepts a trusted pinned model, settings drift
 * must fail closed. Task 2 must repeat this check at that seam, not just at enqueue. */
export function quoteAccountDefaultsRefusal(row: Pick<McpVideoQuote, "executionJson">, currentAccount?: Pick<User, "elevenlabsModel"> | null): QuoteFailure | null {
  const execution = JSON.parse(row.executionJson) as { jobInput?: { voiceProvider?: unknown; elevenlabsModel?: unknown } };
  if (execution.jobInput?.voiceProvider !== "elevenlabs") return null;
  if (!currentAccount || execution.jobInput.elevenlabsModel !== elevenLabsSpeechModel(currentAccount.elevenlabsModel)) {
    return quoteFailure("quote_settings_changed", "รุ่นเสียง ElevenLabs เปลี่ยนไป หรือยังตรวจสอบรุ่นเสียงปัจจุบันไม่ได้ กรุณาตรวจใบยืนยันใหม่");
  }
  return null;
}

/** Task 2 calls this inside the consuming transaction, before existing funding reservations.
 * A consumed quote is replayable after expiry; it must return its original root, not create again. */
export function quoteExecutionRefusal(row: McpVideoQuote, userId: string, input: PrepareVideoJobInput | undefined, pricing = currentQuotePricing(), now = new Date(), currentAccount?: Pick<User, "elevenlabsModel"> | null): QuoteFailure | null {
  if (row.userId !== userId) return quoteFailure("quote_not_found", "ไม่พบใบยืนยันนี้");
  if (quoteHash(JSON.parse(row.executionJson)) !== row.executionHash || quoteHash(JSON.parse(row.inputJson)) !== row.inputHash || (input && quoteHash(normalizeQuoteInput(input)) !== row.inputHash)) return quoteFailure("quote_input_changed", "ข้อมูลงานไม่ตรงกับใบยืนยัน");
  if (row.status === "consumed" && row.rootJobId) return null;
  if (quoteHash(pricing) !== row.pricingHash) return quoteFailure("quote_price_changed", "ราคา หรือเงื่อนไขเปลี่ยนไป กรุณาตรวจใบยืนยันใหม่");
  if (quoteStatus(row, now) === "expired") return quoteFailure("quote_expired", "ใบยืนยันหมดอายุแล้ว");
  if (row.status !== "approved" || !row.approvedAt) return quoteFailure("confirmation_required", "เจ้าของบัญชียังไม่ได้ยืนยันวงเงินใน Studio");
  return quoteAccountDefaultsRefusal(row, currentAccount);
}
