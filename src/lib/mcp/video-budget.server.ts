import { classifyEntitlement } from "@/lib/entitlements";
import { mcpAccessAllowed } from "./auth";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "./video-job-status";
import { reconcileVideoJobFundingInTransaction } from "./video-job-funding";
import {
  aiAudioCeilingRefusal,
  managedAudioCeilingApplies,
  voiceProviderPlanViolation,
} from "@/lib/render-plan-preflight";
import { aiAudioCeilingFor } from "@/lib/ai-spend-limits";
import "server-only";
import { prisma } from "@/lib/prisma";
import { syncMinuteWindow } from "@/lib/minute-limits";
import { resolveHeroAiImageAccess } from "@/lib/internal-ai-access";
import { createVideoJobInTransaction, VideoJobFundingError, withVideoJobSqliteRetry } from "./video-job";
import { isReservedMcpChainIdempotencyKey } from "./chain-key";
import { currentQuotePricing, normalizeQuoteInput, quoteAccountDefaultsRefusal, quoteHash, quoteExecutionRefusal, quoteFailure, type QuoteReceipt } from "./video-quote";
import { prepareVideoJobInputSchema, type PrepareVideoJobInput } from "./create-video-input";
import type { QuoteExecution } from "./video-quote.server";
import { VideoBudgetHoldError } from "./video-budget-admission";

function confirmationRequiredReply<T extends { quoteId: string; confirmationUrl: string }>(quote: T) {
  return {
    ...quote,
    error: "confirmation_required",
    code: "confirmation_required",
    message: `ต้องให้เจ้าของบัญชียืนยันใบสรุปค่าใช้จ่ายใน Studio ก่อนเริ่มงาน (กดลิงก์เพื่อยืนยันและเริ่มสร้างวิดีโอทันที การพิมพ์ตอบตกลงในแชทเริ่มงานไม่ได้): ${quote.confirmationUrl}`,
  };
}

