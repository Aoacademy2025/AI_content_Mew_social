// Pure validator for the internal service credential. No DB needed.
//   npx tsx scripts/verify-service-actor.ts
import { isValidServiceCredential } from "../src/lib/mcp/service-actor";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

assert(isValidServiceCredential("s3cret", "s3cret", "user_1") === true, "valid secret + actAs → true");
assert(isValidServiceCredential("s3cret", "wrong", "user_1") === false, "wrong secret → false");
assert(isValidServiceCredential("s3cret", "s3cret", null) === false, "missing actAs → false");
assert(isValidServiceCredential("s3cret", null, "user_1") === false, "missing header secret → false");
assert(isValidServiceCredential(undefined, "s3cret", "user_1") === false, "no env secret (feature off) → false");
assert(isValidServiceCredential("", "", "user_1") === false, "empty env secret → false");

console.log(`\n✅ ALL ${passed} SERVICE-ACTOR CHECKS PASSED`);
