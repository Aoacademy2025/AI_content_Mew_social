// HERO-55: a staged B-roll upload is visible at its window without a render job.
import { stagedBrollOverlayAt } from "../src/lib/staged-broll-preview";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const spans = [
  { index: 0, startMs: 0, endMs: 4000 },
  { index: 1, startMs: 4000, endMs: 8000 },
];
const edits = new Map<number, { src?: string; enabled?: boolean }>([
  [1, { src: "/api/stocks/broll-upload-new.mp4" }],
]);

const inside = stagedBrollOverlayAt(4500, spans, edits);
check("shows the staged asset inside its window", inside?.src === "/api/stocks/broll-upload-new.mp4");
check("offset starts at the window", inside?.offsetSec === 0.5);

const before = stagedBrollOverlayAt(3999, spans, edits);
check("hides the staged asset before the window", before === null);

const hidden = stagedBrollOverlayAt(4500, spans, new Map([
  [1, { src: "/api/stocks/broll-upload-new.mp4", enabled: false }],
]));
check("hides a window whose B-roll is turned off", hidden === null);

const untouched = stagedBrollOverlayAt(1000, spans, edits);
check("leaves an unedited window alone", untouched === null);

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("staged b-roll preview ok");
