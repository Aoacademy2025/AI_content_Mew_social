import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNarrationPlan } from "../src/lib/narration-plan";
import { preprocessScript } from "../src/app/(dashboard)/video-editor/_lib/preprocess-script";

const withHiddenSeparator = "ช่วงแรก\nช่วงสอง\u200Bช่วงสาม";
const withLineBreak = "ช่วงแรก\nช่วงสอง\nช่วงสาม";

const hiddenPlan = compileNarrationPlan(withHiddenSeparator);
const linePlan = compileNarrationPlan(withLineBreak);

assert.equal(hiddenPlan.sourceText, withHiddenSeparator, "NarrationPlan must preserve the exact authored script");
assert.equal(linePlan.sourceText, withLineBreak, "NarrationPlan must preserve authored newlines");
assert.equal(hiddenPlan.speechText, "ช่วงแรก ช่วงสอง ช่วงสาม");
assert.equal(linePlan.speechText, hiddenPlan.speechText, "equivalent separators must compile to one provider text");
assert.equal(linePlan.displayText, hiddenPlan.displayText, "equivalent separators must compile to one caption text");
assert.equal(linePlan.segments.length, 3, "mapping remains compact by authored structural segment");

console.log("ok: NarrationPlan canonicalizes hidden and newline separators without mutating sourceText");

const punctuationPlan = compileNarrationPlan("เรื่องนี้.....\nสำคัญ!!! จริงเหรอ???");
assert.equal(punctuationPlan.speechText, "เรื่องนี้... สำคัญ! จริงเหรอ?");
assert.equal(punctuationPlan.displayText, punctuationPlan.speechText);
assert.equal(compileNarrationPlan("เว้น   ระยะ\tซ้ำ …").speechText, "เว้น ระยะ ซ้ำ ...");

const meaningfulSyntax = "ราคา (รวมภาษี) 100 บาท #โปร https://example.com";
const meaningfulPlan = compileNarrationPlan(meaningfulSyntax);
assert.equal(meaningfulPlan.sourceText, meaningfulSyntax);
assert.equal(meaningfulPlan.speechText, meaningfulSyntax, "deterministic preparation must not delete authored meaning");
assert.equal(preprocessScript(meaningfulSyntax), meaningfulPlan.speechText, "legacy Editor must use the same NarrationPlan contract");

console.log("ok: NarrationPlan normalizes repeated pause punctuation without deleting authored content");

const legacyEditorSource = readFileSync(
  new URL("../src/app/(dashboard)/video-editor/page.tsx", import.meta.url),
  "utf8",
);
assert.match(
  legacyEditorSource,
  /const narrationText = preprocessScript\(scriptOverride \|\| script\)/u,
  "legacy Editor must normalize manual TTS overrides before every provider call",
);
assert.doesNotMatch(
  legacyEditorSource,
  /scriptOverride\.trim\(\) \|\| preprocessScript\(script\)/u,
  "legacy Editor must not bypass NarrationPlan when a manual TTS override exists",
);

console.log("ok: legacy Editor routes manual overrides through the shared NarrationPlan");

async function verifyVideoJobPersistence() {
  const dir = mkdtempSync(join(tmpdir(), "narration-plan-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

  const { prisma } = await import("../src/lib/prisma");
  try {
    const { createVideoJob } = await import("../src/lib/mcp/video-job");
    const user = await prisma.user.create({
      data: {
        id: "narration-plan-user",
        email: "narration-plan@example.com",
        name: "Narration Plan",
        plan: "PRO",
      },
    });
    const job = await createVideoJob(user.id, {
      script: withHiddenSeparator,
      voiceProvider: "gemini",
    });
    const stored = JSON.parse(job.inputJson) as {
      script?: string;
      narrationPlan?: ReturnType<typeof compileNarrationPlan>;
    };
    assert.equal(stored.script, withHiddenSeparator, "VideoJob must preserve the authored script");
    assert.equal(stored.narrationPlan?.sourceText, withHiddenSeparator);
    assert.equal(stored.narrationPlan?.speechText, "ช่วงแรก ช่วงสอง ช่วงสาม");
    console.log("ok: VideoJob persists the compiled NarrationPlan beside the authored script");
  } finally {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await verifyVideoJobPersistence();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
