// HERO-56: each scene brief names its own place and action, and does not invent a pointing hand.
import { compileBrandVisualPrompt } from "../src/lib/brand-visual-system";
import { buildHeroImagePrompt } from "../src/lib/hero-image-scene-brief";
import {
  assignDistinctShotScales,
  pointingGestureRequested,
} from "../src/lib/scene-brief-diversity";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const actions = [
  "sort paper invoices into a tray",
  "walk through a warehouse aisle",
  "sort paper invoices into a tray",
];
const scales = assignDistinctShotScales(actions);
check("same action keeps one shot scale", scales[0] === scales[2]);
check("different actions get different shot scales", scales[0] !== scales[1]);

const beat = {
  phase: "explain" as const,
  subject: "a shop owner and a stack of invoices",
  action: "sort paper invoices into a tray",
  setting: "a small stock room",
  emotion: "focused",
  emphasis: "the invoices",
};

function cinematic(action: string, shotScale: string) {
  return compileBrandVisualPrompt({
    visualFormatId: "cinematic-realism",
    contentDomain: "small business bookkeeping",
    treatment: "calm documentary clarity",
    visualBeat: { ...beat, action },
    sceneShotScale: shotScale,
  });
}

const sorting = cinematic(actions[0], scales[0]);
const walking = cinematic(actions[1], scales[1]);
check("prompt names the scene place", sorting.positive.includes("Scene place: a small stock room"));
check("prompt names the scene action", sorting.positive.includes(`Scene action: ${actions[0]}`));
check("prompt carries the assigned shot scale", sorting.positive.includes(`Shot scale: ${scales[0]}`));
check("unrequested pointing is refused", sorting.positive.includes("No pointing hand and no pointing finger."));
check("different actions stay different in the prompt", sorting.positive !== walking.positive);
check("walking prompt uses its own scale", walking.positive.includes(`Shot scale: ${scales[1]}`));

const pointing = cinematic("points at the invoice tray", "close detail view");
check("requested pointing is allowed", pointing.positive.includes("A pointing gesture is allowed only because this scene action asks for it."));
check("requested pointing is not banned", !pointing.positive.includes("No pointing hand and no pointing finger."));
check("detector sees an explicit point", pointingGestureRequested("points at the invoice tray"));
check("detector ignores a non-pointing action", !pointingGestureRequested(actions[0]));

const brief = buildHeroImagePrompt({
  sceneIndex: 0,
  narrativeBeat: "explain",
  subject: "a shop owner",
  setting: "a small stock room",
  action: "sort paper invoices into a tray",
  visualMode: "documentary",
  camera: "eye-level medium shot",
  lighting: "window light",
  palette: "warm wood",
  includesInterface: false,
});
check("unpinned brief names the place", brief.includes("Scene place: a small stock room"));
check("unpinned brief refuses an unrequested pointing hand", brief.includes("No pointing hand and no pointing finger."));

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("scene brief diversity ok");
