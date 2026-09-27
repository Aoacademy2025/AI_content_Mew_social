// Run against a throwaway SQLite database with socket_timeout=1 after prisma db push.
// A wallet read must not compete with an unrelated writer for SQLite's single write lock.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const url = process.env.DATABASE_URL ?? "";
assert.match(url, /\/test-[^/?]+\.db\?/, "use a throwaway test-*.db file");
assert.match(url, /socket_timeout=1(?:&|$)/, "use a throwaway DB with socket_timeout=1");
const existingId = "hero10-existing-wallet";
const missingId = "hero10-missing-wallet";

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const { prisma } = await import("../src/lib/prisma");
  const { getBalance } = await import("../src/lib/credits");
  const holder = new PrismaClient({ datasourceUrl: url });
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.creditBalance.deleteMany({ where: { userId: { in: [existingId, missingId] } } });
  await prisma.creditBalance.create({ data: { userId: existingId, purchased: 7 } });

  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const heldWrite = holder.$transaction(async (tx) => {
    await tx.creditBalance.update({ where: { userId: existingId }, data: { granted: 1 } });
    signalReady();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }, { timeout: 4_000 });
  await ready;

  try {
    const existingStart = performance.now();
    const existing = await getBalance(existingId);
    assert.equal(existing.purchased, 7);
    assert.ok(performance.now() - existingStart < 700, "existing wallet read must bypass the writer");

    const missingStart = performance.now();
    let missing;
    try {
      missing = await getBalance(missingId);
    } catch (error) {
      throw new Error("new-user balance read blocked by unrelated SQLite writer", { cause: error });
    }
    assert.deepEqual(missing, { granted: 0, promotional: 0, purchased: 0, total: 0 });
    assert.ok(performance.now() - missingStart < 700, "missing wallet read must bypass the writer");
    assert.equal(await prisma.creditBalance.count({ where: { userId: missingId } }), 0);
    console.log("verify-credit-balance-read-under-lock: PASS");
  } finally {
    await heldWrite;
    await holder.$disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
