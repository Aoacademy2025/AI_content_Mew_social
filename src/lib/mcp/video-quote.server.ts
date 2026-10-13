import "server-only";
import type { McpVideoQuote, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBalance, getReservedCredits } from "@/lib/credits";
import { minutesFromSeconds } from "@/lib/minute-round";
import { resolveHeroAiImageAccess, isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import { getStarterAiImageAllowanceStatus } from "@/lib/starter-ai-image-allowance.server";
import { estimateClipSecV2 } from "@/app/(dashboard)/video-editor/_v2/estimate";
import { prepareVideoJobInputSchema, type PrepareVideoJobInput } from "./create-video-input";
import { parseClipJobArgs } from "./clip-video-job";
import { resolveAvatarRequest } from "./avatar-steps";
import { getAvatarPreset, resolveAvatarLayout } from "@/lib/avatar-preset";
import { resolveMcpBrandSubtitleStyle, listActiveBrandProfilesForMcp } from "@/lib/brand-profile-library.server";
import { resolveMcpSubtitleDesign } from "./orchestrator-steps";
import { resolveGeminiVoiceStyle } from "@/lib/gemini-voice-styles";
import { resolveBgm, isNoneInput } from "./bgm-resolve";
import { elevenLabsSpeechModel } from "@/lib/elevenlabs-model";
import { mcpBrollJobFields } from "./broll-source";
import type { SubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import type { createMcpVideoJob } from "./chain-export";
type VideoJobInput = Parameters<typeof createMcpVideoJob>[1];
import {
  QUOTE_TTL_MS, buildQuoteReceipt, currentQuotePricing, normalizeQuoteInput, quoteFailure,
  quoteHash, quoteStatus, stableQuoteJson, quoteAccountDefaultsRefusal, type VideoQuoteReply, type VideoQuoteView,
  type QuoteReceipt, type QuoteFailure,
} from "./video-quote";

export type QuoteExecution = { jobInput: VideoJobInput; exportMode: "auto" | "hold"; presenterImportId: string | null; musicTitle?: string | null };
function publicOrigin() {
  return process.env.MCP_PUBLIC_ORIGIN?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://studio.heroaiengine.com";
}
function view(row: McpVideoQuote): VideoQuoteView {
  const status = quoteStatus(row);
  return {
    ...JSON.parse(row.receiptJson) as QuoteReceipt,
    quoteId: row.id, status, expiresAt: row.expiresAt.toISOString(), approvedAt: row.approvedAt?.toISOString() ?? null,
    rootJobId: row.rootJobId,
    confirmationUrl: new URL(`/mcp/confirm/${encodeURIComponent(row.id)}`, publicOrigin()).toString(),
    next: status === "draft" ? "ส่ง confirmationUrl ให้เจ้าของบัญชีเปิดและยืนยันใน Studio แล้วเรียก get_video_quote"
      : status === "approved" ? "เรียก create_video_job ด้วย quoteId นี้ โดยใช้ข้อมูลงานเดิม"
      : status === "consumed" ? "เรียก get_video_status ด้วย rootJobId — อย่าสร้างงานซ้ำ"
      : row.parentQuoteId ? `เรียก prepare_video_job พร้อม resumeJobId: ${row.rootJobId} เพื่อยืนยันงานที่บันทึกไว้` : "เรียก prepare_video_job เพื่อเริ่มใบยืนยันใหม่",
  };
}
const notFound = () => quoteFailure("quote_not_found", "ไม่พบใบยืนยันนี้", "ใช้ quoteId ของบัญชีนี้ หรือเรียก prepare_video_job ใหม่");
const importRequired = () => quoteFailure("presenter_import_required", "ยังไม่ทราบความยาวคลิปจริง จึงยังยืนยันค่าใช้จ่ายไม่ได้", "ใช้ create_upload_url(kind: presenter) แล้ว PUT คลิป รอให้นำเข้าสำเร็จ จากนั้นเรียก prepare_video_job พร้อม clipUploadId ของบัญชีนี้");

/** Local estimation and shared entitlement/balance reads (which may materialize existing
 * allowance/expiry bookkeeping). Never imports media, creates a VideoJob,
 * calls a provider, or reserves funding. Quota snapshots deliberately do not sync grants;
 * consumption must refresh entitlement/usage and funding before starting. */
export async function prepareVideoQuote(user: User, raw: PrepareVideoJobInput): Promise<VideoQuoteReply> {
  const parsed = prepareVideoJobInputSchema.safeParse(raw);
  if (!parsed.success) return quoteFailure("invalid_input", "ข้อมูลงานไม่ถูกต้อง", "ตรวจชนิดและช่วงค่าตาม schema ของ prepare_video_job");
  if (user.suspended) return quoteFailure("account_suspended", "บัญชีนี้ยังสร้างงานไม่ได้", "ติดต่อฝ่ายช่วยเหลือใน Studio");
  if (parsed.data.resumeJobId) {
    const { renewBudgetQuote } = await import("./video-budget-checkpoint");
    const renewed = await renewBudgetQuote(user.id, parsed.data.resumeJobId);
    return renewed ? getVideoQuote(user.id, renewed) : quoteFailure("resume_unavailable", "ยังไม่มีงานพร้อมขอยืนยันเพิ่มเติม", "เรียก get_video_status ของงานเดิมเพื่อตรวจสถานะ");
  }
  const input = normalizeQuoteInput(parsed.data);
  const clip = parseClipJobArgs(input);
  if (!clip.ok) return clip.failure;
  let durationSeconds = estimateClipSecV2(input.script ?? "");
  let presenter: { id: string; resultSrc: string | null; durationMs: number | null } | null = null;
  if (clip.clip) {
    if (clip.clip.source.kind !== "upload") return importRequired();
    presenter = await prisma.mediaImport.findFirst({ where: { id: clip.clip.source.id, userId: user.id, purpose: "presenter", status: "ready" }, select: { id: true, resultSrc: true, durationMs: true } });
    if (!presenter?.resultSrc || !presenter.durationMs || presenter.durationMs <= 0) return importRequired();
    durationSeconds = presenter.durationMs / 1000;
  }
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return quoteFailure("invalid_input", "ไม่พบเนื้อหาที่ใช้สร้างวิดีโอ", "ส่ง script ที่มีคำพูด หรือคลิปพิธีกรที่นำเข้าสำเร็จแล้ว");
  const source = input.brollSource ?? "stock";
  const noAutomaticBroll = source === "external" || clip.clip?.cutawayLayout === "fillYourself";
  const usesImages = !noAutomaticBroll && (source === "hero-ai-image" || source === "automix");
  const access = usesImages ? await resolveHeroAiImageAccess(user) : null;
  if (access && !access.canUse) return quoteFailure("image_access_required", "บัญชียังไม่มีสิทธิ์สร้างภาพ Hero AI Image", "ตรวจสิทธิ์ทดลองหรือแผนใน Studio หรือให้ผู้ใช้เลือกแหล่งสื่ออื่นด้วยตนเอง");
  const trial = access?.mode === "trial" ? await getStarterAiImageAllowanceStatus(user.id) : null;
  const pricing = currentQuotePricing();
  const [balance, reserved, minuteQuota, pendingRender] = await Promise.all([
    getBalance(user.id), getReservedCredits(user.id),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { minutesUsed: true, minutesLimit: true } }),
    prisma.videoJob.aggregate({ where: { userId: user.id, fundingState: "reserved" }, _sum: { fundedCreditsSpent: true } }),
  ]);
  // Without the minute meter, existing clip quota enforcement handles render usage.
  const remainingMinutes = pricing.minuteQuotaLive ? Math.max(0, Math.floor(minuteQuota.minutesLimit - minuteQuota.minutesUsed)) : minutesFromSeconds(durationSeconds);
  const voiceProvider = input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");
  const receipt = buildQuoteReceipt({
    source, durationSeconds, exactDuration: Boolean(presenter), remainingMinutes,
    totalMinutes: pricing.minuteQuotaLive ? minuteQuota.minutesLimit : remainingMinutes,
    availableCredits: balance.total, reservedCredits: reserved + (pendingRender._sum.fundedCreditsSpent ?? 0),
    trialImageAllowance: trial ? { remaining: trial.remainingImages, limit: trial.limitImages } : null,
    hasAvatar: !presenter && Boolean(input.avatarMode && input.avatarMode !== "none"), avatarEngine: input.avatarEngine,
    voiceProvider: presenter ? undefined : voiceProvider, noAutomaticBroll, pricing,
  });
  const execution = await resolveQuoteExecution(user, input, presenter);
  if ("error" in execution) return execution;
  // Bound unconsumed rows. The transaction prevents concurrent prepares bypassing the cap.
  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const active = await tx.mcpVideoQuote.count({ where: { userId: user.id, status: { in: ["draft", "approved"] }, expiresAt: { gt: now } } });
    if (active >= 20) return null;
    return tx.mcpVideoQuote.create({ data: {
      userId: user.id, inputJson: stableQuoteJson(input), inputHash: quoteHash(input),
      executionJson: stableQuoteJson(execution), executionHash: quoteHash(execution),
      pricingJson: stableQuoteJson(pricing), pricingHash: quoteHash(pricing), receiptJson: JSON.stringify(receipt),
      source, imageCountCeiling: receipt.imageCountCeiling, imageCreditCeiling: receipt.imageCreditCeiling,
      includedRenderMinutes: receipt.includedRenderMinutes, renderCreditCeiling: receipt.renderCreditCeiling,
      totalHeroCreditCeiling: receipt.totalHeroCreditCeiling, expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    } });
  });
  return result ? view(result) : quoteFailure("too_many_quotes", "มีใบยืนยันที่ยังใช้งานได้หลายรายการ", "ปฏิเสธใบยืนยันเก่าใน Studio หรือรอ 30 นาทีแล้วลองใหม่");
}

