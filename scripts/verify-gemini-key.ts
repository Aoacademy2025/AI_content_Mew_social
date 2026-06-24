import assert from "node:assert";
import { resolveGeminiKey } from "../src/lib/gemini-key";

process.env.MANAGED_GEMINI = "1";
process.env.GEMINI_SERVER_KEY = "srv-key";

// BYOK wins when user has their own key (whale/override)
assert.deepEqual(resolveGeminiKey({ geminiKey: "user-key", plan: "PRO" }), { key: "user-key", mode: "byok" });
// managed when no user key + flag on
assert.deepEqual(resolveGeminiKey({ geminiKey: null, plan: "PRO" }), { key: "srv-key", mode: "managed" });
// flag off + no key → KEY_REQUIRED
process.env.MANAGED_GEMINI = "0";
assert.throws(() => resolveGeminiKey({ geminiKey: null, plan: "PRO" }), /KEY_REQUIRED/);
console.log("ok gemini-key");
