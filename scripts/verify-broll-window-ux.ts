// HERO-44 follow-up, found by clicking through editor v2 on prod: on an uploaded clip a
// customer picked a clip, pressed the free update, and nothing changed — the window was
// still "off", so it took a second update to see one fill. Plus three labels that misread.
import { readFileSync } from "node:fs";
import {
  PRESENTER_KEYWORD,
  brollTimelineLabel,
  emptyWindowHint,
  offWindowHint,
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
// Found on the phone layout on prod: PostPhaseMobile kept its own copy of the old label
// rule, so an unfilled window still read "ปิด · คลิป 1" there.
const mobile = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");
assert(/brollTimelineLabel\(/.test(mobile) && !/`ปิด · \$\{s\.label\}`/.test(mobile), "the phone layout uses the shared label rule too");
// The AI tab keeps its money guard (no image is generated for a window that is off), so the
// banner must not promise that an AI pick turns the window on by itself.
assert(!/หรือสร้างภาพ AI ด้านล่าง ระบบจะเปิด/.test(inspector), "the banner never promises that an AI pick turns the window on");
assert(/if \(!enabled\) \{ setAiError\(/.test(inspector), "the AI money guard for a window that is off is untouched");
// Found generating an AI image on prod: a fill-it-yourself video skips the content preflight,
// so it has no Project Visual Context and the AI tab is permanently disabled — yet the copy
// invited the customer to "สร้างภาพ AI", and the tooltip blamed an "old clip" on a new one.
assert(emptyWindowHint(true) === "ช่วงนี้ยังว่าง — เลือกสต็อก อัปโหลด หรือสร้างภาพ AI ด้านล่าง ถ้าไม่ใส่จะเป็นพื้นหลังสีแบรนด์", "with AI available the empty-window hint offers all three");
assert(!/AI/.test(emptyWindowHint(false)) && /เลือกสต็อกหรืออัปโหลด/.test(emptyWindowHint(false)), "without AI the empty-window hint offers only stock and upload");
assert(/สร้างภาพ AI/.test(offWindowHint(true)) && !/AI/.test(offWindowHint(false)), "the off-window banner mentions AI only where AI can be used");
assert(/emptyWindowHint\(sceneRerollEnabled\)/.test(inspector) && /offWindowHint\(sceneRerollEnabled\)/.test(inspector), "the inspector picks its copy from whether AI is available for this video");
const capability = readFileSync("src/lib/scene-reroll-capability.ts", "utf8");
assert(!/message: "คลิปเก่ายังไม่มีข้อมูลฉาก/.test(capability) && /ใส่ B-roll เอง/.test(capability), "the unavailable reason no longer calls a brand-new fill-it-yourself video an old clip");
const step2 = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
assert(/p\.brollSource === "none"[\s\S]{0,80}เติมเองทีละช่วง/.test(step2), "the upload summary stops promising cutaways when the customer fills B-roll themselves");

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