async function resolveQuoteExecution(user: User, input: ReturnType<typeof normalizeQuoteInput>, presenter: { id: string; resultSrc: string | null } | null): Promise<QuoteExecution | QuoteFailure> {
  const avatar = resolveAvatarRequest(input, user);
  if (avatar.kind === "error") return quoteFailure(avatar.payload.error, avatar.payload.message);
  let brandStyle: SubtitleStylePresetConfig | null = null;
  let brandId = input.brandProfileId;
  if (!brandId) {
    const brands = await listActiveBrandProfilesForMcp(user.id);
    if (brands.length === 1) brandId = brands[0].brandProfileId;
  }
  if (brandId) {
    const lookup = await resolveMcpBrandSubtitleStyle(user.id, brandId);
    if (!lookup.found) return quoteFailure("brand_not_found", "ไม่พบแบรนด์นี้ หรือยังใช้ไม่ได้");
    brandStyle = lookup.style ?? null;
  }
  const subtitle = resolveMcpSubtitleDesign(input, brandStyle);
  const layout = avatar.kind === "ok" ? resolveAvatarLayout(input, await getAvatarPreset(user.id, avatar.avatarId)) : null;
  const source = input.brollSource ?? "stock";
  const voiceProvider = input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");
  const voiceId = (input.voiceId ?? user.elevenlabsVoiceId)?.trim();
  if (!presenter && voiceProvider === "elevenlabs" && !voiceId) {
    return quoteFailure("voice_setup_required", "ยังไม่ได้เลือกเสียง ElevenLabs สำหรับงานนี้", "เลือกเสียงใน Studio หรือส่ง voiceId ที่ต้องการ แล้วเรียก prepare_video_job ใหม่");
  }
  // Same catalog ordering/ownership and pure selector used by /api/music + the worker.
  // Resolve locally now: a later catalog insert must not pick a different approved track.
  let music: { bgmFile: string; title: string } | null = null;
  if (!isNoneInput(input.bgmFile)) {
    const [systemTracks, ownerTracks] = await Promise.all([
      prisma.music.findMany({ orderBy: { createdAt: "desc" }, select: { title: true, filename: true } }),
      prisma.userMusic.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, select: { title: true, filename: true } }),
    ]);
    const tracks = [
      ...systemTracks.map((track) => ({ title: track.title, bgmFile: `/music/${track.filename}` })),
      ...ownerTracks.map((track) => ({ title: track.title, bgmFile: `/api/music/${track.filename}` })),
    ];
    const resolved = resolveBgm(input.bgmFile, tracks);
    if (resolved.kind !== "resolved" || !tracks.some((track) => track.bgmFile === resolved.bgmFile)) {
      return quoteFailure("bgm_not_found", "ไม่พบเพลงที่เลือกในคลังเพลงที่คุณใช้ได้", "เรียก get_video_options แล้วเลือกเพลงที่มีอยู่ หรือระบุ bgmFile: none จากนั้นเตรียมใบยืนยันใหม่");
    }
    music = resolved;
  }
  const styleOpen = isInternalAiBetaEnabledFor(user, process.env.GEMINI_TTS_38_PUBLIC === "1");
  const jobInput: VideoJobInput = {
    script: presenter ? "" : input.script!, title: input.title,
    ...(presenter ? { mode: "upload", clipImportId: presenter.id, clipUrl: presenter.resultSrc!, cutawayLayout: input.cutawayLayout ?? "auto" } : {
      voiceProvider, ...(voiceProvider === "elevenlabs" ? { voiceId, elevenlabsModel: elevenLabsSpeechModel(user.elevenlabsModel) } : {}),
      geminiVoiceName: input.geminiVoiceName ?? user.geminiVoiceName ?? "Aoede",
      geminiVoiceStyle: styleOpen ? resolveGeminiVoiceStyle(input.geminiVoiceStyle).id : "neutral",
    }),
    avatarMode: "none",
    ...(avatar.kind === "ok" && layout ? { avatarMode: avatar.avatarMode, avatarId: avatar.avatarId, avatarEngine: avatar.avatarEngine, avatarIntroSecs: avatar.introSecs, avatarTailSecs: avatar.tailSecs, avatarScale: layout.scale, avatarOffsetX: layout.offsetX, avatarOffsetY: layout.offsetY } : {}),
    ...(music ? { bgmFile: music.bgmFile, bgmVolume: input.bgmVolume ?? 0.12 } : {}),
    subtitleDesign: subtitle.design, subtitleCardLen: subtitle.cardLen,
    ...(input.subtitleMode ? { subtitleMode: input.subtitleMode } : {}),
    ...(input.subtitlePosition ? { subtitlePosition: input.subtitlePosition } : {}),
    ...(source === "external" || input.cutawayLayout === "fillYourself" ? { stockSource: "none" } : mcpBrollJobFields(source)),
  };
  return { jobInput, exportMode: source === "external" ? "hold" : input.exportMode ?? "auto", presenterImportId: presenter?.id ?? null, musicTitle: music?.title ?? null };
}

