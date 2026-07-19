//   npx tsx scripts/verify-broll-window-sticky-bar.ts
import fs from "fs";

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error("FAIL " + message);
    process.exit(1);
  }
  console.log("PASS " + message);
  passed++;
}

const broll = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx", "utf8");
const post = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
const mobile = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");

assert(/export function WindowEditsBottomBar/.test(broll), "B-roll edits use a bottom action bar component");
assert(!/WindowEditsStickyBar/.test(broll + post + mobile), "old top-mounted sticky bar is removed");
assert(/bottom:\s*["']0["']/.test(broll), "bottom bar is locked to the bottom edge");
assert(post.indexOf("<TimelinePanel") >= 0 && post.indexOf("<TimelinePanel") < post.indexOf("<WindowEditsBottomBar"), "desktop bottom bar mounts after the timeline");
assert(mobile.indexOf("<WindowEditsBottomBar") >= 0, "mobile post phase mounts the bottom bar");

console.log(`\n${passed} checks passed`);
