import assert from "node:assert/strict";

async function main() {
  const {
    buildTreatmentChoiceGroups,
    buildVisualSummary,
    lookChangeConfirmation,
  } = await import("../src/lib/brand-treatment-presentation");

  const groups = buildTreatmentChoiceGroups("thai-supernatural-horror", [
    "thai-supernatural-horror",
    "thai-human-drama",
    "thai-history-period-storytelling",
  ]);
  assert.deepEqual(groups.featured.map((option) => option.id), [
    "thai-supernatural-horror",
    "thai-human-drama",
    "thai-history-period-storytelling",
  ]);
  assert.equal(groups.featured[0]?.role, "recommended");
  assert.equal(groups.featured[1]?.role, "alternative");
  assert.equal(groups.all.length, 8);
  assert.ok(groups.all.every((option) => /[\u0E00-\u0E7F]/u.test(option.label)));
  assert.equal(buildVisualSummary("คนสมจริง", "หนังผีไทย"), "คนสมจริง · หนังผีไทย");
  assert.equal(
    buildVisualSummary("ภาพสมจริงแบบหนัง", "หนังผีไทย"),
    "คนสมจริง · หนังผีไทย",
    "the existing long catalog label must collapse to the plain-language project summary",
  );
  assert.equal(buildVisualSummary("คนสมจริง", "anything", true), "คนสมจริง · ใช้แนวที่ตั้งไว้เดิม");

  const confirmation = lookChangeConfirmation(4, 2);
  assert.equal(confirmation.quotedCredits, 8);
  assert.deepEqual(confirmation.options.map((option) => option.id), ["regenerate-all"]);
  assert.doesNotMatch(JSON.stringify(confirmation), /new-only|เฉพาะภาพที่สร้างต่อจากนี้/);

  console.log("verify-brand-treatment-ui-v1: PASS Thai catalog, recommendation surface, all-or-cancel");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
