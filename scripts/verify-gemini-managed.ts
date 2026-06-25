// Unit tests for resolveGeminiKey managed-first logic
// (run: npx tsx scripts/verify-gemini-managed.ts)
//
// Verifies that when MANAGED_GEMINI=1 + GEMINI_SERVER_KEY is set, the server key
// is always returned and any stored user key is IGNORED. Also verifies flag-off
// is byte-identical to the old BYOK behavior.
import { resolveGeminiKey, KeyRequiredError } from "../src/lib/gemini-key";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Save original env values so we can restore after tests
const origManaged = process.env.MANAGED_GEMINI;
const origServerKey = process.env.GEMINI_SERVER_KEY;

// ── Case 1: managed on + server key → managed, IGNORES a stored user key ──
process.env.MANAGED_GEMINI = "1"; process.env.GEMINI_SERVER_KEY = "SRV";
let r = resolveGeminiKey({ geminiKey: Buffer.from("USERKEY").toString("base64"), plan: "PRO" });
check("managed-first ignores stored user key", r.mode === "managed" && r.key === "SRV",
  `mode=${r.mode} key=${r.key}`);

// ── Case 2: managed on + NO server key → falls back to user key if present ──
delete process.env.GEMINI_SERVER_KEY;
r = resolveGeminiKey({ geminiKey: Buffer.from("USERKEY").toString("base64"), plan: "PRO" });
check("managed w/o server key falls back to user key", r.mode === "byok" && r.key === "USERKEY",
  `mode=${r.mode} key=${r.key}`);

// ── Case 3: managed OFF → user key (byte-identical to today) ──
process.env.MANAGED_GEMINI = "0"; process.env.GEMINI_SERVER_KEY = "SRV";
r = resolveGeminiKey({ geminiKey: Buffer.from("USERKEY").toString("base64"), plan: "PRO" });
check("flag off → BYOK verbatim", r.mode === "byok" && r.key === "USERKEY",
  `mode=${r.mode} key=${r.key}`);

// ── Case 4: off + no user key → throw KeyRequiredError ──
let threw = false;
try {
  resolveGeminiKey({ geminiKey: null, plan: "PRO" });
} catch (e) {
  threw = (e as Error).name === "KeyRequiredError" || /gemini/i.test((e as Error).message);
}
check("off + no key → KeyRequiredError", threw);

// ── Restore original env ──
if (origManaged === undefined) delete process.env.MANAGED_GEMINI;
else process.env.MANAGED_GEMINI = origManaged;
if (origServerKey === undefined) delete process.env.GEMINI_SERVER_KEY;
else process.env.GEMINI_SERVER_KEY = origServerKey;

// ── requiredKeysFor tests (Task 2) ──
import { requiredKeysFor } from "../src/lib/key-tiers";

check("managed → gemini not required",
  !requiredKeysFor(true).some(k => k.id === "gemini"));
check("off → gemini required",
  requiredKeysFor(false).some(k => k.id === "gemini"));
check("managed keeps pexels required",
  requiredKeysFor(true).some(k => k.id === "pexels"));
check("managed keeps pixabay required",
  requiredKeysFor(true).some(k => k.id === "pixabay"));

// ── Task 3: gemini-errors managed-aware messaging ──
import { getGeminiErrorInfo } from "../src/lib/gemini-errors";

const PLATFORM_PHRASE = "ระบบ AI ขัดข้องชั่วคราว";
const KEY_FIX_PATTERNS = ["key ใหม่", "Settings", "ผูกบัตร", "สร้าง key", "Enable"];

function containsKeyFix(msg: string): boolean {
  return KEY_FIX_PATTERNS.some((p) => msg.includes(p));
}

// Construct error objects that trigger specific kinds:
const invalidKeyErr = new Error("API_KEY_INVALID: invalid api key provided");
const apiDisabledErr = new Error("service_disabled: generative language api has not been used in project");
const billingErr = new Error("403 BILLING_DISABLED: billing account not found, enable billing");
const permissionErr = new Error("403 PERMISSION_DENIED: permission denied");

// Transient kinds — should be unchanged even when managed=true:
const quotaErr = new Error("429 resource_exhausted: quota exceeded");
const highDemandErr = new Error("503 Service Unavailable: high demand");
const timeoutErr = new Error("AbortError: headers_timeout");

// ── managed=true: key-fault kinds → platform message ──
const ivManaged = getGeminiErrorInfo(invalidKeyErr, { managed: true });
check("managed invalid_key → platform msg (no 'key ใหม่'/'Settings')",
  ivManaged.kind === "invalid_key" && !containsKeyFix(ivManaged.userMessage) && ivManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${ivManaged.kind} msg="${ivManaged.userMessage}"`);

const adManaged = getGeminiErrorInfo(apiDisabledErr, { managed: true });
check("managed api_disabled → platform msg",
  adManaged.kind === "api_disabled" && !containsKeyFix(adManaged.userMessage) && adManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${adManaged.kind} msg="${adManaged.userMessage}"`);

const biManaged = getGeminiErrorInfo(billingErr, { managed: true });
check("managed billing → platform msg (no 'ผูกบัตร')",
  biManaged.kind === "billing" && !containsKeyFix(biManaged.userMessage) && biManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${biManaged.kind} msg="${biManaged.userMessage}"`);

const pmManaged = getGeminiErrorInfo(permissionErr, { managed: true });
check("managed permission → platform msg",
  pmManaged.kind === "permission" && !containsKeyFix(pmManaged.userMessage) && pmManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${pmManaged.kind} msg="${pmManaged.userMessage}"`);

// ── managed=false (default): key-fault kinds → original messages ──
const ivByok = getGeminiErrorInfo(invalidKeyErr, { managed: false });
check("byok invalid_key → contains key-fix wording",
  ivByok.kind === "invalid_key" && containsKeyFix(ivByok.userMessage),
  `msg="${ivByok.userMessage}"`);

const biByok = getGeminiErrorInfo(billingErr, { managed: false });
check("byok billing → contains 'ผูกบัตร'",
  biByok.kind === "billing" && biByok.userMessage.includes("ผูกบัตร"),
  `msg="${biByok.userMessage}"`);

// ── managed=true: transient kinds stay unchanged ──
const qtManaged = getGeminiErrorInfo(quotaErr, { managed: true });
check("managed quota → kind=quota (unchanged), NOT platform msg",
  qtManaged.kind === "quota" && !qtManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${qtManaged.kind} msg="${qtManaged.userMessage}"`);

const hdManaged = getGeminiErrorInfo(highDemandErr, { managed: true });
check("managed high_demand → unchanged",
  hdManaged.kind === "high_demand" && !hdManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${hdManaged.kind} msg="${hdManaged.userMessage}"`);

const toManaged = getGeminiErrorInfo(timeoutErr, { managed: true });
check("managed timeout → unchanged",
  toManaged.kind === "timeout" && !toManaged.userMessage.includes(PLATFORM_PHRASE),
  `kind=${toManaged.kind} msg="${toManaged.userMessage}"`);

// ── no-opts call (default managed=false) → key-fault gets original msg ──
const ivNoOpts = getGeminiErrorInfo(invalidKeyErr);
check("no-opts (default) invalid_key → original key-fix msg",
  ivNoOpts.kind === "invalid_key" && containsKeyFix(ivNoOpts.userMessage),
  `msg="${ivNoOpts.userMessage}"`);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll gemini-managed checks passed.");
