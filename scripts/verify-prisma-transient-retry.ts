import assert from "node:assert/strict";
import {
  isTransientDbError,
  transientRetryDelayMs,
  withTransientDbRetry,
} from "../src/lib/prisma-transient-retry";

function prismaError(code: string, message = `prisma failed with ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

type SleepLog = number[];

function fakeSleep(log: SleepLog) {
  return async (delayMs: number) => {
    log.push(delayMs);
  };
}

async function main() {
  // ---- classification -------------------------------------------------
  assert.equal(isTransientDbError(prismaError("P2028")), true, "P2028 (transaction expired) is transient");
  assert.equal(isTransientDbError(prismaError("P2024")), true, "P2024 (pool timeout) is transient");
  assert.equal(isTransientDbError(prismaError("P2034")), true, "P2034 (write conflict) is transient");
  assert.equal(
    isTransientDbError(new Error(
      "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
    )),
    true,
    "an expired interactive transaction is transient even without a Prisma code",
  );
  assert.equal(
    isTransientDbError(new Error(
      "Socket timeout (the database failed to respond to a query within the configured timeout)",
    )),
    true,
    "a socket timeout is transient",
  );
  assert.equal(isTransientDbError(new Error("database is locked")), true, "SQLite lock contention is transient");
  assert.equal(isTransientDbError(new Error("SQLITE_BUSY: database is busy")), true, "SQLITE_BUSY is transient");
  assert.equal(isTransientDbError(prismaError("P2002", "Unique constraint failed")), false, "a unique-constraint violation is NOT transient");
  assert.equal(isTransientDbError(new Error("boom")), false, "an unclassified error is NOT transient");
  assert.equal(isTransientDbError(null), false, "null is not a transient error");
  assert.equal(isTransientDbError("Socket timeout"), false, "a bare string is not a retryable Error");

  // ---- backoff schedule ----------------------------------------------
  assert.equal(transientRetryDelayMs(1, 250), 250);
  assert.equal(transientRetryDelayMs(2, 250), 750);
  assert.equal(transientRetryDelayMs(3, 250), 2000);
  assert.equal(transientRetryDelayMs(4, 250), 2000, "the schedule saturates instead of growing without bound");

  // ---- retries a transient error, then succeeds -----------------------
  for (const transient of [
    prismaError("P2028", "Transaction API error: Transaction already closed"),
    new Error("Transaction already closed: A query cannot be executed on an expired transaction."),
    new Error("Socket timeout (the database failed to respond to a query within the configured timeout)"),
  ]) {
    let calls = 0;
    const slept: SleepLog = [];
    const value = await withTransientDbRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw transient;
        return "persisted";
      },
      { label: "completeImageJob", sleep: fakeSleep(slept), log: () => {} },
    );
    assert.equal(value, "persisted", "the second attempt's value is returned");
    assert.equal(calls, 2, "one transient failure costs exactly one extra attempt");
    assert.deepEqual(slept, [250], "the first backoff is 250ms");
  }

  // ---- gives up after N attempts and rethrows the last transient error -
  {
    let calls = 0;
    const slept: SleepLog = [];
    const errors = [
      prismaError("P2028", "first expiry"),
      prismaError("P2028", "second expiry"),
      prismaError("P2024", "final pool timeout"),
    ];
    await assert.rejects(
      withTransientDbRetry(
        async () => {
          const error = errors[calls];
          calls += 1;
          throw error;
        },
        { label: "completeImageJob", sleep: fakeSleep(slept), log: () => {} },
      ),
      (error: unknown) => error instanceof Error && error.message === "final pool timeout",
      "the LAST transient error is rethrown unchanged",
    );
    assert.equal(calls, 3, "the default attempt budget is 3");
    assert.deepEqual(slept, [250, 750], "only the gaps between attempts are slept");
  }

  // ---- a longer budget follows the documented 250 / 750 / 2000 ladder --
  {
    let calls = 0;
    const slept: SleepLog = [];
    await assert.rejects(
      withTransientDbRetry(
        async () => {
          calls += 1;
          throw prismaError("P2034", "write conflict");
        },
        { attempts: 4, label: "completeImageJob", sleep: fakeSleep(slept), log: () => {} },
      ),
      /write conflict/,
    );
    assert.equal(calls, 4);
    assert.deepEqual(slept, [250, 750, 2000], "backoff is 250 / 750 / 2000 ms");
  }

  // ---- an injectable base delay scales the whole ladder ---------------
  {
    let calls = 0;
    const slept: SleepLog = [];
    await withTransientDbRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw prismaError("P2028");
        return calls;
      },
      { baseDelayMs: 10, label: "completeImageJob", sleep: fakeSleep(slept), log: () => {} },
    );
    assert.deepEqual(slept, [10], "baseDelayMs is injectable so tests never wait");
  }

  // ---- never retries a non-transient error ----------------------------
  for (const fatal of [
    prismaError("P2002", "Unique constraint failed on the fields: (`idempotencyKey`)"),
    new Error("boom"),
  ]) {
    let calls = 0;
    const slept: SleepLog = [];
    await assert.rejects(
      withTransientDbRetry(
        async () => {
          calls += 1;
          throw fatal;
        },
        { label: "completeImageJob", sleep: fakeSleep(slept), log: () => {} },
      ),
      (error: unknown) => error === fatal,
      "a non-transient error is returned unchanged, not wrapped",
    );
    assert.equal(calls, 1, "a non-transient error must not be retried");
    assert.deepEqual(slept, [], "a non-transient error must not sleep");
  }

  // ---- one sanitised warn per retry, no user data ---------------------
  {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    let calls = 0;
    try {
      await withTransientDbRetry(
        async () => {
          calls += 1;
          if (calls < 3) {
            throw prismaError(
              "P2028",
              "Transaction already closed while writing subject='ลูกค้า somebody@example.com'",
            );
          }
          return "ok";
        },
        { label: "completeImageJob", sleep: fakeSleep([]) },
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 2, "exactly one warning per retry");
    for (const [index, warning] of warnings.entries()) {
      assert.match(warning, /completeImageJob/, "the label identifies the retried operation");
      assert.match(warning, new RegExp(`attempt ${index + 1}`), "the warning names the attempt number");
      assert.doesNotMatch(warning, /somebody@example\.com|ลูกค้า/, "the warning must never carry user data");
    }
  }

  // ---- a synchronous throw inside the operation is still handled ------
  {
    let calls = 0;
    const value = await withTransientDbRetry(
      () => {
        calls += 1;
        if (calls === 1) throw prismaError("P2028");
        return Promise.resolve(7);
      },
      { label: "completeImageJob", sleep: fakeSleep([]), log: () => {} },
    );
    assert.equal(value, 7);
    assert.equal(calls, 2);
  }

  console.log("verify-prisma-transient-retry: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
