import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderReceiptDialog } from "../src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog";
import type { V2Project } from "../src/app/(dashboard)/video-editor/_v2/useV2Project";
import { EDITOR_DEFAULT_DRAFT } from "../src/lib/editor-default-draft";

const p = {
  ...EDITOR_DEFAULT_DRAFT, mode: "script", script: "ปากกา ".repeat(100), isAdmin: false,
  mixPreset: "free", brollSource: "stock", targetClipCount: 0, useAvatar: false,
  usage: { minutes: { remaining: 10, limit: 100 } }, plan: "PRO",
} as unknown as V2Project;
let submissions = 0;
const props = { p, open: true, regeneration: true, submitting: false,
  onConfirm: () => { submissions++; }, onCancel: () => {} };
const html = renderToStaticMarkup(createElement(RenderReceiptDialog, props));
assert.match(html, /สรุปก่อนเรนเดอร์/);
assert.match(html, /การสร้างใหม่จะสร้างเสียงและวิดีโออีกชุด/);
assert.match(html, /ระบบยังระบุยอดค่าบริการภายนอกล่วงหน้าไม่ได้/);
assert.match(html, /เริ่มเรนเดอร์/);
assert.equal(submissions, 0, "opening cost disclosure does not submit a job");
if (process.env.NEXT_PUBLIC_CREDITS_LIVE === "1") {
  assert.match(html, /นาทีที่จะใช้/);
} else {
  assert.match(html, /นาทีที่จะใช้/);
  assert.doesNotMatch(html, /เติมเครดิต|เครดิตไม่พอ/);
}
const busy = renderToStaticMarkup(createElement(RenderReceiptDialog, { ...props, submitting: true }));
assert.equal((busy.match(/disabled=""/g) ?? []).length, 2, "both actions lock during the confirmed submission");
assert.equal(renderToStaticMarkup(createElement(RenderReceiptDialog, { ...props, open: false })), "");
console.log(`narration-receipt: disclosure and passive rendering pass (credits=${process.env.NEXT_PUBLIC_CREDITS_LIVE})`);

const allowanceHtml = renderToStaticMarkup(createElement(RenderReceiptDialog, { ...props, p: {
  ...p, mixPreset: "full", brollSource: "kie-image", targetClipCount: 3,
  starterAiImageAllowance: { eligible: true, remainingImages: 0, limitImages: 5 },
} as unknown as V2Project }));
assert.match(allowanceHtml, /ใช้สิทธิ์ทดลองภาพ AI ครบแล้ว/);
assert.equal((allowanceHtml.match(/disabled=""/g) ?? []).length, 1, "exhausted image allowance blocks new generation with either credit flag");
