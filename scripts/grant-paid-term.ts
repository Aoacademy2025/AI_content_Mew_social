// Convert an off-Stripe (bank-transfer) customer to a real paid TIMED plan — sets a
// future expiry from their payment date and CLEARS the trial flag so the entitlement
// classifier stops auto-reverting them to FREE. DRY-RUN by default; pass --apply to write.
//
// Run on PROD (inside /var/www/ai-content, prod .env supplies DATABASE_URL):
//   npx tsx scripts/grant-paid-term.ts --email taononchannel@gmail.com --days 365 --from 2026-06-25
//   npx tsx scripts/grant-paid-term.ts --email taononchannel@gmail.com --days 365 --from 2026-06-25 --apply
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { markUserPaid, type PaidPlan } from "../src/lib/paid-term";
import { classifyEntitlement } from "../src/lib/entitlements";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const email = arg("email");
  const plan = (arg("plan") ?? "PRO").toUpperCase() as PaidPlan;
  const days = parseInt(arg("days") ?? "365", 10);
  const fromStr = arg("from");
  const apply = has("apply");

  if (!email) { console.error("Missing --email"); process.exit(1); }
  if (plan !== "PRO" && plan !== "BUSINESS") { console.error(`Invalid --plan ${plan} (PRO|BUSINESS)`); process.exit(1); }
  if (!Number.isFinite(days) || days <= 0) { console.error(`Invalid --days ${days}`); process.exit(1); }
  const from = fromStr ? new Date(fromStr) : new Date();
  if (isNaN(from.getTime())) { console.error(`Invalid --from ${fromStr} (use YYYY-MM-DD)`); process.exit(1); }
  const billingPeriod = days >= 365 ? "annual" : "monthly";

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }

  const before = {
    plan: user.plan, planExpiresAt: user.planExpiresAt, trialEndsAt: user.trialEndsAt,
    trialStartedAt: user.trialStartedAt, subStatus: user.subStatus, billingPeriod: user.billingPeriod,
  };
  console.log(`\n${email}  (${user.name})`);
  console.log("BEFORE:", JSON.stringify(before, null, 2));
  console.log("BEFORE entitlement:", classifyEntitlement(user as any).action,
    `(${classifyEntitlement(user as any).source})`);

  const targetExpiry = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  console.log(`\nPLAN: ${plan}  •  TERM: ${days}d (${billingPeriod})  •  FROM: ${from.toISOString().slice(0, 10)}  →  EXPIRES: ${targetExpiry.toISOString().slice(0, 10)}`);

  if (!apply) {
    console.log("\n⚠️  DRY RUN — nothing written. Re-run with --apply to commit.");
    await prisma.$disconnect();
    return;
  }

  await markUserPaid(user.id, { plan, periodDays: days, from, billingPeriod });
  const after = await prisma.user.findUnique({ where: { id: user.id } });
  console.log("\n✅ APPLIED. AFTER:", JSON.stringify({
    plan: after!.plan, planExpiresAt: after!.planExpiresAt, trialEndsAt: after!.trialEndsAt,
    trialStartedAt: after!.trialStartedAt, subStatus: after!.subStatus,
    usageCount: after!.usageCount, usageLimit: after!.usageLimit,
  }, null, 2));
  console.log("AFTER entitlement:", classifyEntitlement(after as any).action,
    `(${classifyEntitlement(after as any).source})`, "→ will KEEP until", after!.planExpiresAt?.toISOString().slice(0, 10));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
