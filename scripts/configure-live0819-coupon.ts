import { prisma } from "../src/lib/prisma";

const CODE = "CLIP0819";
const TARGET_EXPIRY = new Date("2026-08-21T16:59:59.000Z");

async function main() {
  const apply = process.argv.includes("--apply");
  const enable = process.argv.includes("--enable");
  if (enable && process.env.LIVE0819_ENABLE !== "YES") {
    throw new Error("Refusing to enable: set LIVE0819_ENABLE=YES and pass --apply --enable after production smoke");
  }
  const before = await prisma.coupon.findUnique({ where: { code: CODE } });
  if (!before) throw new Error(`${CODE} not found`);
  if (before.usedCount !== 0) throw new Error(`${CODE} already has ${before.usedCount} redemptions; refusing to rewrite campaign config`);

  const target = {
    plan: "PRO" as const,
    type: "GRANT",
    durationDays: 30,
    maxUses: 500,
    expiresAt: TARGET_EXPIRY,
    stackingPolicy: "SAFE_APPEND",
    promoCredits: 50,
    promoCreditTtlDays: 30,
    isActive: enable,
  };
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", before, target }, null, 2));
  if (!apply) return;

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.coupon.update({ where: { id: before.id }, data: target });
    await tx.couponAuditLog.create({
      data: {
        couponId: before.id,
        actorUserId: "ops:live0819",
        action: enable ? "ENABLE" : "UPDATE",
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(updated),
      },
    });
    return updated;
  });
  console.log(JSON.stringify({ applied: true, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
