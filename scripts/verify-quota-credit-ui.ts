// Static regression checks for the quota/credit confusion reported from the editor.
// Run: npx tsx scripts/verify-quota-credit-ui.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const quota = read("src/components/quota-status.tsx");
const billing = read("src/components/settings/credits-billing-section.tsx");
const editorV2 = read("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx");

assert.match(quota, /fetch\(["']\/api\/videos\/usage["']/,
  "quota status reads the monthly render-minute meter");
assert.match(quota, /fetch\(["']\/api\/credits\/balance["']/,
  "quota status also reads the independent Hero-credit balance");
assert.match(quota, />\s*โควต้านาที\s*</,
  "the compact editor badge explicitly labels render minutes as minute quota");
assert.match(quota, />\s*Hero credits\s*</,
  "the compact editor badge surfaces the separate Hero-credit balance");
assert.match(quota, /window\.addEventListener\(["']focus["']/,
  "the balance refreshes after returning from a manual/admin top-up");
assert.match(quota, /document\.addEventListener\(["']visibilitychange["']/,
  "the balance refreshes when its tab becomes visible again");
assert.match(billing, /id=["']credits["']/,
  "the compact credit balance can link to the detailed billing balance");
assert.match(editorV2, /<QuotaStatus\s+variant=["']chip["']/,
  "the current v2 editor keeps the minute and Hero-credit balance visible before render");
assert.match(editorV2, /className=["'][^"']*lg:hidden/,
  "the current v2 editor preserves the balance surface on mobile");

console.log("Quota / credit UI regression checks passed.");
