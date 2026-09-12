import assert from "node:assert/strict";

/**
 * B6 row 1 — `/api/notifications` GET does a full `SCAN main.Notification`
 * in production (A1b §A1.5 row 9: 16,537 rows, PK only) because the model
 * carries no `@@index` beyond its primary key (A3 §A3.7 item 9). This proves
 * the exact statement Prisma emits for that route now resolves to a `SEARCH`
 * on an index instead of a table scan, and that the same index also serves
 * the PATCH ("mark all as read") / DELETE ("clear all") handlers, which
 * filter on `userId` alone — so one composite index covers every shape the
 * route issues; no second index is needed.
 *
 * Runs against a throwaway SQLite database; see `verify:notification-index`
 * for the `prisma db push` that creates it.
 */

type PlanRow = { detail: string };

async function main() {
  assert(
    process.env.DATABASE_URL?.includes("notification-index"),
    "refusing to run against anything but the throwaway database",
  );

  const { prisma } = await import("../src/lib/prisma");

  await prisma.notification.deleteMany();
  await prisma.user.deleteMany();

  const userA = await prisma.user.create({
    data: { name: "notif-a", email: "notif-index-a@t.test" },
  });
  const userB = await prisma.user.create({
    data: { name: "notif-b", email: "notif-index-b@t.test" },
  });

  const types = [
    "VIDEO_COMPLETED",
    "VIDEO_FAILED",
    "LIMIT_WARNING",
    "LIMIT_REACHED",
    "NEW_USER",
    "ERROR_SYSTEM",
  ] as const;

  // ~50 rows split across two users so the plan is exercised against a
  // multi-user table, not a single-row degenerate case.
  for (let i = 0; i < 50; i++) {
    await prisma.notification.create({
      data: {
        userId: i % 2 === 0 ? userA.id : userB.id,
        type: types[i % types.length],
        title: `t${i}`,
        body: `b${i}`,
        read: i % 3 === 0,
      },
    });
  }

  // §A3.7 item 9 — verbatim shape `/api/notifications` GET emits
  // (userId equality + NOT type residual filter, ORDER BY createdAt DESC).
  const getPlan = await prisma.$queryRawUnsafe<PlanRow[]>(
    `EXPLAIN QUERY PLAN SELECT "id","userId","type","title","body","link","read","createdAt" FROM "Notification" WHERE ("userId" = ? AND NOT "type" = ?) ORDER BY "createdAt" DESC LIMIT ? OFFSET ?`,
    userA.id,
    "ERROR_SYSTEM",
    50,
    0,
  );
  const getDetails = getPlan.map((row) => row.detail).join(" | ");
  console.log("[verify-notification-index] GET plan:", getDetails);

  assert(
    /USING (COVERING )?INDEX/.test(getDetails),
    `expected the GET shape to SEARCH using an index, got: ${getDetails}`,
  );
  assert(
    !/SCAN .*Notification/i.test(getDetails),
    `expected no full-table SCAN on Notification, got: ${getDetails}`,
  );
  assert(
    !/TEMP B-TREE FOR ORDER BY/.test(getDetails),
    `expected the index to satisfy ORDER BY createdAt without an extra sort, got: ${getDetails}`,
  );

  // PATCH ("mark all as read") — filters on userId + read, no orderBy.
  const patchPlan = await prisma.$queryRawUnsafe<PlanRow[]>(
    `EXPLAIN QUERY PLAN UPDATE "Notification" SET "read" = 1 WHERE ("userId" = ? AND "read" = 0)`,
    userA.id,
  );
  const patchDetails = patchPlan.map((row) => row.detail).join(" | ");
  console.log("[verify-notification-index] PATCH plan:", patchDetails);
  assert(
    /USING (COVERING )?INDEX/.test(patchDetails),
    `expected the PATCH shape (userId leading column) to also use the index, got: ${patchDetails}`,
  );
  assert(
    !/SCAN .*Notification/i.test(patchDetails),
    `expected no full-table SCAN on Notification for PATCH, got: ${patchDetails}`,
  );

  // DELETE ("clear all") — filters on userId alone.
  const deletePlan = await prisma.$queryRawUnsafe<PlanRow[]>(
    `EXPLAIN QUERY PLAN DELETE FROM "Notification" WHERE "userId" = ?`,
    userB.id,
  );
  const deleteDetails = deletePlan.map((row) => row.detail).join(" | ");
  console.log("[verify-notification-index] DELETE plan:", deleteDetails);
  assert(
    /USING (COVERING )?INDEX/.test(deleteDetails),
    `expected the DELETE shape (userId leading column) to also use the index, got: ${deleteDetails}`,
  );

  await prisma.notification.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log("\n✅ NOTIFICATION INDEX CHECKS PASSED");
}

main().catch(async (e) => {
  console.error(e);
  const { prisma } = await import("../src/lib/prisma");
  await prisma.$disconnect();
  process.exit(1);
});
