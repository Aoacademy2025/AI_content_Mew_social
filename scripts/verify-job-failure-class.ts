// Job Failure Class (CONTEXT.md) is the ONLY taxonomy for video-job failures and it lives in
// exactly one module. This script pins the six behaviours the admin surfaces depend on; it is
// pure (no DB) so it can never go stale against a fixture database.
import { classifyJobError, type JobFailureClass } from "../src/lib/job-failure-class";

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string) {
  if (condition) { passed += 1; console.log(`ok: ${label}`); }
  else { failed += 1; console.error(`FAIL: ${label}`); }
}

function classified(message: string | null, managed: boolean): JobFailureClass {
  return classifyJobError(message, managed);
}

// 1. Superseded work is never a failure — it is work we replaced on purpose.
check(classified("__SUPERSEDED__ replaced by a newer render", false) === "noise",
  "superseded → noise");

// 2. Our own plan cap is a pricing signal, not a bug and not a customer key fault.
check(classified("QUOTA_MINUTES: เกินโควต้านาที ของแผน PRO", false) === "quota",
  "plan-cap text → quota");

// 3./4. A 429 means opposite things depending on whose key hit the ceiling.
check(classified("Gemini 429 RESOURCE_EXHAUSTED", true) === "system",
  "429 with MANAGED_GEMINI on → system (our managed key hit a ceiling)");
check(classified("Gemini 429 RESOURCE_EXHAUSTED", false) === "byok",
  "429 with MANAGED_GEMINI off → byok (the customer's own key)");

// 5. Provider-key rejections are the customer's key, never our code.
check(classified("API_KEY_INVALID: api key not valid", false) === "byok",
  "provider-key text → byok");

// 6. Anything we cannot attribute to the customer is ours to fix.
check(classified("ffmpeg exited with code 1", false) === "system",
  "unknown failure → system");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