export async function consumeVideoQuote(userId: string, quoteId: string, changedInput?: PrepareVideoJobInput, _idempotencyKey?: string) {
  void _idempotencyKey; // Quote identity, not transport keys, owns execution idempotency.
  await syncMinuteWindow(userId);
  const preQuote = await prisma.mcpVideoQuote.findFirst({ where: { id: quoteId, userId } });
  if (!preQuote) return quoteFailure("quote_not_found", "ไม่พบใบยืนยันนี้");
  const preUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const preRefusal = quoteExecutionRefusal(preQuote, userId, changedInput, currentQuotePricing(), new Date(), preUser);
  if (preRefusal) return preRefusal;
  if (preQuote.status === "consumed" && preQuote.rootJobId) {
    const root = await prisma.videoJob.findFirst({ where: { id: preQuote.rootJobId, userId }, select: { status: true, projectId: true } });
    return root
      ? {
          jobId: preQuote.rootJobId,
          status: root.status,
          replayed: true,
          ...(root.projectId ? { projectId: root.projectId, editorUrl: `/video-editor?projectId=${root.projectId}` } : {}),
        }
      : quoteFailure("quote_job_unavailable", "ไม่พบงานเดิม กรุณาติดต่อฝ่ายช่วยเหลือ");
  }
  try {
    return await withVideoJobSqliteRetry("consume quote", () => prisma.$transaction(async tx => {
      const [quote, user] = await Promise.all([
        tx.mcpVideoQuote.findFirst({ where: { id: quoteId, userId } }),
        tx.user.findUniqueOrThrow({ where: { id: userId } }),
      ]);
      if (!quote) return quoteFailure("quote_not_found", "ไม่พบใบยืนยันนี้");
      const refusal = quoteExecutionRefusal(quote, userId, changedInput, currentQuotePricing(), new Date(), user);
      if (refusal) return refusal;
      if (quote.status === "consumed" && quote.rootJobId) {
        const root = await tx.videoJob.findFirst({ where: { id: quote.rootJobId, userId }, select: { status: true, projectId: true } });
        return root
          ? {
              jobId: quote.rootJobId,
              status: root.status,
              replayed: true,
              ...(root.projectId ? { projectId: root.projectId, editorUrl: `/video-editor?projectId=${root.projectId}` } : {}),
            }
          : quoteFailure("quote_job_unavailable", "ไม่พบงานเดิม กรุณาติดต่อฝ่ายช่วยเหลือ");
      }
      if (user.suspended) return quoteFailure("account_suspended", "บัญชีนี้ยังสร้างงานไม่ได้");
      if (!mcpAccessAllowed(classifyEntitlement(user).effectivePlan)) return quoteFailure("plan_required", "สิทธิ์แผนปัจจุบันยังสร้างงานผ่าน MCP ไม่ได้");
      // These entitlement checks are local; never hold a transaction over provider calls.
      if (quote.source === "hero-ai-image" || quote.source === "automix") {
        const access = await resolveHeroAiImageAccess(user, tx);
        if (!access.canUse) return quoteFailure("image_access_required", "สิทธิ์สร้างภาพเปลี่ยนไป กรุณาตรวจใบยืนยันใหม่");
      }
      const [wallet, promotional] = await Promise.all([
        tx.creditBalance.findUnique({ where: { userId } }),
        tx.promotionalCreditGrant.aggregate({ where: { userId, expiresAt: { gt: new Date() }, remainingAmount: { gt: 0 } }, _sum: { remainingAmount: true } }),
      ]);
      const totalAvailableCredits = (wallet?.granted ?? 0) + (wallet?.purchased ?? 0) + (promotional._sum.remainingAmount ?? 0);
      if (totalAvailableCredits < quote.totalHeroCreditCeiling) return quoteFailure("insufficient_funding", "เครดิตปัจจุบันไม่เพียงพอกับวงเงินที่ยืนยัน");
      const receipt = JSON.parse(quote.receiptJson) as QuoteReceipt;
      const execution = JSON.parse(quote.executionJson) as QuoteExecution;
      if (execution.jobInput.voiceProvider === "elevenlabs") {
        const refusal = voiceProviderPlanViolation("elevenlabs", user.plan);
        if (refusal) return quoteFailure(refusal.code, refusal.message);
        if (!user.elevenlabsKey) return quoteFailure("voice_setup_required", "กรุณาตั้งค่า ElevenLabs API key ใน Studio");
      }
      const narrationEngine = execution.jobInput.mode === "upload"
        ? "upload"
        : execution.jobInput.voiceProvider === "elevenlabs"
          ? "elevenlabs"
          : "gemini";
      const geminiKeyMode = user.geminiKey ? "byok" : "managed";
      if (!quote.parentQuoteId && managedAudioCeilingApplies(narrationEngine, geminiKeyMode)) {
        const ceiling = aiAudioCeilingFor(user.minutesLimit);
        const used = user.aiAudioMinutesUsed;
        const remaining = Math.max(0, ceiling - used);
        const walletCanFundOverflow = process.env.CREDITS_LIVE === "1" && totalAvailableCredits > quote.totalHeroCreditCeiling;
        const audioRefusal = aiAudioCeilingRefusal(
          { allowed: used < ceiling, remaining },
          user.plan,
          { walletCanFundOverflow },
        );
        if (audioRefusal) return quoteFailure(audioRefusal.code, `${audioRefusal.message} — ${audioRefusal.userAction}`);
      }

      if (quote.parentQuoteId) {
        const resume = execution as QuoteExecution & { resumeJobId: string; checkpointHash: string };
        const held = await tx.videoJob.findFirst({ where: { id: resume.resumeJobId, userId, budgetQuoteId: quote.parentQuoteId, status: "confirmation_required", budgetCheckpointRevision: quote.checkpointRevision ?? -1 } });
        if (!held) return quoteFailure("checkpoint_changed", "งานที่พักไว้เปลี่ยนแล้ว กรุณาอ่านสถานะล่าสุด");
        const checkpoint = JSON.parse(held.budgetCheckpointJson!);
        if (checkpoint.hold?.quoteId !== quote.id) return quoteFailure("checkpoint_changed", "ใบยืนยันไม่ตรงกับงานที่พักไว้");
        delete checkpoint.hold;
        if (quoteHash(checkpoint) !== resume.checkpointHash) return quoteFailure("checkpoint_changed", "ข้อมูลที่บันทึกไว้เปลี่ยนแล้ว");
        await tx.mcpVideoQuote.update({ where: { id: quote.id }, data: { status: "consumed", consumedAt: new Date() } });
        if (receipt.renderMinutesCeiling > 0) await reconcileVideoJobFundingInTransaction(tx, held.id, userId, (held.fundedMeteredMinutes ?? 0) + receipt.renderMinutesCeiling);
        await tx.videoJob.update({ where: { id: held.id }, data: { status: "queued", errorCode: null, errorMessage: null, budgetCheckpointJson: JSON.stringify(checkpoint) } });
        return { jobId: quote.rootJobId!, status: "queued", resumed: true };
      }
      const outstanding = await tx.videoJob.count({ where: { userId, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } });
      if (outstanding >= 3) return quoteFailure("too_many_jobs", "รอให้งานที่ค้างเสร็จก่อน");
      const claimed = await tx.mcpVideoQuote.updateMany({ where: { id: quoteId, userId, status: "approved", expiresAt: { gt: new Date() } }, data: { status: "consumed", consumedAt: new Date() } });
      if (claimed.count !== 1) throw new VideoBudgetHoldError("quote_race");
      const project = await tx.editorProject.create({
        data: {
          userId,
          title: typeof execution.jobInput.title === "string" ? execution.jobInput.title : "New Project",
          draftJson: JSON.stringify({
            createdVia: "mcp",
            ...(quote.source === "external" ? { brollSource: "external", stockSource: "none" } : {}),
            ...(execution.jobInput.headlineHook ? { headlineHook: execution.jobInput.headlineHook } : {}),
          }),
        },
      });
      const input = { ...execution.jobInput, maxAiImages: quote.imageCountCeiling, previewMode: true, ...(execution.exportMode === "hold" ? { mcpHold: true } : { mcpChainExport: true }) };
      const job = await createVideoJobInTransaction(tx, userId, input, `mcp-quote:${quote.id}`, { projectId: project.id, budgetQuoteId: quote.id, ...(receipt.pricing.minuteQuotaLive ? { funding: { meteredMinutes: receipt.renderMinutesCeiling, creditsLive: receipt.pricing.creditsLive } } : {}) });
      if ((job.fundedCreditsSpent ?? 0) > quote.renderCreditCeiling || (job.fundedCreditsSpent ?? 0) > quote.totalHeroCreditCeiling) throw new VideoBudgetHoldError("funding_changed");
      await tx.mcpVideoQuote.update({ where: { id: quote.id }, data: { rootJobId: job.id } });
      await tx.editorProject.update({ where: { id: project.id }, data: { activeJobId: job.id, status: "rendering", lastOpenedAt: new Date() } });
      return { jobId: job.id, status: job.status, projectId: project.id, editorUrl: `/video-editor?projectId=${project.id}`, ...(receipt.warnings?.length ? { warnings: receipt.warnings } : {}) };
    }));
  } catch (error) {
    if (error instanceof VideoBudgetHoldError || error instanceof VideoJobFundingError) return quoteFailure("confirmation_required", error.message);
    throw error;
  }
}

