// Unit tests for buildKieImagePrompt (run: npx tsx scripts/verify-kie-image-prompt.ts)
//
// ROOT CAUSE this fixes: the old kie prompt was `${query}, cinematic photo, ...`
// where query was a 2–5 word STOCK SEARCH keyword (or a raw Thai subtitle) — both
// yield generic, off-topic AI images. The new prompt composes a real English scene
// description from the keyword + the script's relevance spec + visual direction.
import { buildKieImagePrompt } from "../src/lib/kie-image-prompt";
import type { RelevanceTerms } from "../src/lib/relevance-spec";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const terms: RelevanceTerms = {
  positive: ["bitcoin coin", "trading chart", "candlestick"],
  avoid: ["cartoon"],
  fallbackQueries: ["finance"],
  domainLabel: "cryptocurrency finance",
};

// subject is always present and leads the prompt
const p1 = buildKieImagePrompt("bitcoin price surge", { visualDirection: "tense, dramatic newsroom lighting.", terms });
check("includes the subject", p1.toLowerCase().includes("bitcoin price surge"));
check("includes the domain", p1.toLowerCase().includes("cryptocurrency finance"));
check("includes concrete concepts", p1.toLowerCase().includes("bitcoin coin"));
check("includes visual direction", p1.toLowerCase().includes("newsroom"));
// ADR 0007 + ADR 0006. The look line is lighting and finish only. Its old tail
// ("purely visual language-free surfaces, blank unmarked signs and labels") was
// an anti-text guardrail written as positive art direction, which a model obeys
// as a composition instruction — the defect that produced flat walls and blank
// signs. Neither engine this prompt reaches has a negative channel, so nothing
// may replace it: any clause here is something the model tries to draw.
check("look line is lighting and finish only", /natural lighting, realistic detail, sharp focus\.$/.test(p1));
check("no blanking art direction", !/language-free|unmarked|unlabeled|\bblank\b/i.test(p1));
check("ends as one sentence", p1.trim().endsWith("."));
check("limits concepts to <=2", (p1.match(/bitcoin coin|trading chart|candlestick/gi) ?? []).length <= 2);

// degrades gracefully with no spec/direction
const p2 = buildKieImagePrompt("a quiet morning coffee", { terms: null });
check("no-spec: still has subject", p2.toLowerCase().includes("quiet morning coffee"));
check("no-spec: still ends on the look line", /natural lighting, realistic detail, sharp focus\.$/.test(p2));
check("no-spec: no blanking art direction", !/language-free|unmarked|unlabeled|\bblank\b/i.test(p2));
check("no-spec: no 'general' domain leaks in", !/in a general setting/i.test(p2));

// empty subject must not crash and must still produce a usable prompt
const p3 = buildKieImagePrompt("", { terms });
check("empty subject: falls back to domain", p3.toLowerCase().includes("cryptocurrency finance"));

// NEVER reuse the bare old template
check("not the old bare template", !/^\s*, cinematic photo/i.test(buildKieImagePrompt("x")));

// region clause is a primary clause, not a truncatable tail
const thai = buildKieImagePrompt("street food vendor cooking", { region: "thai" });
check("thai clause present", /Thai or Southeast Asian/.test(thai));
check("thai clause early in prompt", thai.indexOf("Thai") < thai.length / 2);

const euro = buildKieImagePrompt("business meeting", { region: "european" });
check("european clause present", /European or Western/.test(euro));

// style changes the base look — no photorealistic lock-in
const surreal = buildKieImagePrompt("time and money", { style: "surreal" });
check("surreal not photorealistic", !/photorealistic photograph/.test(surreal));
check("surreal look present", /surreal|dreamlike/i.test(surreal));

const cinematic = buildKieImagePrompt("city at night", { style: "cinematic" });
check("cinematic film still", /film still|dramatic lighting/i.test(cinematic));

// default unchanged shape
const def = buildKieImagePrompt("coffee shop");
check("default photorealistic", /cinematic, photorealistic vertical 9:16 photograph/.test(def));
check("default keeps a positive single-view guard", /one unified edge-to-edge composition.*one spatially continuous camera view/.test(def));
check("default does not cue unwanted layouts", !/collage|grid|storyboard|split screen/.test(def));

// no-people region
const nop = buildKieImagePrompt("desk setup", { region: "no-people" });
check("no-people clause", /unoccupied setting focused exclusively on objects/.test(nop));

// Hero AI Auto B-roll must use the generative model as an art director, not
// produce a batch of near-identical stock-search images. This fixture mirrors
// duckyhero's repeated global relevance terms from the production incident.
const repeatedTerms: RelevanceTerms = {
  positive: ["product", "smartphone"],
  avoid: [],
  fallbackQueries: [],
  domainLabel: "AI product photography and image editing",
};
const creativeSubjects = [
  "remove background workflow",
  "free trial decision",
  "color accuracy inspection",
  "brand authenticity",
  "creative studio planning",
];
const creativePrompts = creativeSubjects.map((subject, sceneIndex) =>
  buildKieImagePrompt(subject, {
    terms: repeatedTerms,
    visualDirection: "bright clean creative energy",
    creativeBrollSceneIndex: sceneIndex,
  }),
);
const tokenSet = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const pairwiseJaccard: number[] = [];
for (let left = 0; left < creativePrompts.length; left += 1) {
  for (let right = left + 1; right < creativePrompts.length; right += 1) {
    const a = tokenSet(creativePrompts[left]);
    const b = tokenSet(creativePrompts[right]);
    const intersection = [...a].filter((token) => b.has(token)).length;
    pairwiseJaccard.push(intersection / (a.size + b.size - intersection));
  }
}
const averageJaccard = pairwiseJaccard.reduce((sum, value) => sum + value, 0) / pairwiseJaccard.length;
check(
  "creative B-roll does not force global props into every scene",
  creativePrompts.every((prompt) => !/featuring product and smartphone/i.test(prompt)),
);
check(
  "creative B-roll uses authored visual storytelling",
  creativePrompts.every((prompt) => /art-directed|visual storytelling|editorial/i.test(prompt)),
);
check(
  "creative B-roll prompt batch stays visually diverse",
  averageJaccard < 0.62,
  `average token similarity=${averageJaccard.toFixed(3)}`,
);
// The creative branch carried the same defect in a worse form: it appended
// "interfaces expressed through abstract unlabeled color shapes and visual
// states, blank unmarked text areas" to EVERY creative window, pushing an
// interface into scenes whose subject had none and asking for empty rectangles.
check(
  "creative B-roll no longer injects an interface into every scene",
  creativePrompts.every((prompt) => !/interfaces expressed through abstract/i.test(prompt)),
);
check(
  "creative B-roll carries no blanking art direction",
  creativePrompts.every((prompt) => !/language-free|unmarked|unlabeled|\bblank\b/i.test(prompt)),
);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kie-image-prompt checks passed.");
