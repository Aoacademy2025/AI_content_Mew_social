// Verifies task 1 of docs/plans/2026-08-07-hero-ai-image-p0-launch.md:
//   Hero AI Image reprice 3cr -> 2cr + the custom-route cost estimate fix that
//   keeps the quote inside the new, tighter cost-safety budget.
//
// Run via: node --conditions=react-server --import tsx scripts/verify-hero-image-price.ts
// (the react-server condition is required so the "server-only"-tagged modules
// this script exercises — image-generation-provider.server.ts / video-hero-image.server.ts —
// resolve to their no-op stub instead of throwing; see package.json's existing
// sync:runpod-image-cost / ops:refund-* scripts for the same pattern.)
//
// DATABASE_URL is pointed at a throwaway temp SQLite file BEFORE any module that
// transitively imports src/lib/prisma.ts is loaded, so the cached PrismaClient
// singleton never touches the real dev.db.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  // ── 1. Point DATABASE_URL at a throwaway SQLite file first, before anything
  //      that transitively constructs the shared PrismaClient is imported. ──
  const dbDir = mkdtempSync(join(tmpdir(), "hero-image-price-db-"));
  process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  // ── 2. Wire a fake RunPod custom route so describeHeroImageOffer() resolves
  //      providerRoute === "runpod-custom" (the route Task 1's estimate fix
  //      targets) without needing a live RunPod endpoint. ──
  const workflowDir = mkdtempSync(join(tmpdir(), "hero-image-workflow-"));
  const workflowPath = join(workflowDir, "z-image-turbo.json");
  writeFileSync(
    workflowPath,
    JSON.stringify({
      input: {
        prompt: "{{PROMPT}}",
        negative_prompt: "{{NEGATIVE_PROMPT}}",
        width: "{{WIDTH}}",
        height: "{{HEIGHT}}",
        seed: "{{SEED}}",
      },
    }),
    "utf8",
  );
  process.env.AI_STUDIO_IMAGE_ENABLED = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.RUNPOD_API_KEY = "verify-hero-image-price-test-key";
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "custom";
  process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = "verify-hero-image-price-endpoint";
  process.env.RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH = workflowPath;
  // Deliberately unset: exercise the *default* fallback inside customRouteEstimate(),
  // not an env override, so this proves the code's own default is cost-safe.
  delete process.env.AI_IMAGE_Z_IMAGE_TURBO_ESTIMATED_COST_USD_MICROS;

  let failures = 0;
  function check(name: string, condition: boolean) {
    if (condition) console.log(`  PASS  ${name}`);
    else { failures += 1; console.error(`  FAIL  ${name}`); }
  }

  // ── 3. Cost-key + constant repriced to 2. ──
  const { creditCostFor, HERO_AI_IMAGE_CREDITS } = await import("../src/lib/credit-costs");
  check(
    'creditCostFor("image-open-custom-1k") === 2',
    creditCostFor("image-open-custom-1k") === 2,
  );
  check("HERO_AI_IMAGE_CREDITS === 2", (HERO_AI_IMAGE_CREDITS as number) === 2);

  // ── 4. Pure cost-policy math: budget at 2cr, and the new 10,000 estimate fits. ──
  const { imageProviderCostBudgetUsdMicros, isAiImageQuoteCostSafe } = await import(
    "../src/lib/ai-image-cost-policy"
  );
  const budget = imageProviderCostBudgetUsdMicros(2);
  check("imageProviderCostBudgetUsdMicros(2) === 38,888", budget === 38_888);
  check("10,000 <= budget (new estimate fits the 2cr envelope)", 10_000 <= budget);

  // ── 5. Real offer path: describeHeroImageOffer() on the custom route. ──
  const { describeHeroImageOffer } = await import("../src/lib/video-hero-image.server");
  const offer = describeHeroImageOffer();
  check("offer.providerRoute === runpod-custom", offer.providerRoute === "runpod-custom");
  check("offer.quote.credits === 2", offer.quote.credits === 2);
  check(
    "offer.quote.estimatedProviderCostUsdMicros === 10,000 (new default, no env override set)",
    offer.quote.estimatedProviderCostUsdMicros === 10_000,
  );
  check("isAiImageQuoteCostSafe(offer.quote) === true", isAiImageQuoteCostSafe(offer.quote) === true);
  check("offer.available === true", offer.available === true);

  // ── 6. DB round-trip: reserve exactly 2 credits (granted-first across a
  //      partially-empty granted bucket), then refund exactly 2 to the same
  //      buckets on failure. ──
  const { prisma } = await import("../src/lib/prisma");
  const { createReservedImageJob, failAndRefundAiJob } = await import(
    "../src/lib/ai-generation-jobs.server"
  );

  const user = await prisma.user.create({
    data: { name: "Hero Image Price Verify", email: "hero-image-price-verify@example.invalid" },
  });
  // granted=1 < creditCost=2 forces the reservation to draw the remaining
  // credit from purchased, proving the granted-first split.
  await prisma.creditBalance.create({ data: { userId: user.id, granted: 1, purchased: 5 } });

  const reserved = await createReservedImageJob({
    userId: user.id,
    model: "z-image-turbo",
    inputPreview: "verify hero image price",
    inputJson: "{}",
    creditCost: offer.quote.credits,
    quoteVersion: offer.quote.version,
    costBudgetUsdMicros: offer.quote.costBudgetUsdMicros,
    provider: offer.provider,
    providerModel: offer.providerModel,
    providerRoute: offer.providerRoute,
    providerEndpoint: offer.providerEndpoint,
    estimatedCostUsdMicros: offer.quote.estimatedProviderCostUsdMicros,
    idempotencyKey: "video:verify-hero-image-price:scene:0",
    mediaExpiresAt: new Date(Date.now() + 60_000),
  });
  if (!reserved.ok) throw new Error("expected the 2cr reservation to succeed against a 6-credit balance");

  check("reserved.job.creditCost === 2", reserved.job.creditCost === 2);
  check(
    "reserved.job.creditsFromGranted === 1 (granted-first, bucket only had 1)",
    reserved.job.creditsFromGranted === 1,
  );
  check(
    "reserved.job.creditsFromPurchased === 1 (remainder from purchased)",
    reserved.job.creditsFromPurchased === 1,
  );

  const afterReserve = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: user.id } });
  check("balance.granted === 0 after reserving", afterReserve.granted === 0);
  check("balance.purchased === 4 after reserving", afterReserve.purchased === 4);

  const refunded = await failAndRefundAiJob(
    user.id,
    reserved.job.id,
    "VERIFY_TEST_FAILURE",
    "synthetic failure injected by verify-hero-image-price.ts",
  );
  check("failAndRefundAiJob returns the job", refunded !== null);
  check("refunded job.chargeState === refunded", refunded?.chargeState === "refunded");

  const afterRefund = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: user.id } });
  check("balance.granted === 1 after refund (restored to the granted bucket)", afterRefund.granted === 1);
  check("balance.purchased === 5 after refund (restored to the purchased bucket)", afterRefund.purchased === 5);

  // ── 7. A pre-job credit rejection must be observable even though no durable
  //      AiGenerationJob is created. This is the gap that made launch-day 402s
  //      invisible in the job/error audit.
  const shortUser = await prisma.user.create({
    data: { name: "Hero Image Credit Reject Verify", email: "hero-image-reject-verify@example.invalid" },
  });
  await prisma.creditBalance.create({ data: { userId: shortUser.id, granted: 1, purchased: 0 } });
  const rejected = await createReservedImageJob({
    userId: shortUser.id,
    model: "z-image-turbo",
    inputPreview: "must not be copied to telemetry",
    inputJson: "{}",
    creditCost: offer.quote.credits,
    quoteVersion: offer.quote.version,
    costBudgetUsdMicros: offer.quote.costBudgetUsdMicros,
    provider: offer.provider,
    providerModel: offer.providerModel,
    providerRoute: offer.providerRoute,
    providerEndpoint: offer.providerEndpoint,
    estimatedCostUsdMicros: offer.quote.estimatedProviderCostUsdMicros,
    idempotencyKey: "video:verify-credit-reject:scene:0",
    mediaExpiresAt: new Date(Date.now() + 60_000),
  });
  check("a 1-credit balance is rejected before job creation", !rejected.ok && rejected.balanceAfter === 1);
  const rejectionEvent = await prisma.telemetryEvent.findFirst({
    where: { userId: shortUser.id, name: "ai_image_credit_reservation_rejected" },
  });
  check("credit rejection writes server error telemetry despite having no job row", rejectionEvent !== null);
  check(
    "credit rejection telemetry carries required/available/model/surface without prompt text",
    rejectionEvent?.status === "insufficient_credits"
      && rejectionEvent.properties?.includes('"requiredCredits":2') === true
      && rejectionEvent.properties?.includes('"availableCredits":1') === true
      && rejectionEvent.properties?.includes('"model":"z-image-turbo"') === true
      && rejectionEvent.properties?.includes('"surface":"video"') === true
      && !rejectionEvent.properties?.includes("must not be copied"),
  );

  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
