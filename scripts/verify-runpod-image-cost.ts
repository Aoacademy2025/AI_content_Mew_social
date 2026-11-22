import assert from "node:assert/strict";
import {
  assessRunpodImageCost,
  formatRunpodBillingError,
  normalizeRunpodImageCostPolicy,
} from "../src/lib/runpod-image-cost";

const policy = normalizeRunpodImageCostPolicy({
  targetBaht: 0.90,
  hardLimitBaht: 1.08,
  minSample: 20,
  staleAfterMs: 3 * 60 * 60_000,
});
const nowMs = Date.UTC(2026, 6, 30, 12);

assert.deepEqual(
  assessRunpodImageCost({
    billedUsdMicros: 50_000,
    deliveredImages: 10,
    usdThbRate: 36,
    lastSuccessfulSyncAtMs: nowMs,
    nowMs,
    policy,
  }),
  {
    status: "insufficient_data",
    admitted: true,
    costBahtPerImage: 0.18,
    sampleEnough: false,
    reason: "Collecting a minimum private-beta billing sample",
  },
);

assert.equal(assessRunpodImageCost({
  billedUsdMicros: 500_000,
  deliveredImages: 25,
  usdThbRate: 36,
  lastSuccessfulSyncAtMs: nowMs,
  nowMs,
  policy,
}).status, "healthy");

const warning = assessRunpodImageCost({
  billedUsdMicros: 700_000,
  deliveredImages: 25,
  usdThbRate: 36,
  lastSuccessfulSyncAtMs: nowMs,
  nowMs,
  policy,
});
assert.equal(warning.status, "warning");
assert.equal(warning.admitted, true);

const stopped = assessRunpodImageCost({
  billedUsdMicros: 800_000,
  deliveredImages: 25,
  usdThbRate: 36,
  lastSuccessfulSyncAtMs: nowMs,
  nowMs,
  policy,
});
assert.equal(stopped.status, "hard_stop");
assert.equal(stopped.admitted, false);
assert.ok((stopped.costBahtPerImage ?? 0) > 1.08);

const stale = assessRunpodImageCost({
  billedUsdMicros: 100_000,
  deliveredImages: 25,
  usdThbRate: 36,
  lastSuccessfulSyncAtMs: nowMs - policy.staleAfterMs - 1,
  nowMs,
  policy,
});
assert.equal(stale.status, "stale");
assert.equal(stale.admitted, false);

const dnsCause = Object.assign(new Error("getaddrinfo ENOTFOUND rest.runpod.io"), {
  code: "ENOTFOUND",
});
const formattedDns = formatRunpodBillingError(new TypeError("fetch failed", { cause: dnsCause }));
assert.equal(formattedDns, "fetch failed (cause: getaddrinfo ENOTFOUND rest.runpod.io)");
assert.equal(
  formatRunpodBillingError(new Error(formattedDns, { cause: new TypeError("fetch failed", { cause: dnsCause }) })),
  formattedDns,
);

const timeoutCause = Object.assign(new Error("Connect Timeout Error"), {
  code: "UND_ERR_CONNECT_TIMEOUT",
});
assert.equal(
  formatRunpodBillingError(new TypeError("fetch failed", { cause: timeoutCause })),
  "fetch failed (cause: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)",
);

console.log("verify-runpod-image-cost: ALL PASS");
