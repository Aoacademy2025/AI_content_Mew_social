import assert from "node:assert/strict";
import {
  effectiveMediaExpiry,
  expiryForMedia,
  mediaReferenceIsLive,
  storageDaysForPlan,
} from "../src/lib/media-retention";

const DAY_MS = 86_400_000;
const from = new Date("2026-07-01T00:00:00.000Z");

assert.equal(storageDaysForPlan("FREE"), 3);
assert.equal(storageDaysForPlan("PRO"), 7);
assert.equal(storageDaysForPlan("BUSINESS"), 14);
assert.equal(expiryForMedia("FREE", from).toISOString(), "2026-07-04T00:00:00.000Z");
assert.equal(expiryForMedia("PRO", from).toISOString(), "2026-07-08T00:00:00.000Z");
assert.equal(expiryForMedia("BUSINESS", from).toISOString(), "2026-07-15T00:00:00.000Z");

assert.equal(
  effectiveMediaExpiry([{ expiresAt: new Date("2026-07-04T00:00:00Z") }])?.toISOString(),
  "2026-07-04T00:00:00.000Z",
);
assert.equal(
  effectiveMediaExpiry([
    { expiresAt: new Date("2026-07-04T00:00:00Z") },
    { expiresAt: new Date("2026-07-15T00:00:00Z") },
  ])?.toISOString(),
  "2026-07-15T00:00:00.000Z",
);
assert.equal(effectiveMediaExpiry([{ expiresAt: null }]), null, "null means conservatively protected");
assert.equal(
  effectiveMediaExpiry([
    { expiresAt: new Date("2026-07-04T00:00:00Z") },
    { expiresAt: new Date("2026-07-15T00:00:00Z"), alwaysProtect: true },
  ]),
  null,
  "always-protected owners make effective expiry protected",
);

const freeBoundary = new Date(from.getTime() + 3 * DAY_MS);
assert.equal(mediaReferenceIsLive({ expiresAt: freeBoundary }, freeBoundary), true);
assert.equal(mediaReferenceIsLive({ expiresAt: freeBoundary }, new Date(freeBoundary.getTime() + 1)), false);
assert.equal(mediaReferenceIsLive({ expiresAt: null }, from), true, "null expiry remains live");
assert.equal(
  mediaReferenceIsLive({ expiresAt: new Date(from.getTime() - 1), alwaysProtect: true }, from),
  true,
);

console.log("PASS media retention resolver");
