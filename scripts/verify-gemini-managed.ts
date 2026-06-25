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

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll gemini-managed checks passed.");
