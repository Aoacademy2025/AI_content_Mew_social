import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "administrator-grants-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string) {
  if (condition) { passed += 1; console.log(`ok: ${label}`); }
  else { failed += 1; console.error(`FAIL: ${label}`); }
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    AdministratorGrantInputError,
    createAdministratorGrant,
    revokeAdministratorGrants,
  } = await import("../src/lib/administrator-grant.server");
  const { resolvePaidEquivalentEntitlement } = await import("../src/lib/paid-equivalent-entitlement.server");
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  const [admin, target] = await Promise.all([
    prisma.user.create({ data: { id: "admin", name: "Admin", email: "admin@example.com", role: "ADMIN" } }),
    prisma.user.create({ data: { id: "target", name: "Target", email: "target@example.com", plan: "BUSINESS" } }),
  ]);
  const before = await resolvePaidEquivalentEntitlement(target.id, now);
  check(!before.canUsePaidFeatures, "raw BUSINESS plan has no entitlement evidence");

  let invalidRejected = false;
  try {
    await createAdministratorGrant({
      userId: target.id, plan: "PRO", reason: "", expiresAt: tomorrow,
      permanent: false, grantedById: admin.id,
    }, now);
  } catch (error) {
    invalidRejected = error instanceof AdministratorGrantInputError;
  }
  check(invalidRejected, "grant requires an auditable reason");

  const grant = await createAdministratorGrant({
    userId: target.id,
    plan: "BUSINESS",
    reason: "course student cohort",
    expiresAt: tomorrow,
    permanent: false,
    grantedById: admin.id,
  }, now);
  const active = await resolvePaidEquivalentEntitlement(target.id, now);
  check(active.source === "administrator_grant" && active.effectivePlan === "BUSINESS",
    "valid Administrator Grant unlocks paid-equivalent capabilities");

  const revoked = await revokeAdministratorGrants({
    userId: target.id, revokedById: admin.id, reason: "course access ended",
  }, new Date(now.getTime() + 1_000));
  check(revoked === 1, "revoke closes exactly one active grant");
  const after = await resolvePaidEquivalentEntitlement(target.id, new Date(now.getTime() + 2_000));
  check(!after.canUsePaidFeatures, "revoked grant fails closed immediately");
  const audit = await prisma.administratorGrant.findUnique({ where: { id: grant.id } });
  check(Boolean(audit?.revokedAt && audit.revokedById === admin.id && audit.revokeReason),
    "revocation preserves grant, actor, timestamp, and reason for audit");

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