/** Public create entrypoint: auto-approves initial MCP video quotes and starts the job immediately
 * without requiring browser click confirmation, while preserving server-side budget ceilings,
 * deduplication (30m quote TTL), and mid-job overrun holds (`parentQuoteId !== null`). */
export async function requestVideoJob(user: import("@prisma/client").User, args: import("./create-video-input").CreateVideoJobInput) {
  if (isReservedMcpChainIdempotencyKey(args.idempotencyKey)) {
    return quoteFailure("invalid_input", "idempotencyKey นี้สงวนไว้สำหรับระบบภายใน");
  }
  if (args.quoteId) {
    const { quoteId, idempotencyKey, ...work } = args;
    const hasWork = Object.keys(work).length > 0;
    const existing = await prisma.mcpVideoQuote.findFirst({
      where: { id: quoteId, userId: user.id },
      select: { status: true, parentQuoteId: true, inputHash: true },
    });
    if (existing && existing.status === "draft" && !existing.parentQuoteId) {
      const workParsed = hasWork ? prepareVideoJobInputSchema.safeParse(work) : null;
      const inputMatches = !hasWork || (workParsed?.success && quoteHash(normalizeQuoteInput(workParsed.data)) === existing.inputHash);
      if (inputMatches) {
        const { decideVideoQuote } = await import("./video-quote.server");
        await decideVideoQuote(user.id, quoteId, "approve");
      }
    }
    return consumeVideoQuote(user.id, quoteId, hasWork ? work : undefined, idempotencyKey);
  }
  const parsed = prepareVideoJobInputSchema.safeParse(args);
  if (parsed.success && !parsed.data.resumeJobId) {
    const normalized = normalizeQuoteInput(parsed.data);
    const inputHash = quoteHash(normalized);
    const pricingHash = quoteHash(currentQuotePricing());
    const now = new Date();
    const candidates = await prisma.mcpVideoQuote.findMany({
      where: {
        userId: user.id,
        parentQuoteId: null,
        inputHash,
        pricingHash,
        expiresAt: { gt: now },
        status: { in: ["approved", "consumed", "draft"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    const valid = candidates.filter((row) => !quoteAccountDefaultsRefusal(row, user));
    const consumedRow = valid.find((row) => row.status === "consumed" && row.rootJobId);
    if (consumedRow?.rootJobId) {
      const rootJob = await prisma.videoJob.findFirst({
        where: { id: consumedRow.rootJobId, userId: user.id, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } },
        select: { id: true },
      });
      if (rootJob) {
        return consumeVideoQuote(user.id, consumedRow.id, undefined, args.idempotencyKey);
      }
    }
    const approvedRow = valid.find((row) => row.status === "approved");
    if (approvedRow) {
      return consumeVideoQuote(user.id, approvedRow.id, undefined, args.idempotencyKey);
    }
    const existingDraft = valid.find((row) => row.status === "draft");
    if (existingDraft) {
      const { decideVideoQuote } = await import("./video-quote.server");
      const decided = await decideVideoQuote(user.id, existingDraft.id, "approve");
      if (!("quoteId" in decided)) return decided;
      return consumeVideoQuote(user.id, existingDraft.id, undefined, args.idempotencyKey);
    }
  }
  const { prepareVideoQuote, decideVideoQuote } = await import("./video-quote.server");
  const prepared = await prepareVideoQuote(user, args);
  if (!("quoteId" in prepared)) return prepared;
  if (parsed.success && parsed.data.resumeJobId) {
    return confirmationRequiredReply(prepared);
  }
  const decided = await decideVideoQuote(user.id, prepared.quoteId, "approve");
  if (!("quoteId" in decided)) return decided;
  return consumeVideoQuote(user.id, prepared.quoteId, undefined, args.idempotencyKey);
}
