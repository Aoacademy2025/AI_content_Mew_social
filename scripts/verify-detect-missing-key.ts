/**
 * TDD verification for detectMissingKeyType KEY_REQUIRED fix.
 * Run: npx tsx scripts/verify-detect-missing-key.ts
 *
 * NOTE: If importing from api-key-modal.tsx fails under tsx (JSX/React context),
 * the test will report a clear import error and the script will exit non-zero.
 * In that case, rely on tsc --noEmit for type safety verification.
 */

import { detectMissingKeyType } from "@/components/ui/api-key-modal";

let passed = 0;
let failed = 0;

function assert(label: string, got: unknown, expected: unknown) {
  if (got === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        got:      ${JSON.stringify(got)}`);
    failed++;
  }
}

console.log("\n=== detectMissingKeyType — KEY_REQUIRED fix ===\n");

// THE FIX: 409 KEY_REQUIRED should map to "gemini"
assert(
  'code:"KEY_REQUIRED" → "gemini"',
  detectMissingKeyType({ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }),
  "gemini"
);

// UNCHANGED: explicit missingKey field still works
assert(
  'missingKey:"pexels" → "pexels"',
  detectMissingKeyType({ missingKey: "pexels" }),
  "pexels"
);

// UNCHANGED: QUOTA_MINUTES is NOT a key error → null (no modal)
assert(
  'code:"QUOTA_MINUTES" → null',
  detectMissingKeyType({ code: "QUOTA_MINUTES", message: "x" }),
  null
);

// UNCHANGED: random error object → null
assert(
  '{ error:"something random" } → null',
  detectMissingKeyType({ error: "something random" }),
  null
);

// UNCHANGED: keyword string matching still works (gemini in error string)
assert(
  '"gemini" keyword in error string → "gemini"',
  detectMissingKeyType({ error: "gemini key invalid" }),
  "gemini"
);

// UNCHANGED: retryable:true blocks modal even when provider name is in message
assert(
  'retryable:true → null (not a key error)',
  detectMissingKeyType({ error: "Gemini ขัดข้องชั่วคราว", retryable: true }),
  null
);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
