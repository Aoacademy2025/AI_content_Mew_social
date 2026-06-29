import assert from "node:assert";
import { resolveGeminiKey } from "../src/lib/gemini-key";

process.env.MANAGED_GEMINI = "1";
process.env.GEMINI_SERVER_KEY = "srv-key";

// Keys are stored base64-encoded in the DB (same as encrypt() in api-keys route).
// resolveGeminiKey must decode them so callers receive a ready-to-use API key.
const rawKey = "AIzaSy-user-api-key";
const storedKey = Buffer.from(rawKey).toString("base64");

// BYOK wins when user has their own key — decoded value returned
assert.deepEqual(resolveGeminiKey({ geminiKey: storedKey, plan: "PRO" }), { key: rawKey, mode: "byok" });
// managed when no user key + flag on — env value returned as-is (never base64)
assert.deepEqual(resolveGeminiKey({ geminiKey: null, plan: "PRO" }), { key: "srv-key", mode: "managed" });
// empty string geminiKey treated as no key → managed path
assert.deepEqual(resolveGeminiKey({ geminiKey: "", plan: "PRO" }), { key: "srv-key", mode: "managed" });
// flag off + no key → KEY_REQUIRED
process.env.MANAGED_GEMINI = "0";
assert.throws(() => resolveGeminiKey({ geminiKey: null, plan: "PRO" }), /KEY_REQUIRED/);
console.log("ok gemini-key");
