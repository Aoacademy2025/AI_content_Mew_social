import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "mcp-billing-receipt-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getVideoJobBillingReceipt } = await import("../src/lib/mcp/billing-receipt");

  const user = await prisma.user.create({
    data: { id: "receipt-user", name: "Receipt", email: "receipt@example.com", plan: "PRO" },
  });

  await prisma.renderJob.createMany({
    data: [
      {
        id: "minute-base",
        userId: user.id,
        parentJobId: "minute-video-job",
        type: "RENDER",
        status: "DONE",
        payload: "{}",
        reservedQuota: true,
        reservedMinutes: 2,
      },
      {
        id: "minute-burn",
        userId: user.id,
        parentJobId: "minute-video-job",
        type: "BURN",
        status: "DONE",
        payload: "{}",
        reservedQuota: false,
      },
      {
        id: "credit-base",
        userId: user.id,
        parentJobId: "credit-video-job",
        type: "RENDER",
        status: "DONE",
        payload: "{}",
        reservedQuota: true,
        reservedMinutes: 3,
        creditsSpent: 6,
      },
    ],
  });

  assert.deepEqual(
    await getVideoJobBillingReceipt({ videoJobId: "minute-video-job", userId: user.id }),
    { status: "settled", funding: "minutes", renderMinutes: 2, chargedMinutes: 2, chargedCredits: 0 },
  );
  console.log("✓ minute-funded success reports one exact charge");

  assert.deepEqual(
    await getVideoJobBillingReceipt({ videoJobId: "credit-video-job", userId: user.id }),
    { status: "settled", funding: "credits", renderMinutes: 3, chargedMinutes: 0, chargedCredits: 6 },
  );
  console.log("✓ credit overflow reports duration and exact credits without claiming minutes were charged");

  await prisma.renderJob.createMany({
    data: [
      {
        id: "double-base",
        userId: user.id,
        parentJobId: "double-video-job",
        type: "RENDER",
        status: "DONE",
        payload: "{}",
        reservedQuota: true,
        reservedMinutes: 1,
      },
      {
        id: "double-burn",
        userId: user.id,
        parentJobId: "double-video-job",
        type: "BURN",
        status: "DONE",
        payload: "{}",
        reservedQuota: true,
        reservedMinutes: 1,
      },
    ],
  });
  assert.deepEqual(
    await getVideoJobBillingReceipt({ videoJobId: "double-video-job", userId: user.id }),
    { status: "error", code: "multiple_active_charges", activeCharges: 2 },
  );
  console.log("✓ double charge fails closed");

  assert.deepEqual(
    await getVideoJobBillingReceipt({ videoJobId: "missing-video-job", userId: user.id }),
    { status: "error", code: "missing_active_charge", activeCharges: 0 },
  );
  console.log("✓ missing charge fails closed");

  await prisma.$disconnect();
  console.log("\n✅ ALL 4 MCP BILLING RECEIPT CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
