// HERO-44 follow-up, found by clicking through editor v2 on prod: on an uploaded clip a
// customer picked a clip, pressed the free update, and nothing changed — the window was
// still "off", so it took a second update to see one fill. Plus three labels that misread.
import { readFileSync } from "node:fs";
import {
  PRESENTER_KEYWORD,
  brollTimelineLabel,
  pickTurnsWindowOn,
  seedSearchKeyword,
  windowSourceLabelOverride,
} from "../src/lib/broll-window-ux";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok - ${msg}`);
  else { failed++; console.error(`  FAIL - ${msg}`); }
}

console.log("picking a clip for a window that is off");
assert(pickTurnsWindowOn({ currentlyEnabled: false, stagedEnabled: undefined }) === true, "an off window is turned on by the pick");
assert(pickTurnsWindowOn({ currentlyEnabled: true, stagedEnabled: undefined }) === false, "a window that is already on is left alone");
assert(pickTurnsWindowOn({ currentlyEnabled: false, stagedEnabled: false }) === false, "a window the customer switched off in this session stays off");
assert(pickTurnsWindowOn({ currentlyEnabled: true, stagedEnabled: true }) === false, "an explicit on needs nothing more");

console.log("timeline labels");
assert(brollTimelineLabel({ enabled: true, label: "coffee", src: "/api/stocks/a.mp4" }) === "coffee", "a visible window shows its label");
assert(brollTimelineLabel({ enabled: false, label: "คลิป 2", src: "" }) === "ว่าง · คลิป 2", "an unfilled window reads as empty, not as switched off");
assert(brollTimelineLabel({ enabled: false, label: PRESENTER_KEYWORD, src: "/api/renders/p.mp4" }) === "คลิปของคุณ", "a presenter window reads as the customer's own clip");
assert(brollTimelineLabel({ enabled: false, label: "coffee", src: "/api/stocks/a.mp4" }) === "ปิด · coffee", "a filled window the customer switched off still reads as off");

console.log("inspector");
assert(seedSearchKeyword(PRESENTER_KEYWORD) === "", "the stock search box is not seeded with the internal presenter keyword");
assert(seedSearchKeyword("coffee") === "coffee", "a real keyword still seeds the search box");
assert(seedSearchKeyword(undefined) === "", "no keyword seeds nothing");
assert(windowSourceLabelOverride({ keyword: PRESENTER_KEYWORD, timelineAligned: true }) === "คลิปของคุณ", "a presenter window is not labelled สต็อก");
assert(windowSourceLabelOverride({ keyword: "coffee" }) === null, "other windows keep their normal source label");

console.log("wiring");
const inspector = readFileSync("src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx", "utf8");
const markEdited = inspector.match(/function markEdited\([\s\S]*?\n  \}\n/);
assert(Boolean(markEdited) && /pickTurnsWindowOn\(/.test(markEdited![0]) && /enabled: true/.test(markEdited![0]), "every stock / upload / AI pick goes through the rule");
assert(!/จะยังไม่แสดงจนกว่าจะเปิด B-roll ช่วงนี้/.test(inspector), "the banner no longer tells the customer a pick stays hidden");
assert(/seedSearchKeyword\(/.test(inspector) && /windowSourceLabelOverride\(/.test(inspector), "the inspector uses the shared label rules");
const timeline = readFileSync("src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx", "utf8");
assert(/brollTimelineLabel\(/.test(timeline) && !/`ปิด · \$\{s\.label\}`/.test(timeline), "the timeline uses the shared label rule");
const step2 = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
assert(/p\.brollSource === "none"[\s\S]{0,80}เติมเองทีละช่วง/.test(step2), "the upload summary stops promising cutaways when the customer fills B-roll themselves");

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
