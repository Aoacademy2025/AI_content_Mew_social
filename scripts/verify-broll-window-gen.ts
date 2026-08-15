// Compatibility entrypoint for the per-window image verification. The product
// now uses Hero AI Image/RunPod; the migration contract exercises the real
// route and browser seams. Keep the KIE auth classification assertions because
// KIE remains a separate Cloud API/AutoMix engine.
import assert from "node:assert/strict";
import "./verify-hero-broll-window-migration";
import {
  interpretKieCreditResponse,
  isKieAuthenticationError,
} from "../src/lib/kie-client";

assert.equal(
  isKieAuthenticationError(new Error("kie.ai createTask error: Unauthorized – Authentication failed")),
  true,
);
assert.equal(
  isKieAuthenticationError(new Error("kie.ai task timed out after 180000ms")),
  false,
);
const authFailure = interpretKieCreditResponse(200, { code: 401, msg: "Unauthorized" });
assert.equal(authFailure.ok, false);
if (!authFailure.ok) assert.equal(authFailure.reason, "auth");
const creditOk = interpretKieCreditResponse(200, { code: 200, data: 12.5 });
assert.deepEqual(creditOk, { ok: true, credits: 12.5 });

console.log("verify-broll-window-gen: ALL PASS");
