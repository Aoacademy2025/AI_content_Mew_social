import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "mcp-spending-")), "test.db")}`;
process.env.CREDITS_LIVE = "1";
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getVideoJobCostReceipt } = await import("../src/lib/mcp/billing-receipt");
  const { spendCredits, grantCredits, creditCostFor } = await import("../src/lib/credits");
  const { createReservedImageJob, failAndRefundAiJob, completeImageJob } = await import("../src/lib/ai-generation-jobs.server");
  const { refundVideoJobFunding } = await import("../src/lib/mcp/video-job-funding");
  const { currentQuotePricing } = await import("../src/lib/mcp/video-quote");
  const userId = "receipt-owner";
  await prisma.user.create({ data: { id: userId, name: "Receipt", email: "receipt-owner@example.test", plan: "PRO", minutesLimit: 100 } });
  await prisma.user.create({ data: { id: "foreign", name: "Foreign", email: "foreign@example.test" } });
  await grantCredits(userId, 100, "purchase", "receipt-fixture");
  await prisma.videoJob.create({ data: { id: "root", userId, status: "processing", inputJson: "{}", fundingState: "transferred", fundedMeteredMinutes: 3, fundedCreditsSpent: creditCostFor("minute") } });
  const renderSpend = await spendCredits(userId, creditCostFor("minute"), "render-overflow:root");
  assert(renderSpend.ok);
  await prisma.renderJob.create({ data: { id: "base", userId, parentJobId: "root", type: "RENDER", status: "DONE", payload: "{}", reservedQuota: true, reservedMinutes: 3, creditsSpent: creditCostFor("minute") } });
  async function image(suffix: string) {
    const result = await createReservedImageJob({ userId, model: "z-image-turbo", provider: "runpod", providerModel: "fixture", providerRoute: "runpod-custom", providerEndpoint: "fixture", inputPreview: "fixture", inputJson: "{}", creditCost: 2, quoteVersion: "fixture", costBudgetUsdMicros: 10, estimatedCostUsdMicros: 1, idempotencyKey: `video:root:${suffix}`, mediaExpiresAt: new Date(Date.now() + 100000), productSurface: "hero_video" });
    assert(result.ok);
    return result.job;
  }
  const settled = await image("settled");
  await completeImageJob({ userId, jobId: settled.id, outputUrl: "/generated/receipt.png" });
  const pending = await image("pending");
  const returned = await image("refund");
  await failAndRefundAiJob(userId, returned.id, "fixture", "fixture", true);
  await prisma.aiGenerationJob.create({ data: { id: "trial", userId, kind: "image", provider: "runpod", model: "fixture", fundingSource: "starter_allowance", allowanceUnits: 1, creditCost: 99, chargeState: "settled", status: "completed", idempotencyKey: "video:root:trial" } });
  const pricing = currentQuotePricing();
  const quote = await prisma.mcpVideoQuote.create({ data: { id: "initial", userId, status: "consumed", rootJobId: "root", inputJson: "{}", inputHash: "fixture", executionJson: "{}", executionHash: "fixture", pricingJson: JSON.stringify(pricing), pricingHash: "fixture", receiptJson: JSON.stringify({ renderMinutesCeiling: 3, externalCharges: [] }), source: "hero-ai-image", imageCountCeiling: 4, imageCreditCeiling: 8, includedRenderMinutes: 2, renderCreditCeiling: 2, totalHeroCreditCeiling: 10, expiresAt: new Date(), approvedAt: new Date() } });
  await prisma.videoJob.update({ where: { id: "root" }, data: { budgetQuoteId: quote.id } });
  await prisma.mcpVideoQuote.create({ data: { ...quote, id: "increment", parentQuoteId: quote.id, imageCountCeiling: 1, imageCreditCeiling: 2, includedRenderMinutes: 0, renderCreditCeiling: 0, totalHeroCreditCeiling: 2 } });
  await prisma.mcpVideoQuote.create({ data: { ...quote, id: "draft", parentQuoteId: quote.id, status: "draft", approvedAt: null, totalHeroCreditCeiling: 999 } });
  await prisma.videoJob.create({ data: { id: "export", userId, type: "export", status: "done", inputJson: JSON.stringify({ mode: "export", sourceJobId: "root" }), idempotencyKey: "mcp-chain:root", budgetQuoteId: quote.id } });
  await prisma.renderJob.create({ data: { id: "free-burn", userId, parentJobId: "export", type: "BURN", status: "DONE", payload: "{}" } });
  const receipt = await getVideoJobCostReceipt({ videoJobId: "root", userId });
  assert(receipt);
  assert.equal(receipt.chargedCredits, creditCostFor("minute")); // compatible render receipt
  assert.equal(receipt.imageCredits, 2);
  assert.equal(receipt.renderCredits, creditCostFor("minute"));
  assert.equal(receipt.includedRenderMinutes, 2);
  assert.equal(receipt.settledTotalCredits, 2 + creditCostFor("minute"));
  assert.equal(receipt.outstandingReservedCredits, 2);
  assert.equal(receipt.confirmedRefundCredits, 2);
  assert.equal(receipt.pendingRefundCredits, 0);
  assert.equal(receipt.consumedTrialImageUnits, 1);
  assert.equal(receipt.availableCredits, 100 - 4 - creditCostFor("minute"));
  assert.equal(receipt.approvedTotalHeroCreditCeiling, 12);
  assert.equal(receipt.approvals.length, 2);
  assert.equal(receipt.renderChargeCount, 1);
  assert.equal(receipt.settlementStatus, "in_progress");
  assert.equal(await getVideoJobCostReceipt({ videoJobId: "root", userId: "foreign" }), null);
  assert.deepEqual(await getVideoJobCostReceipt({ videoJobId: "export", userId }), receipt);
  // Avatar/composite pipelines can transfer the one charge to a descendant burn.
  await prisma.renderJob.update({ where: { id: "base" }, data: { reservedQuota: false, reservedMinutes: null, creditsSpent: null } });
  await prisma.renderJob.update({ where: { id: "free-burn" }, data: { reservedQuota: true, reservedMinutes: 3, creditsSpent: creditCostFor("minute") } });
  const moved = await getVideoJobCostReceipt({ videoJobId: "export", userId });
  assert.equal(moved?.reservedRenderCredits, 0, "transferred root mirror must not duplicate a descendant burn charge");
  assert.equal(moved?.includedRenderMinutes, 2);
  assert.equal(moved?.reservedIncludedRenderMinutes, 0);
  await prisma.videoJob.update({ where: { id: "root" }, data: { fundingState: "settled" } });
  assert.equal((await getVideoJobCostReceipt({ videoJobId: "export", userId }))?.renderCredits, creditCostFor("minute"), "settled parent mirror is not another render charge");
  await prisma.videoJob.update({ where: { id: "root" }, data: { fundingState: "transferred" } });
  await prisma.renderJob.update({ where: { id: "base" }, data: { reservedQuota: true, reservedMinutes: 3, creditsSpent: creditCostFor("minute") } });
  await prisma.renderJob.update({ where: { id: "free-burn" }, data: { reservedQuota: false, reservedMinutes: null, creditsSpent: null } });
  await prisma.videoJob.update({ where: { id: "root" }, data: { status: "failed", reservationRefundPending: true } });
  await prisma.aiGenerationJob.update({ where: { id: pending.id }, data: { status: "failed" } });
  const failed = await getVideoJobCostReceipt({ videoJobId: "root", userId });
  assert.equal(failed?.pendingRefundCredits, null);
  assert.equal(failed?.pendingRefundExposureCredits, 4 + creditCostFor("minute"));
  assert.equal(failed?.confirmedRefundCredits, 2);
  assert.equal(failed?.outstandingReservedCredits, 2);
  assert.equal(failed?.settlementStatus, "refund_pending");
  // A pre-render refund is real money returned by the existing atomic helper.
  const extraSpend = await spendCredits(userId, 4, "render-overflow:reserved");
  assert(extraSpend.ok);
  await prisma.videoJob.create({ data: { id: "reserved", userId, status: "canceled", inputJson: "{}", fundingState: "reserved", fundedMeteredMinutes: 2, fundedCreditsSpent: 4, fundedCreditsFromGranted: extraSpend.fromGranted } });
  assert.equal((await getVideoJobCostReceipt({ videoJobId: "reserved", userId }))?.outstandingReservedCredits, 4);
  await refundVideoJobFunding("reserved", userId, "fixture");
  const refund = await getVideoJobCostReceipt({ videoJobId: "reserved", userId });
  assert.equal(refund?.confirmedRefundCredits, 4);
  assert.equal(refund?.outstandingReservedCredits, 0);
  assert.equal(refund?.settledTotalCredits, 0);
  assert.equal(refund?.status, "refunded");
  assert.equal(refund?.settlementStatus, "refunded");
  const project = await prisma.editorProject.create({ data: { userId, title: "Receipt fixture" } });
  await prisma.videoJob.create({ data: { id: "external-root", userId, projectId: project.id, status: "done", inputJson: JSON.stringify({ mcpHold: true, brollSource: "external" }), outputJson: JSON.stringify({ videoUrl: "/renders/preview.mp4" }) } });
  await prisma.renderJob.create({ data: { id: "external-base", userId, parentJobId: "external-root", type: "RENDER", status: "DONE", payload: "{}", reservedQuota: true, reservedMinutes: 2 } });
  for (const id of ["free-export-1", "free-export-2"]) {
    await prisma.videoJob.create({ data: { id, userId, projectId: project.id, type: "export", status: "done", inputJson: JSON.stringify({ mcpRootJobId: "external-root", sourceJobId: "external-root" }) } });
    await prisma.renderJob.create({ data: { id: `${id}-burn`, userId, parentJobId: id, type: "BURN", status: "DONE", payload: "{}" } });
  }
  // A separate same-project job and another owner's forged quote linkage cannot pollute totals.
  await prisma.videoJob.create({ data: { id: "unrelated", userId, projectId: project.id, inputJson: "{}" } });
  await prisma.renderJob.create({ data: { id: "unrelated-render", userId, parentJobId: "unrelated", type: "RENDER", status: "DONE", payload: "{}", reservedQuota: true, creditsSpent: 90 } });
  await prisma.aiGenerationJob.create({ data: { userId: "foreign", kind: "image", provider: "runpod", model: "fixture", budgetQuoteId: quote.id, fundingSource: "credits", creditCost: 80, chargeState: "settled" } });
  const external = await getVideoJobCostReceipt({ videoJobId: "free-export-2", userId });
  assert.equal(external?.rootJobId, "external-root");
  assert.equal(external?.imageCredits, 0);
  assert.equal(external?.renderCredits, 0);
  assert.equal(external?.includedRenderMinutes, 2);
  assert.equal(external?.renderChargeCount, 1);
  assert.equal(external?.settledTotalCredits, 0);
  assert.ok(external?.externalCharges[0].includes("เครื่องมือภายนอก"));
  assert.deepEqual(external, await getVideoJobCostReceipt({ videoJobId: "external-root", userId }));
  assert.equal((await getVideoJobCostReceipt({ videoJobId: "root", userId }))?.imageCredits, 2);
  const { getVideoJobStatusTool } = await import("../src/lib/mcp/tools");
  const delivered = await getVideoJobStatusTool(userId, "free-export-2");
  assert.equal(delivered?.status, "done");
  assert.equal(delivered?.billingReceipt?.includedRenderMinutes, 2);
  assert.equal(await getVideoJobStatusTool("foreign", "external-root"), null);
  // Execute the actual registered route callback with only the MCP/Clerk transport
  // stubbed. This specifically covers the budget-hold early return, not a source scan.
  const registered = new Map<string, (args: { id: string }, extra: unknown) => Promise<{ content: { text: string }[] }>>();
  const requireLocal = createRequire(import.meta.url);
  const routeFile = join(process.cwd(), "src/app/api/[transport]/route.ts");
  const routeModule = { exports: {} };
  const routeRequire = (specifier: string) => {
    if (specifier === "mcp-handler") return {
      createMcpHandler: (register: (server: unknown) => void) => {
        register({ server: { _requestHandlers: new Map([["tools/call", () => undefined]]) }, setToolRequestHandlers: () => undefined, registerTool: (name: string, _definition: unknown, callback: never) => registered.set(name, callback) });
        return async () => new Response();
      },
      withMcpAuth: (handler: unknown) => handler,
    };
    if (specifier === "@clerk/nextjs/server") return { auth: async () => { throw new Error("No Clerk in receipt fixture"); } };
    if (specifier === "@clerk/mcp-tools/next") return { verifyClerkToken: async () => undefined };
    return requireLocal(specifier.startsWith("@/") ? join(process.cwd(), "src", specifier.slice(2)) : specifier);
  };
  const compiled = ts.transpileModule(readFileSync(routeFile, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  new Function("require", "module", "exports", compiled)(routeRequire, routeModule, routeModule.exports);
  await prisma.videoJob.update({ where: { id: "root" }, data: { status: "confirmation_required", budgetCheckpointJson: JSON.stringify({ hold: { reason: "image_poll_unknown" } }) } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const heldReply = await registered.get("get_video_status")!({ id: "root" }, { authInfo: { extra: { userId, user, effectivePlan: "PRO" } } });
  const heldStatus = JSON.parse(heldReply.content[0].text);
  assert.equal(heldStatus.status, "confirmation_required");
  assert.ok(heldStatus.billingReceipt, "budget hold early return must include current durable billing receipt");
  assert.equal(heldStatus.billingReceipt.confirmedRefundCredits, 2);
  assert.equal(heldStatus.retainedCheckpoint, true);
  assert.ok(heldStatus.next.includes("ผู้ให้บริการ"));
  await prisma.$disconnect();
  console.log("PASS spending summary: durable images/refund helpers, transferred render, trial, approvals, descendant, pending, ownership");
}
main().catch(error => { console.error(error); process.exit(1); });