export async function getVideoQuote(userId: string, quoteId: string): Promise<VideoQuoteReply> {
  const row = await prisma.mcpVideoQuote.findFirst({ where: { id: quoteId, userId } });
  return row ? view(row) : notFound();
}

/** Protected human review only; never return the private work through a public tool reply. */
export async function getVideoQuoteReview(userId: string, quoteId: string) {
  const row = await prisma.mcpVideoQuote.findFirst({ where: { id: quoteId, userId } });
  return row ? { quote: view(row), input: JSON.parse(row.inputJson) as PrepareVideoJobInput, execution: JSON.parse(row.executionJson) as QuoteExecution } : null;
}

/** Only the Clerk-browser HTTP adapter calls this. CAS protects approve/reject vs consumption. */
export async function decideVideoQuote(userId: string, quoteId: string, action: "approve" | "reject"): Promise<VideoQuoteReply> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.mcpVideoQuote.findFirst({ where: { id: quoteId, userId } });
    if (!row) return notFound();
    if (quoteStatus(row) === "expired") return quoteFailure("quote_expired", "ใบยืนยันหมดอายุแล้ว");
    if (row.status !== "draft" && row.status !== "approved") return quoteFailure("quote_not_actionable", "ใบยืนยันนี้ไม่สามารถเปลี่ยนสถานะได้แล้ว");
    if (action === "approve" && quoteHash(currentQuotePricing()) !== row.pricingHash) return quoteFailure("quote_price_changed", "ราคา หรือเงื่อนไขเปลี่ยนไป กรุณาตรวจใบยืนยันใหม่");
    if (action === "approve") {
      const currentAccount = await tx.user.findUnique({ where: { id: userId }, select: { elevenlabsModel: true } });
      const defaultsRefusal = quoteAccountDefaultsRefusal(row, currentAccount);
      if (defaultsRefusal) return defaultsRefusal;
    }
    const changed = await tx.mcpVideoQuote.updateMany({
      where: { id: quoteId, userId, status: row.status, expiresAt: { gt: new Date() } },
      data: action === "approve" ? { status: "approved", approvedAt: row.approvedAt ?? new Date() } : { status: "rejected", rejectedAt: new Date() },
    });
    if (changed.count !== 1) return quoteFailure("quote_not_actionable", "สถานะใบยืนยันเปลี่ยนแล้ว กรุณาเปิดใหม่");
    return view(await tx.mcpVideoQuote.findUniqueOrThrow({ where: { id: quoteId } }));
  });
}
