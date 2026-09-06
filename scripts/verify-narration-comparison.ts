import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compareNarrationDuration } from "../src/lib/narration-target";
import { NarrationDurationReview } from "../src/app/(dashboard)/video-editor/_v2/NarrationDurationReview";

for (const target of [30, 60, 90]) {
  for (const duration of [target * 900, target * 1000, target * 1100]) {
    assert.equal(compareNarrationDuration(target, duration)?.withinTarget, true);
  }
  for (const duration of [target * 900 - 0.01, target * 1100 + 0.01]) {
    assert.equal(compareNarrationDuration(target, duration)?.withinTarget, false);
  }
}
for (const target of [null, undefined, 120, "30"]) assert.equal(compareNarrationDuration(target, 30_000), null);
for (const duration of [0, -1, NaN, Infinity]) assert.equal(compareNarrationDuration(30, duration), null);
// Frozen real takes from PR449 stay failed; no rounding or alternate-take selection.
assert.equal(compareNarrationDuration(30, 34370.958)?.withinTarget, false);
assert.equal(compareNarrationDuration(90, 71501.917)?.withinTarget, false);
assert.equal(compareNarrationDuration(30, 31210.958)?.withinTarget, true);
let actions = 0;
const props = { targetSec: 30, audioDurationMs: 34370.958, voiceUrl: "/qa-voice.wav",
  onEdit: () => actions++, onRegenerate: () => actions++ };
const html = renderToStaticMarkup(createElement(NarrationDurationReview, props));
assert.match(html, /34\.37/);
assert.match(html, /นอกช่วง ±10%/);
assert.match(html, /controls="" preload="none" src="\/qa-voice.wav"/);
assert.match(html, /ดูค่าใช้จ่ายและสร้างใหม่/);
assert.doesNotMatch(html, /autoplay/i);
assert.equal(actions, 0, "reviewing a failed take never triggers regeneration");
assert.equal(renderToStaticMarkup(createElement(NarrationDurationReview, { ...props, targetSec: null })), "");
console.log("narration-comparison: duration boundaries, real takes and passive audio review pass");

for (const creditsLive of ["0", "1"]) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/verify-narration-receipt.ts"], {
    stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_CREDITS_LIVE: creditsLive },
  });
}
