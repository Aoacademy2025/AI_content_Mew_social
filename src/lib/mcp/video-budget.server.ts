import { classifyEntitlement } from "@/lib/entitlements";
import { mcpAccessAllowed } from "./auth";
import { VIDEO_JOB_INFLIGHT_STATUSES } from "./video-job-status";
import { reconcileVideoJobFundingInTransaction } from "./video-job-funding";
import { voiceProviderPlanViolation } from "@/lib/render-plan-preflight";
import "server-only";
import { prisma } from "@/lib/prisma";
import { syncMinuteWindow } from "@/lib/minute-limits";
import { resolveHeroAiImageAccess } from "@/lib/internal-ai-access";
import { createVideoJobInTransaction, VideoJobFundingError, withVideoJobSqliteRetry } from "./video-job";
import { currentQuotePricing, quoteHash, quoteExecutionRefusal, quoteFailure, type QuoteReceipt } from "./video-quote";
import type { PrepareVideoJobInput } from "./create-video-input";
import type { QuoteExecution } from "./video-quote.server";
import { VideoBudgetHoldError } from "./video-budget-admission";

export async function consumeVideoQuote(userId: string, quoteId: string, changedInput?: PrepareVideoJobInput, _idempotencyKey?: string) {
  void _idempotencyKey; // Quote identity, not transport keys, owns execution idempotency.
  await syncMinuteWindow(userId);
  try {
    return await withVideoJobSqliteRetry("consume quote", () => prisma.$transaction(async tx => {
      const quote = await tx.mcpVideoQuote.findFirst({ where: { id: quoteId, userId } });
      if (!quote) return quoteFailure("quote_not_found", "ไม่พบใบยืนยันนี้");
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const refusal = quoteExecutionRefusal(quote, userId, changedInput, currentQuotePricing(), new Date(), user);
      if (refusal) return refusal;
      if (quote.status === "consumed" && quote.rootJobId) {
        const root = await tx.videoJob.findFirst({ where: { id: quote.rootJobId, userId }, select: { status: true } });
        return root ? { jobId: quote.rootJobId, status: root.status, replayed: true } : quoteFailure("quote_job_unavailable", "ไม่พบงานเดิม กรุณาติดต่อฝ่ายช่วยเหลือ");
      }
      if (user.suspended) return quoteFailure("account_suspended", "บัญชีนี้ยังสร้างงานไม่ได้");
      if (!mcpAccessAllowed(classifyEntitlement(user).effectivePlan)) return quoteFailure("plan_required", "สิทธิ์แผนปัจจุบันยังสร้างงานผ่าน MCP ไม่ได้");
      // These entitlement checks are local; never hold a transaction over provider calls.
      if (quote.source === "hero-ai-image" || quote.source === "automix") {
        const access = await resolveHeroAiImageAccess(user, tx);
        if (!access.canUse) return quoteFailure("image_access_required", "สิทธิ์สร้างภาพเปลี่ยนไป กรุณาตรวจใบยืนยันใหม่");
      }
      const wallet = await tx.creditBalance.findUnique({ where: { userId } });
      const promotional = await tx.promotionalCreditGrant.aggregate({ where: { userId, expiresAt: { gt: new Date() }, remainingAmount: { gt: 0 } }, _sum: { remainingAmount: true } });
      if ((wallet?.granted ?? 0) + (wallet?.purchased ?? 0) + (promotional._sum.remainingAmount ?? 0) < quote.totalHeroCreditCeiling) return quoteFailure("insufficient_funding", "เครดิตปัจจุบันไม่เพียงพอกับวงเงินที่ยืนยัน");
      const receipt = JSON.parse(quote.receiptJson) as QuoteReceipt;
      const execution = JSON.parse(quote.executionJson) as QuoteExecution;
      if (execution.jobInput.voiceProvider === "elevenlabs") {
        const refusal = voiceProviderPlanViolation("elevenlabs", user.plan);
        if (refusal) return quoteFailure(refusal.code, refusal.message);
        if (!user.elevenlabsKey) return quoteFailure("voice_setup_required", "กรุณาตั้งค่า ElevenLabs API key ใน Studio");
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
      const project = await tx.editorProject.create({ data: { userId, title: typeof execution.jobInput.title === "string" ? execution.jobInput.title : "New Project", draftJson: JSON.stringify({ createdVia: "mcp", ...(quote.source === "external" ? { brollSource: "external", stockSource: "none" } : {}) }) } });
      const input = { ...execution.jobInput, maxAiImages: quote.imageCountCeiling, previewMode: true, ...(execution.exportMode === "hold" ? { mcpHold: true } : { mcpChainExport: true }) };
      const job = await createVideoJobInTransaction(tx, userId, input, `mcp-quote:${quote.id}`, { projectId: project.id, budgetQuoteId: quote.id, ...(receipt.pricing.minuteQuotaLive ? { funding: { meteredMinutes: receipt.renderMinutesCeiling, creditsLive: receipt.pricing.creditsLive } } : {}) });
      if ((job.fundedCreditsSpent ?? 0) > quote.renderCreditCeiling || (job.fundedCreditsSpent ?? 0) > quote.totalHeroCreditCeiling) throw new VideoBudgetHoldError("funding_changed");
      await tx.mcpVideoQuote.update({ where: { id: quote.id }, data: { rootJobId: job.id } });
      await tx.editorProject.update({ where: { id: project.id }, data: { activeJobId: job.id, status: "rendering", lastOpenedAt: new Date() } });
      return { jobId: job.id, status: job.status, projectId: project.id, editorUrl: `/video-editor?projectId=${project.id}` };
    }));
  } catch (error) {
    if (error instanceof VideoBudgetHoldError || error instanceof VideoJobFundingError) return quoteFailure("confirmation_required", error.message);
    throw error;
  }
}

/** Public create gate: no preflight, generation or reservation until human approval. */
export async function requestVideoJob(user: import("@prisma/client").User, args: import("./create-video-input").CreateVideoJobInput) {
  if (args.quoteId) {
    const { quoteId, idempotencyKey, ...work } = args;
    return consumeVideoQuote(user.id, quoteId, Object.keys(work).length ? work : undefined, idempotencyKey);
  }
  const { prepareVideoQuote } = await import("./video-quote.server");
  const prepared = await prepareVideoQuote(user, args);
  return "quoteId" in prepared ? { ...prepared, error: "confirmation_required", code: "confirmation_required", message: "ต้องให้เจ้าของบัญชียืนยันใบสรุปค่าใช้จ่ายใน Studio ก่อนเริ่มงาน" } : prepared;
}
