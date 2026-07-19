import assert from "node:assert/strict";

import {
  checkHeygenReadiness,
  toHeygenBlockedResponse,
  type HeygenQuotaPort,
} from "../src/lib/heygen-readiness";

function quotaPort(status: number, body: unknown): HeygenQuotaPort {
  return {
    getRemainingQuota: async () => ({ status, body }),
  };
}

async function main() {
  const ready = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(200, { data: { remaining_quota: 12.5 } }),
  );
  assert.deepEqual(ready, { kind: "ready", remainingQuota: 12.5 });

  const depleted = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(200, { data: { remaining_quota: 0 } }),
  );
  assert.equal(depleted.kind, "blocked");
  assert.equal(depleted.kind === "blocked" ? depleted.code : null, "quota");
  assert.deepEqual(depleted.kind === "blocked" ? toHeygenBlockedResponse(depleted) : null, {
    status: 402,
    body: {
      error: "provider_quota",
      code: "quota",
      provider: "heygen",
      message: "เครดิต HeyGen ไม่เพียงพอสำหรับสร้าง Avatar",
      actions: ["open_heygen", "switch_faceless"],
    },
  });

  const negative = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(200, { remaining_quota: -1 }),
  );
  assert.equal(negative.kind, "blocked");
  assert.equal(negative.kind === "blocked" ? negative.code : null, "quota");

  const invalidKey = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(401, { error: { message: "unauthorized" } }),
  );
  assert.equal(invalidKey.kind, "blocked");
  assert.equal(invalidKey.kind === "blocked" ? invalidKey.code : null, "invalid_key");
  assert.equal(
    invalidKey.kind === "blocked" ? toHeygenBlockedResponse(invalidKey).status : null,
    400,
  );

  const providerQuota = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(402, { error: { message: "insufficient credit" } }),
  );
  assert.equal(providerQuota.kind, "blocked");
  assert.equal(providerQuota.kind === "blocked" ? providerQuota.code : null, "quota");

  const malformed = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(200, { data: {} }),
  );
  assert.equal(malformed.kind, "unknown");

  const unavailable = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    quotaPort(503, { error: "unavailable" }),
  );
  assert.equal(unavailable.kind, "unknown");

  const network = await checkHeygenReadiness(
    { apiKey: "key", timeoutMs: 3_000 },
    {
      getRemainingQuota: async () => {
        throw new Error("ECONNRESET");
      },
    },
  );
  assert.equal(network.kind, "unknown");

  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
