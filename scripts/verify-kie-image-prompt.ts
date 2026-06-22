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
check("has anti-text guard", /no text, no watermark/i.test(p1));
check("ends as one sentence", p1.trim().endsWith("."));
check("limits concepts to <=2", (p1.match(/bitcoin coin|trading chart|candlestick/gi) ?? []).length <= 2);

// degrades gracefully with no spec/direction
const p2 = buildKieImagePrompt("a quiet morning coffee", { terms: null });
check("no-spec: still has subject", p2.toLowerCase().includes("quiet morning coffee"));
check("no-spec: still has anti-text guard", /no text, no watermark/i.test(p2));
check("no-spec: no 'general' domain leaks in", !/in a general setting/i.test(p2));

// empty subject must not crash and must still produce a usable prompt
const p3 = buildKieImagePrompt("", { terms });
check("empty subject: falls back to domain", p3.toLowerCase().includes("cryptocurrency finance"));

// NEVER reuse the bare old template
check("not the old bare template", !/^\s*, cinematic photo/i.test(buildKieImagePrompt("x")));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll kie-image-prompt checks passed.");
