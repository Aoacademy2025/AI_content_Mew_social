// Static regression checks for the quota/credit confusion reported from the editor.
// Run: npm run verify:quota-credit-ui

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const quota = read("src/components/quota-status.tsx");
const billing = read("src/components/settings/credits-billing-section.tsx");
const editorV2 = read("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx");

assert.match(quota, /fetch(?:ClientJson)?(?:<[^>]+>)?\(["']\/api\/videos\/usage["']/,
  "quota status reads the monthly render-minute meter");
assert.match(quota, /fetch(?:ClientJson)?(?:<[^>]+>)?\(["']\/api\/credits\/balance["']/,
  "quota status also reads the independent Hero-credit balance");
assert.match(quota, />\s*โควต้านาที\s*</,
  "the compact editor badge explicitly labels render minutes as minute quota");
assert.match(quota, /เครดิตเติมนาที/,
  "the compact editor badge explains the FREE wallet as minute credits");
assert.match(quota, /Hero credits/,
  "paid accounts retain a neutral wallet label instead of implying feature access");
assert.match(quota, /window\.addEventListener\(["']focus["']/,
  "the balance refreshes after returning from a manual/admin top-up");
assert.match(quota, /document\.addEventListener\(["']visibilitychange["']/,
  "the balance refreshes when its tab becomes visible again");
assert.match(billing, /id=["']credits["']/,
  "the compact credit balance can link to the detailed billing balance");
assert.match(billing, /เครดิตไม่ปลดล็อก Hero AI Image, AutoMix, Avatar หรือเสียงพรีเมียม/,
  "FREE purchase disclosure separates wallet value from paid capabilities");
assert.match(editorV2, /<QuotaStatus\s+variant=["']chip["']/,
  "the current v2 editor keeps the minute and Hero-credit balance visible before render");
assert.match(editorV2, /className=["'][^"']*lg:hidden/,
  "the current v2 editor preserves the balance surface on mobile");

console.log("Quota / credit UI regression checks passed.");
