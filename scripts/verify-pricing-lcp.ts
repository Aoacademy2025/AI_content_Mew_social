import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const page = readFileSync("src/app/(dashboard)/pricing/page.tsx", "utf8");
const client = readFileSync("src/app/(dashboard)/pricing/pricing-client.tsx", "utf8");

assert.doesNotMatch(page, /^["']use client["']/m, "pricing page must be a Server Component");
assert.match(page, /getPlanConfig\(/, "plan prices are resolved on the server");
assert.match(page, /foundingStatus\(/, "Founding status is resolved on the server");
assert.doesNotMatch(page, /fallback=\{null\}/, "do not paint a blank Suspense fallback");
assert.doesNotMatch(page, /<video/, "LCP must not be a video on /pricing");
assert.doesNotMatch(client, /<video/, "pricing client island must not mount a video");
assert.match(page, /<h1/, "convert heading is in the Server Component HTML");
assert.match(page, /เลือกแพ็กที่ใช่/, "convert heading text is server-rendered");
assert.doesNotMatch(client, /useSearchParams/, "searchParams must not suspend the convert page");
assert.doesNotMatch(client, /fetch\("\/api\/plans"\)/, "do not refetch plan config on the client critical path");

console.log("verify-pricing-lcp: PASS");
