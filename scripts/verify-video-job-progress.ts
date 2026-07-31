import assert from "node:assert/strict";

import { videoJobProgressPresentation } from "../src/lib/video-job-progress";

const composite = videoJobProgressPresentation("composite", 86);
assert.equal(composite.indeterminate, true);
assert.equal(composite.ringText, null);
assert.match(composite.statusText ?? "", /ประกอบวิดีโอ/);

const render = videoJobProgressPresentation("render", 57.8);
assert.equal(render.indeterminate, false);
assert.equal(render.percent, 58);
assert.equal(render.ringText, "58%");
assert.equal(render.statusText, null);

const bounded = videoJobProgressPresentation("render", 999);
assert.equal(bounded.percent, 100);

console.log("ALL PASS");
