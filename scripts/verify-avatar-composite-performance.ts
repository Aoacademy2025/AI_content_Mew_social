import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { shouldCropAvatarToVisibleCanvas } from "../src/lib/avatar-layout";
import { buildCompositeFilter } from "../src/lib/chroma-key";

const params = { color: "0x12FF05", similarity: 0.28, blend: 0.1 };
const zoomedLayout = { scale: 2.5, offsetX: 0.8, offsetY: -0.7 };
const onCanvasLayout = { scale: 0.5, offsetX: 0, offsetY: 0 };

// Large/off-canvas avatars must discard invisible source pixels before the expensive
// upscale + chromakey/despill/feather chain. Scaling first is functionally correct but
// makes Full mode process millions of pixels that can never reach the output canvas.
assert.equal(
  shouldCropAvatarToVisibleCanvas(zoomedLayout),
  true,
  "overflow crop is a layout decision, not a canary-user flag",
);
const cropped = buildCompositeFilter(
  params,
  zoomedLayout,
  true,
  [],
  shouldCropAvatarToVisibleCanvas(zoomedLayout),
);
const foreground = cropped.split(";").find((part) => part.startsWith("[1:v]")) ?? "";
assert.ok(foreground.includes("crop="), "zoomed overflow layout should crop the avatar source");
assert.ok(
  foreground.indexOf("crop=") < foreground.indexOf("scale="),
  `avatar source crop must run before scale/keying: ${foreground}`,
);

assert.equal(shouldCropAvatarToVisibleCanvas(onCanvasLayout), false, "on-canvas layouts skip crop");
const onCanvas = buildCompositeFilter(
  params,
  onCanvasLayout,
  true,
  [],
  shouldCropAvatarToVisibleCanvas(onCanvasLayout),
);
const onCanvasForeground = onCanvas.split(";").find((part) => part.startsWith("[1:v]")) ?? "";
assert.equal(onCanvasForeground.includes("crop="), false, "on-canvas layout keeps the uncropped scale+key chain");

const routePath = path.join(process.cwd(), "src/app/api/heygen/composite/route.ts");
const routeSource = fs.readFileSync(routePath, "utf8");
// One-sided and two-sided bookends share the segmented implementation: only the short
// avatar ends are keyed, while the middle is a plain encode and the stitch is a stream copy.
const splitStart = routeSource.indexOf("async function applyBookendSegmented(");
const splitEnd = routeSource.indexOf("// POST /api/heygen/composite", splitStart);
assert.ok(splitStart >= 0 && splitEnd > splitStart, "segmented bookend implementation not found");
const splitSource = routeSource.slice(splitStart, splitEnd);
const concatStart = splitSource.indexOf("// Concat video-only first");
const muxStart = splitSource.indexOf("// Mux audio from full bg", concatStart);
assert.ok(concatStart >= 0 && muxStart > concatStart, "bookend-both concat step not found");
const concatSource = splitSource.slice(concatStart, muxStart);
assert.match(concatSource, /"-c:v",\s*"copy"/);

const segmentedDispatch = routeSource.slice(
  routeSource.indexOf("// Segmented bookends:"),
  routeSource.indexOf("// Standard composite"),
);
assert.match(segmentedDispatch, /avatarTiming === "bookend"/);
assert.match(segmentedDispatch, /avatarTiming === "bookend-both"/);
assert.match(segmentedDispatch, /await applyBookendSegmented\(/);
assert.match(
  segmentedDispatch,
  /shouldCropAvatarToVisibleCanvas\(\s*layout\s*\)/,
  "bookend chromakey must crop overflow layouts for every user",
);
assert.match(
  routeSource,
  /await chromakeyComposite\([\s\S]*shouldCropAvatarToVisibleCanvas\(\s*layout\s*\)/,
  "full chromakey must crop overflow layouts for every user",
);
assert.equal(
  /await chromakeyComposite\([\s\S]*?stabilityCanary\s*,?\s*\)/.test(routeSource),
  false,
  "full chromakey crop must not be gated on the stability canary",
);

const queueMark = routeSource.indexOf('"composite_queue", 86');
const acquire = routeSource.indexOf("admission.acquireComposite", queueMark);
const activeMark = routeSource.indexOf('"composite", 87', acquire);
assert.ok(
  queueMark >= 0 && acquire > queueMark && activeMark > acquire,
  "composite route should expose queued state before admission and active state after admission",
);

console.log("ALL PASS");
