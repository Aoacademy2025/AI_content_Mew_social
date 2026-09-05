import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createBlankBrandProfileSeed,
  createBrandProfileSeedFromCurrentDefaults,
  currentBrandVoiceDefaults,
} from "../src/lib/brand-profile-seed";

const blank = createBlankBrandProfileSeed();
assert.deepEqual(blank.visual.palette, ["#2B2926", "#F5F1E8", "#A8A29E"]);
assert.equal(blank.visual.personality, "สมดุล ชัดเจน และปรับให้เข้ากับแบรนด์ได้");
assert.equal(
  "peopleAndSetting" in blank.visual,
  false,
  "a Brand controls rendering, never the scene: the blank seed no longer constructs peopleAndSetting (ADR 0006)",
);
assert.equal(
  "memorableCues" in blank.visual,
  false,
  "memorable visual cues are removed from V1: the blank seed no longer constructs them (ADR 0006)",
);
assert.equal(blank.visual.visualNotes, "");
assert.equal(blank.brandMark.enabled, false);
assert.equal(blank.voice.voiceId, null);
assert.ok(
  !JSON.stringify(blank).match(/Mewsocial|38BDF8|วงกลม|ลูกศร|กล้าตรง|ชาวไทย/i),
  "a blank profile must never inherit the Mewsocial differentiation benchmark",
);

const imported = createBrandProfileSeedFromCurrentDefaults({
  script: {
    styleId: "legacy-style",
    tone: "อบอุ่นและกระชับ",
    analysisNotes: "เปิดด้วยคำถาม",
    sampleText: "ตัวอย่างเดิม",
  },
  voice: { provider: "elevenlabs", voiceId: "voice-legacy" },
  subtitle: { presetId: "subtitle-legacy", config: { fontFamily: "Kanit" } },
  brandMark: {
    assetId: "asset-legacy",
    assetName: "legacy.png",
    enabled: true,
    position: "bottom-left",
    sizePct: 21,
    opacity: 0.75,
  },
});
assert.equal(imported.script.styleId, "legacy-style");
assert.equal(imported.script.tone, "อบอุ่นและกระชับ");
assert.equal(imported.voice.voiceId, "voice-legacy");
assert.equal(imported.subtitle.presetId, "subtitle-legacy");
assert.equal(imported.brandMark.assetId, "asset-legacy");
assert.equal(imported.brandMark.position, "bottom-left");
assert.deepEqual(
  imported.visual,
  blank.visual,
  "explicit legacy import seeds writing/voice/subtitle/mark only, never a guessed visual identity",
);

assert.deepEqual(
  currentBrandVoiceDefaults({
    ttsProvider: "omnivoice",
    elevenlabsVoiceId: "must-not-cross-provider-boundary",
    geminiVoiceName: "must-not-cross-provider-boundary",
  }),
  { provider: "omnivoice", voiceId: null },
  "an account without a persisted OmniVoice id must use its provider default instead of an ElevenLabs id",
);
assert.deepEqual(
  currentBrandVoiceDefaults({
    ttsProvider: "gemini",
    elevenlabsVoiceId: "eleven-id",
    geminiVoiceName: "Kore",
  }),
  { provider: "gemini", voiceId: "Kore" },
);

const componentsDirectory = "src/app/(dashboard)/brands/_components";
const componentFiles = readdirSync(componentsDirectory).sort();
const pageSource = [
  readFileSync("src/app/(dashboard)/brands/page.tsx", "utf8"),
  ...componentFiles.map((file) => readFileSync(join(componentsDirectory, file), "utf8")),
].join("\n");
assert.ok(pageSource.includes("สร้างแบรนด์จากค่าที่ใช้อยู่"));
assert.ok(pageSource.includes("createBrandSetupSeed"));
assert.ok(readFileSync("src/lib/brand-setup.ts", "utf8").includes("createBrandProfileSeedFromCurrentDefaults"));
assert.ok(
  !pageSource.match(/#38BDF8|วงกลมเน้นจุดสำคัญ|ลูกศรนำสายตา/),
  "the Brand Library page must not hard-code the gate-only Mewsocial brief",
);

// ── /brands runs on the app design system, not a hand-rolled one-off ────────
for (const banned of ["#eee9df", "#38BDF8", "shadow-[", "var(--font-kanit)"]) {
  assert.ok(
    !pageSource.includes(banned),
    `the Brand Library must use shadcn/ui + the violet accent, never ${banned}`,
  );
}
assert.ok(
  pageSource.includes('from "@/components/ui/button"')
    && pageSource.includes('from "@/components/ui/input"')
    && pageSource.includes('from "@/components/ui/card"'),
  "the Brand Library composes the shared shadcn primitives",
);

// ── The default surface asks two things: a name and a Visual Format ─────────
assert.ok(pageSource.includes("ชื่อแบรนด์") && pageSource.includes("เช่น Mew Social"));
assert.ok(
  pageSource.includes("แนวภาพประจำแบรนด์")
    && pageSource.includes("ทุกคลิปของแบรนด์นี้จะใช้แนวภาพเดียวกัน เปลี่ยนทีหลังได้"),
);
assert.ok(
  pageSource.includes("เลือกสไตล์ แล้วเริ่มคลิปแรก"),
  "the empty state leads with choosing a style and starting a clip",
);
assert.ok(
  pageSource.includes("ตั้งค่าเพิ่มเติม")
    && pageSource.includes("สี เสียง ซับ โลโก้ และรายละเอียดแบรนด์ — ไม่กรอกก็ได้")
    && pageSource.includes("useState(false)"),
  "everything beyond the two inputs sits inside a collapsed ตั้งค่าเพิ่มเติม section",
);
assert.ok(
  pageSource.includes("ระบบจะใช้สีเหล่านี้เป็นโทนของภาพ ไม่ใช่วาดเป็นวัตถุในภาพ"),
  "the palette helper states that brand colour grades the frame instead of appearing in it",
);
assert.match(
  pageSource,
  /const canPublish = payload\.name\.trim\(\)\.length > 0/,
  "the resolved default name allows zero typed fields",
);
assert.ok(
  pageSource.includes("draft.visual.personality.trim()")
    && pageSource.includes("draft.visual.defaultTreatment?.trim()"),
  "withSeedFallbacks() keeps a backward-compatible hidden defaultTreatment for old payloads while the catalog policy owns new choices",
);

// ── The two retired scene inputs are gone from the form ─────────────────────
const advancedSource = readFileSync(join(componentsDirectory, "AdvancedSettings.tsx"), "utf8");
const basicsSource = readFileSync(join(componentsDirectory, "BrandBasicsForm.tsx"), "utf8");
for (const source of [advancedSource, basicsSource]) {
  assert.ok(
    !source.includes("peopleAndSetting") && !source.includes("memorableCues"),
    "จุดจำทางภาพ and คนและสถานที่ are removed from the Brand form (ADR 0006)",
  );
}

console.log("verify-brand-profile-seed: PASS neutral blank + explicit legacy import + zero-typing setup surface");
