// Proof of the clip-quota fail-fast contract (PR-1). Run against a throwaway SQLite DB
// with an ABSOLUTE path (Prisma CLI resolves relative file: paths vs the schema dir;
// runtime vs cwd — they must agree):
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-quota.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-quota.db?connection_limit=1" npx tsx scripts/verify-clip-quota.ts
import { prisma } from "../src/lib/prisma";
import { checkClipQuota, refundClipUsage, reserveClipUsage } from "../src/lib/usage-limits";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

async function main() {
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { name: "quota-user", email: "quota@t.test", plan: "FREE" } });

  // Fresh FREE user: peek allows and does NOT consume
  let peek = await checkClipQuota(u.id);
  assert(peek !== null && peek.allowed === true, "checkClipQuota allows a fresh FREE user");
  let row = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row!.usageCount === 0, "checkClipQuota did NOT increment usageCount (read-only)");

  // Reserve up to the FREE limit (2 clips / 30 days)
  const r1 = await reserveClipUsage(u.id);
  assert(r1 !== null && r1.allowed === true && r1.usageCount === 1, "reserve #1 allowed (1/2)");
  const r2 = await reserveClipUsage(u.id);
  assert(r2 !== null && r2.allowed === true && r2.usageCount === 2, "reserve #2 allowed (2/2)");

  // Exhausted: peek refuses with the Thai quota message and still does not mutate
  peek = await checkClipQuota(u.id);
  assert(peek !== null && peek.allowed === false, "checkClipQuota refuses when quota exhausted");
  assert(peek !== null && peek.allowed === false && peek.message.includes("จำกัด"), "refusal carries the Thai quota message");
  row = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row!.usageCount === 2, "exhausted peek did not change usageCount");

  // Reserve also refuses (atomic guard) and does not over-increment
  const r3 = await reserveClipUsage(u.id);
  assert(r3 !== null && r3.allowed === false, "reserve refuses when quota exhausted");
  row = await prisma.user.findUnique({ where: { id: u.id } });
  assert(row!.usageCount === 2, "refused reserve did not over-increment");

  // Refund frees a slot; peek allows again
  await refundClipUsage(u.id);
  peek = await checkClipQuota(u.id);
  assert(peek !== null && peek.allowed === true, "after refund, checkClipQuota allows again");

  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} CLIP-QUOTA CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
