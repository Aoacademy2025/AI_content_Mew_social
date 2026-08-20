import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function main() {
  const {
    loadBrandTreatmentBenchmarkFixtures,
    buildBrandTreatmentBenchmarkCases,
    buildBrandTreatmentV10BenchmarkCases,
    buildBrandTreatmentEditorialV7SmokeCases,
    buildBrandTreatmentHardFactsLetteringV8ProbeCases,
    buildBrandTreatmentPositiveOnlyV9ProbeCases,
    buildBrandTreatmentCompletedStateV10ProbeCases,
    buildBrandTreatmentRelationalV11ProbeCases,
    buildBrandTreatmentV6SmokeCases,
  } = await import("../src/lib/brand-treatment-benchmark");
  const fixtures = loadBrandTreatmentBenchmarkFixtures();
  assert.equal(fixtures.length, 8);
  assert.ok(fixtures.every((fixture) => fixture.scenes.length === 3));
  assert.deepEqual(new Set(fixtures.flatMap((fixture) => fixture.scenes.map((scene) => scene.phase))), new Set(["hook", "explain", "close"]));
  assert.ok(fixtures.flatMap((fixture) => fixture.scenes).every((scene) => (
    scene.hardSceneFacts.entityTypes.length > 0
    && scene.hardSceneFacts.actions.length > 0
    && scene.hardSceneFacts.locationTypes.length > 0
  )));

  const cases = buildBrandTreatmentBenchmarkCases(fixtures);
  assert.equal(cases.length, 8 * 5 * 3);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 120);
  assert.equal(cases.filter((entry) => entry.visualFormatId === "simple-editorial-story").length, 24);
  assert.equal(cases.filter((entry) => entry.visualFormatId === "stick-figure-story").length, 0);
  assert.ok(cases.every((entry) => (
    entry.compiled.recipeVersion.endsWith("-v9")
    || entry.compiled.recipeVersion === "cinematic-realism-v10"
    || entry.compiled.recipeVersion === "simple-editorial-story-v11"
  )));
  assert.ok(cases.every((entry) => entry.compiled.treatmentPin?.version === "v1.0.0"));
  assert.ok(cases.every((entry) => (
    entry.compiled.positive.indexOf("Hard scene facts:")
    < entry.compiled.positive.indexOf("Count-safe flexible scene direction:")
  )));
  assert.ok(cases.every((entry) => entry.compiled.positive.includes("Final hard-fact check:")));
  const kongRegression = cases.filter((entry) => entry.fixtureSceneId === "horror-funeral-human");
  assert.equal(
    fixtures.flatMap((fixture) => fixture.scenes).find((scene) => scene.id === "horror-funeral-human")?.internalProperName,
    "Kong",
    "the approved ambiguity token stays only as internal fixture linkage",
  );
  assert.equal(kongRegression.length, 5);
  assert.ok(kongRegression.every((entry) => /adult Thai human man/i.test(entry.compiled.positive)));
  assert.ok(kongRegression.every((entry) => !/\bKong\b/i.test(entry.compiled.positive)));
  assert.ok(cases.some((entry) => entry.compiled.positive.includes("illustrative editorial concept")));
  assert.ok(cases.some((entry) => entry.compiled.positive.includes("unidentifiable fictional silhouettes")));

  const currentRepairClose = cases.filter((entry) => entry.fixtureSceneId === "documentary-repair-close");
  assert.equal(currentRepairClose.length, 5);
  assert.ok(currentRepairClose.every((entry) => /stands upright beside the completed kitchen sink with both hands relaxed at their sides/i.test(
    entry.compiled.positive,
  )), "every active format stages the completed repair after verification");
  assert.ok(currentRepairClose.every((entry) => !/dripping|drops?|water|flowing|\bchecks\b|inspection|\bcontrols?\b/i.test(
    entry.compiled.positive,
  )), "completed-result prompts do not reintroduce the failed tap state or control action");

  const currentDramaClose = cases.filter((entry) => entry.fixtureSceneId === "drama-bus-close");
  assert.equal(currentDramaClose.length, 5);
  assert.ok(currentDramaClose.every((entry) => (
    /carrying exactly one cloth bag together/i.test(entry.compiled.positive)
    && /exactly one cloth bag shared by both women/i.test(entry.compiled.positive)
  )), "every active format receives the shared-bag relationship");

  const currentPremiumExplain = cases.filter((entry) => entry.fixtureSceneId === "premium-serum-explain");
  assert.equal(currentPremiumExplain.length, 5);
  assert.ok(currentPremiumExplain.every((entry) => (
    /exactly one clear drop from the amber bottle onto one clean fingertip/i.test(entry.compiled.positive)
    && /exactly one clear drop touching one clean fingertip/i.test(entry.compiled.positive)
  )), "every active format receives the drop destination and visible contact");

  const currentNewsHook = cases.filter((entry) => entry.fixtureSceneId === "news-files-hook");
  assert.equal(currentNewsHook.length, 5);
  assert.ok(currentNewsHook.every((entry) => (
    /exactly one visibly empty chair/i.test(entry.compiled.positive)
    && /seat and surrounding opening unobstructed/i.test(entry.compiled.positive)
  )), "the investigative hook keeps an affirmative visibly empty chair");

  const currentHorrorClose = cases.filter((entry) => entry.fixtureSceneId === "horror-house-close");
  assert.equal(currentHorrorClose.length, 5);
  assert.ok(currentHorrorClose.every((entry) => (
    /grips the wooden door with one hand and pulls it nearly shut/i.test(entry.compiled.positive)
    && /wooden door nearly shut with the woman's hand visibly gripping its edge/i.test(entry.compiled.positive)
  )), "the door-closing action remains visibly connected to the subject");

  const currentExpertClose = cases.find((entry) => (
    entry.visualFormatId === "cinematic-realism" && entry.fixtureSceneId === "expert-clinic-close"
  ));
  assert.match(
    currentExpertClose?.compiled.positive ?? "",
    /every visible surface is filled edge-to-edge by its native photographic material, color, light and texture/i,
    "the cinematic recipe reserves every surface for the depicted environment instead of a generic lettering surface",
  );
  assert.doesNotMatch(
    currentExpertClose?.compiled.positive ?? "",
    /every wall, garment, object and background surface presents one continuous visually plain material texture/i,
    "the cinematic recipe does not force unrelated scenes onto the same plain-wall tableau",
  );
  assert.doesNotMatch(currentExpertClose?.compiled.positive ?? "", /checklist|dashboard|timeline|records page/i);

  const relationalV11Probe = buildBrandTreatmentRelationalV11ProbeCases(cases);
  const expectedRelationalV11ProbeIds = [
    "expert-clarity__cinematic-realism__expert-clinic-close",
    "expert-clarity__cinematic-realism__expert-clinic-explain",
    "expert-clarity__clear-infographic__expert-clinic-hook",
    "practical-documentary__dramatic-comic__documentary-repair-close",
    ...["cinematic-realism", "simple-editorial-story", "dramatic-comic", "clear-infographic", "retro-story"]
      .map((format) => `thai-human-drama__${format}__drama-bus-close`),
    ...["cinematic-realism", "simple-editorial-story", "dramatic-comic", "clear-infographic", "retro-story"]
      .map((format) => `premium-product-lifestyle__${format}__premium-serum-explain`),
    "investigative-news-crime__dramatic-comic__news-files-hook",
    "thai-history-period-storytelling__cinematic-realism__history-river-close",
    "thai-supernatural-horror__cinematic-realism__horror-house-close",
    "thai-supernatural-horror__retro-story__horror-house-close",
  ].sort();
  assert.deepEqual(relationalV11Probe.map((entry) => entry.id).sort(), expectedRelationalV11ProbeIds);
  assert.ok(relationalV11Probe.every((entry) => (
    entry.compiled.recipeVersion.endsWith("-v9")
    || entry.compiled.recipeVersion === "cinematic-realism-v10"
    || entry.compiled.recipeVersion === "simple-editorial-story-v11"
  )));

  const frozenV10Cases = buildBrandTreatmentV10BenchmarkCases();
  assert.equal(frozenV10Cases.length, 120);
  assert.ok(frozenV10Cases.every((entry) => (
    entry.compiled.recipeVersion.endsWith("-v8")
    || entry.compiled.recipeVersion === "simple-editorial-story-v10"
  )));
  const frozenV10DramaClose = frozenV10Cases.find((entry) => (
    entry.visualFormatId === "cinematic-realism" && entry.fixtureSceneId === "drama-bus-close"
  ));
  assert.match(frozenV10DramaClose?.compiled.positive ?? "", /required action walk home together/i);
  assert.doesNotMatch(frozenV10DramaClose?.compiled.positive ?? "", /shared by both women|carrying exactly one cloth bag together/i,
    "the paid V10 prompt remains reconstructable from its pre-repair fixture semantics");

  const smokeCases = buildBrandTreatmentEditorialV7SmokeCases();
  assert.equal(smokeCases.length, 32);
  assert.equal(smokeCases.filter((entry) => entry.visualFormatId === "simple-editorial-story").length, 24);
  assert.equal(smokeCases.filter((entry) => entry.visualFormatId === "stick-figure-story").length, 0);
  assert.equal(smokeCases.filter((entry) => entry.compiled.recipeVersion === "simple-editorial-story-v7").length, 24);
  for (const requiredId of [
    "expert-clarity__cinematic-realism__expert-clinic-explain",
    "expert-clarity__dramatic-comic__expert-clinic-hook",
    "practical-documentary__clear-infographic__documentary-repair-hook",
    "modern-business-technology__clear-infographic__business-orders-hook",
  ]) {
    assert.ok(smokeCases.some((entry) => entry.id === requiredId), `smoke matrix includes ${requiredId}`);
  }

  const historicalV6Smoke = buildBrandTreatmentV6SmokeCases();
  assert.equal(historicalV6Smoke.length, 32);
  assert.equal(historicalV6Smoke.filter((entry) => entry.visualFormatId === "stick-figure-story").length, 24);
  assert.ok(historicalV6Smoke.every((entry) => entry.compiled.recipeVersion.endsWith("-v6")),
    "the paid v6 artifact remains reproducible from its frozen 32 prompts");

  const practicalClose = fixtures
    .flatMap((fixture) => fixture.scenes)
    .find((scene) => scene.id === "documentary-repair-close");
  assert.ok(practicalClose?.hardSceneFacts.actions.includes("checks that the repaired tap has stopped dripping"),
    "the dry-tap result is an immutable scene fact, not flexible art direction");

  const dramaClose = fixtures
    .flatMap((fixture) => fixture.scenes)
    .find((scene) => scene.id === "drama-bus-close");
  assert.deepEqual(
    dramaClose?.hardSceneFacts.actions,
    ["walk home side by side carrying exactly one cloth bag together"],
    "the shared-bag action and relationship survive inside structured Hard Scene Facts",
  );
  assert.deepEqual(
    dramaClose?.hardSceneFacts.essentialObjects,
    ["exactly one cloth bag shared by both women"],
    "the shared essential object keeps its source quantity and owners",
  );

  const premiumExplain = fixtures
    .flatMap((fixture) => fixture.scenes)
    .find((scene) => scene.id === "premium-serum-explain");
  assert.deepEqual(
    premiumExplain?.hardSceneFacts.actions,
    ["dispense exactly one clear drop from the amber bottle onto one clean fingertip"],
    "the drop destination survives inside structured Hard Scene Facts",
  );
  assert.deepEqual(
    premiumExplain?.hardSceneFacts.entityTypes,
    ["adult human hands"],
    "the exact count applies to the two hands while the bottle keeps its own essential-object quantity",
  );
  assert.deepEqual(
    premiumExplain?.hardSceneFacts.essentialObjects,
    ["exactly one unbranded amber bottle", "exactly one clear drop touching one clean fingertip"],
    "the product, drop and fingertip relationship retain visible quantities",
  );

  const newsHook = fixtures
    .flatMap((fixture) => fixture.scenes)
    .find((scene) => scene.id === "news-files-hook");
  assert.deepEqual(
    newsHook?.hardSceneFacts.actions,
    ["sealed case folders rest beneath exactly one desk lamp beside exactly one visibly empty chair"],
    "the empty-chair relationship remains an affirmative visible Hard Scene Fact",
  );
  assert.deepEqual(
    newsHook?.hardSceneFacts.entityTypes,
    ["empty interview chair"],
    "the exact count applies to the chair while the evidence objects keep their own quantities",
  );
  assert.deepEqual(
    newsHook?.hardSceneFacts.essentialObjects,
    ["sealed case folders", "exactly one desk lamp", "exactly one visibly empty chair"],
  );

  const horrorClose = fixtures
    .flatMap((fixture) => fixture.scenes)
    .find((scene) => scene.id === "horror-house-close");
  assert.deepEqual(
    horrorClose?.hardSceneFacts.actions,
    ["grips the wooden door with one hand and pulls it nearly shut while holding exactly one oil lamp in her other hand"],
    "the door-closing contact and lamp relationship remain in Hard Scene Facts",
  );
  assert.deepEqual(
    horrorClose?.hardSceneFacts.essentialObjects,
    ["exactly one lit oil lamp", "wooden door nearly shut with the woman's hand visibly gripping its edge"],
  );

  const focusedV8Probe = buildBrandTreatmentHardFactsLetteringV8ProbeCases();
  assert.equal(focusedV8Probe.length, 12);
  assert.equal(new Set(focusedV8Probe.map((entry) => entry.id)).size, 12);
  assert.equal(focusedV8Probe.filter((entry) => entry.fixtureSceneId === "history-river-hook").length, 5,
    "the exact-one-boat regression covers every active format");
  assert.ok(focusedV8Probe.every((entry) => (
    entry.compiled.recipeVersion.endsWith("-v7")
    || entry.compiled.recipeVersion === "simple-editorial-story-v8"
  )));
  assert.ok(focusedV8Probe.every((entry) => entry.compiled.positive.includes("Lettering-safe visual plan:")));
  const historyProbe = focusedV8Probe.filter((entry) => entry.fixtureSceneId === "history-river-hook");
  assert.ok(historyProbe.every((entry) => entry.compiled.positive.includes(
    "the complete visible counted set is exactly 1 wooden trading boat",
  )));
  assert.ok(historyProbe.every((entry) => !/busy river gate|scale of river trade/i.test(entry.compiled.positive)));
  const expertExplain = focusedV8Probe.find((entry) => entry.fixtureSceneId === "expert-clinic-explain");
  assert.match(expertExplain?.compiled.positive ?? "", /exactly 1 adult Thai clinician/i);
  assert.match(expertExplain?.compiled.positive ?? "", /three abstract circles/i);
  const practicalCloseProbe = focusedV8Probe.find((entry) => entry.fixtureSceneId === "documentary-repair-close");
  assert.match(practicalCloseProbe?.compiled.positive ?? "", /has stopped dripping/i);
  const letteringProbe = focusedV8Probe.filter((entry) => [
    "expert-clinic-close",
    "business-orders-explain",
    "news-files-explain",
  ].includes(entry.fixtureSceneId));
  assert.ok(letteringProbe.every((entry) => !/checklist|dashboard|timeline|public records|workflow cards/i.test(
    entry.compiled.positive,
  )));

  const positiveOnlyV9Probe = buildBrandTreatmentPositiveOnlyV9ProbeCases();
  assert.equal(positiveOnlyV9Probe.length, 8);
  assert.equal(positiveOnlyV9Probe.filter((entry) => entry.fixtureSceneId === "history-river-hook").length, 5);
  assert.ok(positiveOnlyV9Probe.every((entry) => (
    entry.compiled.recipeVersion.endsWith("-v8")
    || entry.compiled.recipeVersion === "simple-editorial-story-v9"
  )));
  const v9Expert = positiveOnlyV9Probe.find((entry) => entry.fixtureSceneId === "expert-clinic-explain");
  assert.match(v9Expert?.compiled.positive ?? "", /exactly one water glass/i);
  const v9Repair = positiveOnlyV9Probe.find((entry) => entry.fixtureSceneId === "documentary-repair-close");
  assert.match(v9Repair?.compiled.positive ?? "", /dry and motionless repaired tap above a dry sink basin/i);
  assert.doesNotMatch(v9Repair?.compiled.positive ?? "", /dripping|droplets?|water drops?|flowing water/i);
  const v9Infographic = positiveOnlyV9Probe.find((entry) => (
    entry.visualFormatId === "clear-infographic" && entry.fixtureSceneId === "business-orders-hook"
  ));
  assert.match(v9Infographic?.compiled.positive ?? "", /wide uninterrupted background color surrounds every pictogram/i);
  assert.doesNotMatch(v9Infographic?.compiled.positive ?? "", /top-to-bottom visual hierarchy/i);

  const completedStateV10Probe = buildBrandTreatmentCompletedStateV10ProbeCases();
  assert.equal(completedStateV10Probe.length, 1);
  assert.equal(completedStateV10Probe[0]?.id,
    "practical-documentary__simple-editorial-story__documentary-repair-close");
  assert.equal(completedStateV10Probe[0]?.compiled.recipeVersion, "simple-editorial-story-v10");
  assert.match(completedStateV10Probe[0]?.compiled.positive ?? "",
    /stands upright beside the completed kitchen sink with both hands relaxed at their sides/i);
  assert.match(completedStateV10Probe[0]?.compiled.positive ?? "",
    /matte dry repaired tap above a matte dry sink basin/i);
  assert.doesNotMatch(completedStateV10Probe[0]?.compiled.positive ?? "",
    /dripping|drops?|water|flowing|\bchecks\b|inspection|controls?/i);

  const paidRunner = readFileSync(new URL("./run-brand-treatment-benchmark-v1.ts", import.meta.url), "utf8");
  assert.match(paidRunner, /publicZImageProviderInput/);
  assert.match(paidRunner, /warmup/);
  assert.match(paidRunner, /--smoke-v6/);
  assert.match(paidRunner, /--smoke-editorial-v7/);
  assert.match(paidRunner, /--probe-hard-facts-lettering-v8/);
  assert.match(paidRunner, /--probe-positive-only-v9/);
  assert.match(paidRunner, /--probe-completed-state-v10/);
  assert.match(paidRunner, /--probe-relational-v11/);
  assert.match(
    paidRunner,
    /const encodedWebp = await sharp\(bytes\)[\s\S]*?\.toBuffer\(\)[\s\S]*?writeFileSync\([^;]*encodedWebp\)[\s\S]*?update\(encodedWebp\)/,
    "the manifest checksum covers the exact encoded WebP bytes written to disk",
  );
  assert.doesNotMatch(
    paidRunner,
    /entry\.sha256 = createHash\("sha256"\)\.update\(bytes\)/,
    "the manifest must not checksum provider bytes before WebP normalization",
  );
  assert.doesNotMatch(paidRunner, /buildComfyWorkflow|--prewarmed/);

  console.log("verify-brand-treatment-benchmark-v1: PASS de-identified 8×5×3 dry matrix (120 prompts)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
