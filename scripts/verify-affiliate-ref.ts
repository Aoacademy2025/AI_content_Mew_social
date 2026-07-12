// Run with: npx tsx scripts/verify-affiliate-ref.ts
// Proves the pure affiliate ref-code helpers: sanitizeRefCode decodes+validates the
// aff_ref value (rejecting anything outside ^[A-Za-z0-9_-]{1,32}$ after decode) and
// studioProductSlug builds the hero-affiliate product slug from plan+period.
import { sanitizeRefCode, studioProductSlug } from "../src/lib/affiliate-ref";
import assert from "node:assert";

assert.equal(sanitizeRefCode("MEW1234"), "MEW1234");
assert.equal(sanitizeRefCode("MEW%20X"), null);            // decodes to "MEW X" → invalid
assert.equal(sanitizeRefCode(encodeURIComponent("A_b-9")), "A_b-9");
assert.equal(sanitizeRefCode("<script>"), null);
assert.equal(sanitizeRefCode(""), null);
assert.equal(sanitizeRefCode(null), null);
assert.equal(sanitizeRefCode("x".repeat(33)), null);
assert.equal(studioProductSlug("PRO", "monthly"), "hero-studio-pro-monthly");
assert.equal(studioProductSlug("BUSINESS", "annual"), "hero-studio-business-annual");
console.log("verify-affiliate-ref: ALL PASS");
