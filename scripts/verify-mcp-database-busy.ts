// Unit test for isDatabaseBusyError (src/lib/prisma-errors.ts) — the classifier the MCP
// transport (src/app/api/[transport]/route.ts runTool) uses to answer a tool call as
// `database_busy` instead of a generic `internal_error` when the real cause is SQLite
// writer-lock contention. Positive and negative cases only; no DB, no network.
//
// Run: npx tsx scripts/verify-mcp-database-busy.ts

import { isDatabaseBusyError } from "../src/lib/prisma-errors";

function prismaError(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log((cond ? "  ✓ " : "  ✗ FAIL ") + msg);
  if (!cond) failures++;
}

console.log("Positive cases (must be classified as database_busy)");
ok(isDatabaseBusyError(prismaError("P2028")), "P2028 (unable to start/continue a transaction, incl. our own queue timeout)");
ok(isDatabaseBusyError(prismaError("P2028", "Transaction API error: Unable to start a transaction in the given time. Waited 20001 ms in this process's transaction queue (maxWait 20000 ms).")), "P2028 with our own queue-timeout message");
ok(isDatabaseBusyError(prismaError("P1008")), "P1008 (operation timed out)");
ok(isDatabaseBusyError(prismaError("P2024")), "P2024 (timed out fetching a connection from the pool)");
ok(isDatabaseBusyError(new Error("SQLite database error: database is locked")), "message-only: database is locked");
ok(isDatabaseBusyError(new Error("Error code 5: SQLITE_BUSY")), "message-only: SQLITE_BUSY");
ok(isDatabaseBusyError(new Error("Socket timeout")), "message-only: Socket timeout");
ok(isDatabaseBusyError(prismaError("UNKNOWN_CODE", "connection pool timeout: Socket timeout")), "non-busy code but a busy message");

console.log("Negative cases (must NOT be classified as database_busy)");
ok(!isDatabaseBusyError(prismaError("P2002", "Unique constraint failed on the fields: (`email`)")), "P2002 (unique constraint) stays a real error");
ok(!isDatabaseBusyError(prismaError("P2025", "Record to update not found.")), "P2025 (not found) stays a real error");
ok(!isDatabaseBusyError(new TypeError("Cannot read properties of undefined (reading 'x')")), "an unrelated TypeError stays a real error");
ok(!isDatabaseBusyError(new Error("some other failure")), "a plain Error with no busy signal stays a real error");
ok(!isDatabaseBusyError(undefined), "undefined is not busy");
ok(!isDatabaseBusyError(null), "null is not busy");
ok(!isDatabaseBusyError("a string, not an Error"), "a non-object is not busy");
ok(!isDatabaseBusyError({}), "an empty object is not busy");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nverify-mcp-database-busy: ALL PASS");
