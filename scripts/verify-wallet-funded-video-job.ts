// Regression checks for job-scoped managed-AI access backed by a real render
// reservation. Standalone FREE AI calls remain capped; the same calls inside a
// funded VideoJob may cross the invisible monthly guard without unlocking paid
// product features.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wallet-video-job-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.CREDITS_LIVE = "1";
process.env.MINUTE_QUOTA = "1";
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { grantCredits, getBalance } = await import("../src/lib/credits");
  const videoJobs = await import("../src/lib/mcp/video-job");
  const funding = await import("../src/lib/mcp/video-job-funding");
  const { reserveAiAudioMinutes } = await import("../src/lib/ai-spend-limits");
  const { reserveAiTextCall } = await import("../src/lib/ai-text-limits");

  const now = new Date();
  const user = await prisma.user.create({
    data: {
      id: "wallet-job-user",
      name: "Wallet Job",
      email: "wallet-job@example.test",
      plan: "FREE",
      usagePeriodStartedAt: now,
      minutesLimit: 5,
      minutesUsed: 5,
      aiAudioMinutesUsed: 10,
      aiTextCallsUsed: 125,
    },
  });
  await grantCredits(user.id, 200, "purchase", "pack:wallet-job");

  const standaloneAudio = await reserveAiAudioMinutes(user.id, 1, { enforce: true });
  const standaloneText = await reserveAiTextCall(user.id, { enforce: true });
  assert.equal(standaloneAudio.allowed, false, "standalone FREE audio stays capped");
  assert.equal(standaloneText.allowed, false, "standalone FREE text stays capped");

  const job = await videoJobs.createVideoJob(
    user.id,
    { script: "ทดสอบ", previewMode: true, stockSource: "stock" },
    "wallet-job-key",
    {
      funding: { meteredMinutes: 2, creditsLive: true },
    } as never,
  );
  assert.equal((job as unknown as { fundingState?: string }).fundingState, "reserved");
  assert.equal((job as unknown as { fundedMeteredMinutes?: number }).fundedMeteredMinutes, 2);
  assert.equal((job as unknown as { fundedCreditsSpent?: number }).fundedCreditsSpent, 4);
  assert.equal((await getBalance(user.id)).purchased, 196, "job reserves four credits before managed AI runs");

  const access = await funding.walletFundingForVideoJob(job.id, user.id);
  assert.equal(access.allowed, true, "server validates the job-scoped wallet reservation");

  const fundedAudio = await reserveAiAudioMinutes(user.id, 1, {
    enforce: true,
    allowOverCeiling: access.allowed,
  } as never);
  const fundedText = await reserveAiTextCall(user.id, {
    enforce: true,
    allowOverCeiling: access.allowed,
  } as never);
  assert.equal(fundedAudio.allowed, true, "funded render can run required managed audio past FREE ceiling");
  assert.equal(fundedText.allowed, true, "funded render can run required managed text past FREE ceiling");

  await funding.refundVideoJobFunding(job.id, user.id, "test-no-output");
  assert.equal((await getBalance(user.id)).purchased, 200, "failed job restores the exact wallet reservation");
  const refunded = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal((refunded as unknown as { fundingState?: string }).fundingState, "refunded");

  const mixed = await prisma.user.create({
    data: {
      id: "mixed-wallet-job-user",
      name: "Mixed Wallet Job",
      email: "mixed-wallet-job@example.test",
      plan: "FREE",
      usagePeriodStartedAt: now,
      minutesLimit: 5,
      minutesUsed: 4,
    },
  });
  await grantCredits(mixed.id, 200, "purchase", "pack:mixed-wallet-job");
  const mixedJob = await videoJobs.createVideoJob(
    mixed.id,
    { script: "ทดสอบแบบผสม" },
    "mixed-wallet-job-key",
    { funding: { meteredMinutes: 2, creditsLive: true } } as never,
  );
  assert.equal((await getBalance(mixed.id)).purchased, 198, "mixed job charges only one overflow minute");
  await funding.reconcileVideoJobFunding(mixedJob.id, mixed.id, 1);
  assert.equal((await getBalance(mixed.id)).purchased, 200, "shorter output refunds the unused credit-funded tail");
  const trimmed = await prisma.videoJob.findUniqueOrThrow({ where: { id: mixedJob.id } });
  assert.equal(trimmed.fundedMeteredMinutes, 1);
  assert.equal(trimmed.fundedCreditsSpent, 0);
  assert.equal(
    (await funding.walletFundingForVideoJob(mixedJob.id, mixed.id)).allowed,
    true,
    "returning an unused credit tail does not revoke permission to finish the same funded job",
  );
  const transfer = await funding.transferVideoJobFundingToRender(mixedJob.id, mixed.id, 1);
  assert.equal(transfer.transferred, true, "exact reconciled reservation transfers to render once");
  assert.equal(
    (await funding.transferVideoJobFundingToRender(mixedJob.id, mixed.id, 1)).transferred,
    false,
    "transfer is idempotent",
  );

  const longer = await prisma.user.create({
    data: {
      id: "long-wallet-job-user",
      name: "Long Wallet Job",
      email: "long-wallet-job@example.test",
      plan: "FREE",
      usagePeriodStartedAt: now,
      minutesLimit: 5,
      minutesUsed: 5,
    },
  });
  await grantCredits(longer.id, 200, "purchase", "pack:long-wallet-job");
  const longerJob = await videoJobs.createVideoJob(
    longer.id,
    { script: "ทดสอบเสียงยาวกว่าที่อนุมัติ" },
    "long-wallet-job-key",
    { funding: { meteredMinutes: 2, creditsLive: true } } as never,
  );
  await assert.rejects(
    funding.reconcileVideoJobFunding(longerJob.id, longer.id, 3),
    (error: unknown) => (error as { code?: string }).code === "render_confirmation_required",
    "longer output requires fresh confirmation instead of silently charging more",
  );
  assert.equal((await getBalance(longer.id)).purchased, 200, "duration increase restores the whole reservation");
  assert.equal(
    (await prisma.videoJob.findUniqueOrThrow({ where: { id: longerJob.id } })).fundingState,
    "refunded",
  );

  await prisma.$disconnect();
  console.log("Wallet-funded VideoJob verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
