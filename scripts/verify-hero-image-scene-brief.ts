import assert from "node:assert/strict";
import {
  buildHeroImagePrompt,
  planHeroImageScenes,
  resolveHeroImageProviderStyle,
} from "../src/lib/hero-image-scene-brief";
import { buildArtworkOnlyPrompt } from "../src/lib/ai-image-policy";

async function main() {
const fullScript = [
  "ร้านเล็กไม่ได้แพ้เพราะสินค้าไม่ดี แต่แพ้เพราะภาพเล่าเรื่องไม่ตรง",
  "ลองเริ่มจากดูว่าลูกค้าตัดสินใจตรงไหน แล้วค่อยออกแบบภาพให้ตอบจังหวะนั้น",
].join("\n");

const scenes = [
  {
    sceneIndex: 3,
    text: "ร้านเล็กไม่ได้แพ้เพราะสินค้าไม่ดี",
    fallbackSubject: "small business product quality",
  },
  {
    sceneIndex: 4,
    text: "ดูว่าลูกค้าตัดสินใจตรงไหน",
    fallbackSubject: "customer purchase decision",
  },
];

let capturedPrompt = "";
const planned = await planHeroImageScenes(
  {
    fullScript,
    scenes,
    visualDirection: "honest, grounded and observational",
    region: "thai",
    style: "auto",
  },
  async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      scenes: [
        {
          sceneIndex: 3,
          narrativeBeat: "The product is strong but its story is not reaching buyers.",
          subject: "a Thai ceramic maker checking the glaze on one handmade cup",
          setting: "a working pottery studio in Chiang Mai",
          action: "the maker turns the cup slowly under daylight and notices a fine detail",
          visualMode: "documentary",
          camera: "intimate shoulder-height medium close-up",
          lighting: "soft window daylight with true-to-life contrast",
          palette: "earthy clay, warm wood and neutral linen",
          includesInterface: false,
        },
        {
          sceneIndex: 4,
          narrativeBeat: "Find the exact moment where a customer makes a choice.",
          subject: "a shop owner reviewing one real checkout journey",
          setting: "a quiet local studio desk with a laptop",
          action: "one hand pauses over a single decision point on the checkout flow",
          visualMode: "interface",
          camera: "natural over-the-shoulder close shot",
          lighting: "late-afternoon side light with restrained screen glow",
          palette: "charcoal, warm paper and muted amber",
          includesInterface: true,
        },
      ],
    });
  },
);

assert.equal(planned.source, "llm");
assert.equal(planned.briefs.length, 2);
assert.match(capturedPrompt, /ร้านเล็กไม่ได้แพ้เพราะสินค้าไม่ดี/);
assert.match(capturedPrompt, /ดูว่าลูกค้าตัดสินใจตรงไหน/);
assert.match(capturedPrompt, /FULL SCRIPT/i);
assert.match(capturedPrompt, /not stock search queries/i);

const documentaryPrompt = buildHeroImagePrompt(planned.briefs[0], {
  region: "thai",
  style: "auto",
});
const interfacePrompt = buildHeroImagePrompt(planned.briefs[1], {
  region: "thai",
  style: "auto",
});

assert.match(documentaryPrompt, /ceramic maker/i);
assert.match(documentaryPrompt, /pottery studio/i);
assert.match(documentaryPrompt, /documentary/i);
assert.doesNotMatch(documentaryPrompt, /art-directed cinematic vertical 9:16 visual story/i);
assert.doesNotMatch(documentaryPrompt, /interfaces expressed through abstract/i);
assert.doesNotMatch(documentaryPrompt, /\b(?:collage|grid|panel|contact sheet|mockup|layout)\b/i);
assert.match(documentaryPrompt, /one uninterrupted edge-to-edge camera view/i);
assert.match(interfacePrompt, /checkout flow/i);
assert.match(interfacePrompt, /single.*interface|interface.*single/i);
// The prominence constraint is genuine scene guidance at the layer that owns
// scene content (ADR 0006), and it fires only when the planner already chose
// `visualMode: "interface"`, so it introduces no object of its own. The art
// direction that used to trail it — "using simple abstract unlabeled states" —
// flattened the screen and contradicted ADR 0007's English permission, and must
// not come back in any wording.
assert.match(
  interfacePrompt,
  /a single believable interface may appear only as an in-context story element,/,
  "the in-context prominence constraint stays; it is what stops a UI mockup becoming the frame",
);
assert.doesNotMatch(
  interfacePrompt,
  /unlabeled|unmarked|abstract (?:visual )?states|\bblank\b/i,
  "no anti-text art direction may flatten the screen the brief asked for",
);

assert.equal(resolveHeroImageProviderStyle(planned.briefs[0], "auto"), "photoreal");
assert.equal(resolveHeroImageProviderStyle(planned.briefs[1], "auto"), "editorial");
assert.equal(resolveHeroImageProviderStyle(planned.briefs[0], "surreal"), "illustration");
assert.equal(resolveHeroImageProviderStyle(planned.briefs[0], "lifestyle"), "photoreal");

const noUiGuard = buildArtworkOnlyPrompt(documentaryPrompt, "photoreal");
assert.doesNotMatch(noUiGuard.positive, /screens display abstract visual states/i);
assert.doesNotMatch(noUiGuard.positive, /\b(?:collage|grid|panel|contact sheet|mockup|layout)\b/i);
// ADR 0007: the wrapper no longer restates interface art direction. Whether a
// screen appears, and what it shows, is scene content owned by the Visual Beat —
// `buildHeroImagePrompt` states it there when the brief asks for one — and under
// ADR 0007 a screen may legitimately show plausible English UI.
const uiGuard = buildArtworkOnlyPrompt(interfacePrompt, "editorial");
assert.match(uiGuard.positive, /interface|screen/i);
assert.doesNotMatch(
  uiGuard.positive,
  /the single in-context screen or interface/i,
  "the artwork wrapper must not re-state screen art direction the Visual Beat already owns",
);

const fallback = await planHeroImageScenes(
  { fullScript, scenes, visualDirection: "grounded", region: "thai", style: "documentary" },
  async () => {
    throw new Error("planner unavailable");
  },
);
assert.equal(fallback.source, "fallback");
assert.deepEqual(fallback.briefs.map((brief) => brief.sceneIndex), [3, 4]);
assert.ok(fallback.briefs.every((brief) => brief.narrativeBeat.length > 0));
assert.ok(fallback.briefs.every((brief) => !brief.includesInterface));

console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
