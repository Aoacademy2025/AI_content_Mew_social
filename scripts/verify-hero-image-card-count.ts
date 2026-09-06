import assert from "node:assert/strict";
import { heroImageCardCount } from "../src/app/(dashboard)/video-editor/_v2/estimate";
import { buildReceipt } from "../src/app/(dashboard)/video-editor/_v2/receipt";
const base = { durationSec: 18, targetClipCount: 5, selected: true, countTouched: true, starterRemaining: null, upload: false };
for (const count of [0, 1, 5, 8, 60]) {
  const card = heroImageCardCount({...base, targetClipCount: count});
  const receipt = buildReceipt({estSec:18, remainingMinutes:101, totalMinutes:150, usesAi:true, presetWeights:{video:0,photo:0,ai:1}, perImageCredits:2, creditBalance:4530, minuteCreditRate:2, hasAvatar:false, targetClipCount:count});
  assert.equal(card,receipt.estimatedAiImages,`card and receipt agree for count ${count}`);
}
assert.equal(heroImageCardCount({...base, selected:false, countTouched:false, targetClipCount:0}),8);
assert.equal(heroImageCardCount({...base, selected:false, targetClipCount:0}),5,"explicit automatic choice survives source switch");
assert.equal(heroImageCardCount({...base, selected:false, countTouched:false}),5,"existing manual selection survives source switch");
assert.equal(heroImageCardCount({...base, upload:true, durationSec:9}),0,"short upload has no cutaways");
assert.equal(heroImageCardCount({...base, upload:true, durationSec:18}),3,"upload count respects cutaway density");
assert.equal(heroImageCardCount({...base, selected:false, countTouched:false, targetClipCount:0, starterRemaining:3}),3);
console.log("PASS: Hero image source cards track receipt counts and selection defaults");
