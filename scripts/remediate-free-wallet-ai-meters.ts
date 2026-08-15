/**
 * One-account remediation for a stale managed-AI window after paid → FREE.
 *
 * Dry-run (default):
 *   DATABASE_URL=... npx tsx scripts/remediate-free-wallet-ai-meters.ts --email=user@example.com
 * Apply after the fixed release is live:
 *   DATABASE_URL=... npx tsx scripts/remediate-free-wallet-ai-meters.ts --email=user@example.com --expected-purchased=200 --apply
 *
 * This intentionally does not modify plan, render minutes, credit buckets,
 * ledger, payments, jobs, or support tickets.
 */
import { prisma } from "../src/lib/prisma";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const email = argValue("email")?.trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  const expectedPurchasedRaw = argValue("expected-purchased") ?? "200";
  const expectedPurchased = Number(expectedPurchasedRaw);
  if (!email || !email.includes("@")) throw new Error("required: --email=user@example.com");
  if (!Number.isInteger(expectedPurchased) || expectedPurchased < 0) {
    throw new Error("--expected-purchased must be a non-negative integer");
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      plan: true,
      minutesUsed: true,
      minutesLimit: true,
      aiAudioMinutesUsed: true,
      aiTextCallsUsed: true,
      supportTickets: {
        where: { status: "OPEN" },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!user) throw new Error("account not found");
  const creditBalance = await prisma.creditBalance.findUnique({ where: { userId: user.id } });
  if (user.plan !== "FREE") throw new Error(`safety stop: expected FREE, found ${user.plan}`);
  const purchased = creditBalance?.purchased ?? 0;
  if (purchased !== expectedPurchased) {
    throw new Error(`safety stop: expected purchased=${expectedPurchased}, found ${purchased}`);
  }

  const snapshot = {
    email: user.email,
    plan: user.plan,
    renderMinutes: `${user.minutesUsed}/${user.minutesLimit}`,
    aiAudioMinutesUsed: user.aiAudioMinutesUsed,
    aiTextCallsUsed: user.aiTextCallsUsed,
    grantedCredits: creditBalance?.granted ?? 0,
    purchasedCredits: purchased,
    openTicketIds: user.supportTickets.map((ticket) => ticket.id),
  };
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", before: snapshot }, null, 2));
  if (!apply) return;

  const updated = await prisma.user.updateMany({
    where: {
      id: user.id,
      plan: "FREE",
      aiAudioMinutesUsed: user.aiAudioMinutesUsed,
      aiTextCallsUsed: user.aiTextCallsUsed,
    },
    data: { aiAudioMinutesUsed: 0, aiTextCallsUsed: 0 },
  });
  if (updated.count !== 1) throw new Error("safety stop: account changed during remediation");

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      plan: true,
      minutesUsed: true,
      minutesLimit: true,
      aiAudioMinutesUsed: true,
      aiTextCallsUsed: true,
    },
  });
  const afterCreditBalance = await prisma.creditBalance.findUnique({ where: { userId: user.id } });
  if (
    after.plan !== user.plan
    || after.minutesUsed !== user.minutesUsed
    || after.minutesLimit !== user.minutesLimit
    || (afterCreditBalance?.granted ?? 0) !== (creditBalance?.granted ?? 0)
    || (afterCreditBalance?.purchased ?? 0) !== purchased
  ) {
    throw new Error("postcondition failed: remediation changed plan, minutes, or credits");
  }
  console.log(JSON.stringify({
    applied: true,
    after: {
      aiAudioMinutesUsed: after.aiAudioMinutesUsed,
      aiTextCallsUsed: after.aiTextCallsUsed,
      purchasedCredits: afterCreditBalance?.purchased ?? 0,
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
