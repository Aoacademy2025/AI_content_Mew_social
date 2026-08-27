import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BROLL_UPLOADS_PER_HOUR,
  BrollUploadAdmission,
} from "../src/lib/broll-upload-admission";

const EXPECTED_UPLOADS_PER_HOUR = 60;
assert.equal(
  BROLL_UPLOADS_PER_HOUR,
  EXPECTED_UPLOADS_PER_HOUR,
  "the upload ceiling covers the product's maximum 60 B-roll targets",
);

let now = Date.UTC(2026, 7, 27, 7, 0, 0);
const admission = new BrollUploadAdmission({ now: () => now });

for (let index = 0; index < EXPECTED_UPLOADS_PER_HOUR; index += 1) {
  const result = admission.tryAcquire("paid-user");
  assert.equal(result.ok, true, `upload ${index + 1} is admitted`);
  if (!result.ok) continue;
  result.lease.commit();
  result.lease.commit(); // idempotent: one request must consume only one slot
  result.lease.release();
}

const limited = admission.tryAcquire("paid-user");
assert.equal(limited.ok, false, "the first upload beyond the hourly ceiling is rejected");
if (!limited.ok) {
  assert.equal(limited.reason, "rate_limited");
  assert.equal(limited.retryAfterSec, 3_600, "rate response identifies the rolling-window wait");
}

now += 60 * 60 * 1_000 + 1;
const afterWindow = admission.tryAcquire("paid-user");
assert.equal(afterWindow.ok, true, "uploads resume after the rolling window expires");
if (afterWindow.ok) afterWindow.lease.release();

const invalidOnly = new BrollUploadAdmission({ now: () => now });
for (let index = 0; index < EXPECTED_UPLOADS_PER_HOUR + 5; index += 1) {
  const result = invalidOnly.tryAcquire("invalid-user");
  assert.equal(result.ok, true, "an uncommitted validation attempt can acquire admission");
  if (result.ok) result.lease.release();
}
const validAfterInvalid = invalidOnly.tryAcquire("invalid-user");
assert.equal(validAfterInvalid.ok, true, "invalid requests do not consume upload budget");
if (validAfterInvalid.ok) validAfterInvalid.lease.release();

const concurrent = new BrollUploadAdmission({ now: () => now });
const first = concurrent.tryAcquire("same-user");
assert.equal(first.ok, true, "the first in-flight upload is admitted");
const overlapping = concurrent.tryAcquire("same-user");
assert.deepEqual(
  overlapping,
  { ok: false, reason: "busy", retryAfterSec: 5 },
  "a second concurrent upload for the same user is rejected",
);
assert.equal(concurrent.tryAcquire("different-user").ok, true, "different users do not block each other");
if (first.ok) first.lease.release();
assert.equal(concurrent.tryAcquire("same-user").ok, true, "release permits the user's next upload");

const routeSource = readFileSync(
  path.join(process.cwd(), "src/app/api/videos/broll-window/upload/route.ts"),
  "utf8",
);
const validationIndex = routeSource.indexOf("if (file.size > maxBytes)");
const acquireIndex = routeSource.indexOf("brollUploadAdmission.tryAcquire(user.id)");
const commitIndex = routeSource.indexOf("admission.lease.commit()");
const imageWorkIndex = routeSource.indexOf("await applyKenBurns(tempInput, outPath)");
const videoWorkIndex = routeSource.indexOf("await normalizeForRemotion(outPath)");
assert.ok(
  validationIndex >= 0
    && validationIndex < acquireIndex
    && acquireIndex < commitIndex
    && commitIndex < imageWorkIndex
    && commitIndex < videoWorkIndex,
  "the route validates first, then commits admission before either ffmpeg path",
);
assert.match(routeSource, /headers: \{ "Retry-After": String\(admission\.retryAfterSec\) \}/u);

console.log("B-roll upload admission checks passed.");
