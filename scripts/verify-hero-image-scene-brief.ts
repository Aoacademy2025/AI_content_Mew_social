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
assert.match(interfacePrompt, /checkout flow/i);
assert.match(interfacePrompt, /single.*interface|interface.*single/i);

assert.equal(resolveHeroImageProviderStyle(planned.briefs[0], "auto"), "photoreal");
assert.equal(resolveHeroImageProviderStyle(planned.briefs[1], "auto"), "editorial");
assert.equal(resolveHeroImageProviderStyle(planned.briefs[0], "surreal"), "illustration");
assert.equal(resolveHeroImageProviderStyle(planned.briefs[0], "lifestyle"), "photoreal");

const noUiGuard = buildArtworkOnlyPrompt(documentaryPrompt, "photoreal");
assert.doesNotMatch(noUiGuard.positive, /screens display abstract visual states/i);
const uiGuard = buildArtworkOnlyPrompt(interfacePrompt, "editorial", { interfaceExpected: true });
assert.match(uiGuard.positive, /interface|screen/i);
assert.match(uiGuard.positive, /unlabeled/i);

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
