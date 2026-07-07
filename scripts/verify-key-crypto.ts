// Run: npx tsx scripts/verify-key-crypto.ts
// Proves BYOK key crypto (src/lib/key-crypto.ts):
//  - AES-256-GCM round-trip (encrypt → decrypt) with KEY_ENC_SECRET set
//  - LEGACY base64 values still decrypt (zero-migration backward compat)
//  - encrypted values are self-identifying (v2: prefix) and not plaintext-recoverable via base64
//  - wrong secret / corrupt value never throws (returns "")
//  - missing-secret fallback degrades to base64 in BOTH directions (never throws)
import { encryptKey, decryptKey, isEncrypted } from "../src/lib/key-crypto";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ FAIL " + msg); process.exit(1); }
  console.log("✓ PASS " + msg);
  passed++;
}

// ── With KEY_ENC_SECRET set → AES-256-GCM ───────────────────────────────────
process.env.KEY_ENC_SECRET = "unit-test-secret-please-change";

const secret = "sk-test-123";
const enc = encryptKey(secret);
assert(enc.startsWith("v2:"), "encryptKey output is self-identifying (v2: prefix)");
assert(isEncrypted(enc), "isEncrypted() true for v2 value");
assert(!enc.includes(secret), "ciphertext does not contain the plaintext key");
assert(Buffer.from(enc, "base64").toString("utf-8") !== secret, "v2 value is NOT plain base64-recoverable");
assert(decryptKey(enc) === secret, 'decryptKey(encryptKey("sk-test-123")) === "sk-test-123"  (AES-GCM round-trip)');

// Non-determinism: fresh IV each call, but both decrypt back to the same plaintext.
const enc2 = encryptKey(secret);
assert(enc2 !== enc, "each encrypt uses a fresh IV (ciphertext differs)");
assert(decryptKey(enc2) === secret, "second ciphertext also round-trips");

// Trimming (pasted keys often carry trailing newline/space) — matches prior behavior.
assert(decryptKey(encryptKey("  sk-trim-me \n")) === "sk-trim-me", "encryptKey trims surrounding whitespace/newlines");

// Unicode-safe.
const uni = "clé-api-日本語-🔑";
assert(decryptKey(encryptKey(uni)) === uni, "unicode key round-trips");

// ── LEGACY base64 (existing DB values) still decrypt ────────────────────────
const legacy = Buffer.from("legacy-key").toString("base64");
assert(!isEncrypted(legacy), "isEncrypted() false for legacy base64 value");
assert(decryptKey(legacy) === "legacy-key", 'decryptKey(base64("legacy-key")) === "legacy-key"  (legacy path)');

// A real-world legacy value written by the OLD encrypt() (trim → base64).
const oldEncrypted = Buffer.from("sk-old-byok-999".trim()).toString("base64");
assert(decryptKey(oldEncrypted) === "sk-old-byok-999", "legacy value from old encrypt() decrypts unchanged");

// ── Never throws on bad input ───────────────────────────────────────────────
assert(decryptKey("") === "", "empty input → empty string (no throw)");
assert(decryptKey("v2:not:valid:ciphertext") === "", "corrupt v2 value → empty string (no throw)");
process.env.KEY_ENC_SECRET = "a-completely-different-secret";
assert(decryptKey(enc) === "", "v2 value under WRONG secret → empty string (no throw, GCM auth fails)");

// ── Missing-secret fallback: base64 both directions, never throws ───────────
delete process.env.KEY_ENC_SECRET;
const fbEnc = encryptKey("sk-fallback");
assert(!fbEnc.startsWith("v2:"), "no secret → encryptKey falls back to base64 (not v2)");
assert(decryptKey(fbEnc) === "sk-fallback", "no secret → base64 round-trip works (graceful degrade)");
assert(decryptKey(legacy) === "legacy-key", "no secret → legacy base64 still decodes");

console.log(`\n${passed} checks passed ✅`);
